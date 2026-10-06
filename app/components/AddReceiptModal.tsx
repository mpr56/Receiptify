"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { Receipt, ProductCategory } from "@/types";
import { CATEGORIES } from "@/lib/data";
import { processReceiptImage } from "@/lib/imageProcessor";
import { PICKER_ACCEPT } from "@/lib/imageLimits";
import { scanReceipt, OCRResult } from "@/lib/ocr";
import { T, MONO, seg, fieldStyle, labelStyle, fmtMoney, fmtAmt, gstOf } from "./theme";
import { DashRule, DoubleRule, DotRow, MetaLine, PerfLine } from "./paper";
import { Camera, Upload, Trash2, AlertCircle, Sparkles } from "lucide-react";

interface Props {
  onAdd: (receipt: Receipt) => void;
  onClose: () => void;
}

interface ItemRow {
  name: string;
  quantity: number;
  unitPrice: number;
}

type Step = "photo" | "scanning" | "details";

/** Printed confidence mark, the OCR's own margin note next to a field. */
function ConfidenceBadge({ score }: { score: number }) {
  if (score <= 0) return null;
  const high = score >= 0.75;
  return (
    <span
      style={{
        fontFamily: MONO,
        fontSize: 9,
        fontWeight: 700,
        letterSpacing: "0.1em",
        color: high ? "oklch(38% 0.09 145)" : "oklch(40% 0.12 60)",
      }}
    >
      {high ? "[AUTO]" : "[CHECK]"}
    </span>
  );
}

/** A thermal-printer progress readout: `[████░░░░] 62%`. */
function BlockMeter({ pct }: { pct: number }) {
  const BLOCKS = 22;
  const filled = Math.max(0, Math.min(BLOCKS, Math.round((pct / 100) * BLOCKS)));
  return (
    <div
      role="progressbar"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label="Scan progress"
      style={{
        fontFamily: MONO,
        fontSize: 13,
        letterSpacing: "0.02em",
        color: T.ink,
        display: "flex",
        gap: 10,
        alignItems: "baseline",
        justifyContent: "center",
      }}
    >
      <span aria-hidden style={{ whiteSpace: "nowrap" }}>
        [{"█".repeat(filled)}
        <span style={{ color: T.line }}>{"░".repeat(BLOCKS - filled)}</span>]
      </span>
      <span style={{ fontVariantNumeric: "tabular-nums", color: T.soft, fontSize: 11 }}>
        {Math.round(pct)}%
      </span>
    </div>
  );
}

export default function AddReceiptModal({ onAdd, onClose }: Props) {
  const [step, setStep] = useState<Step>("photo");
  const [imageDataUrl, setImageDataUrl] = useState<string | undefined>();
  const [compressedKB, setCompressedKB] = useState<{ original: number; compressed: number } | null>(null);
  const [scanProgress, setScanProgress] = useState({ pct: 0, status: "" });
  const [scanError, setScanError] = useState<string | null>(null);
  const [ocr, setOcr] = useState<OCRResult | null>(null);

  const [storeName, setStoreName] = useState("");
  const [category, setCategory] = useState<ProductCategory>("Other");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [paymentMethod, setPaymentMethod] = useState<"card" | "cash" | "digital">("card");
  const [items, setItems] = useState<ItemRow[]>([{ name: "", quantity: 1, unitPrice: 0 }]);
  const [tagInput, setTagInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);

  // Escape closes, except mid-scan where there is a request in flight.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && step !== "scanning") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [step, onClose]);

  const handleImageFile = useCallback(async (file: File) => {
    setStep("scanning");
    setScanError(null);
    setScanProgress({ pct: 2, status: "Processing image…" });

    try {
      const processed = await processReceiptImage(file);
      setImageDataUrl(processed.dataUrl);
      setCompressedKB({ original: processed.originalSizeKB, compressed: processed.compressedSizeKB });
      setScanProgress({ pct: 8, status: "Image ready, scanning…" });

      const result = await scanReceipt(processed.dataUrl, (pct, status) =>
        setScanProgress({ pct, status })
      );

      setOcr(result);
      setStoreName(result.storeName);
      setCategory(result.category);
      if (result.date) setDate(result.date);
      setPaymentMethod(result.paymentMethod);
      if (result.items.length > 0) setItems(result.items);

      setStep("details");
    } catch (err) {
      console.error("Scan failed:", err);
      setScanError(err instanceof Error ? err.message : "Scan failed");
      setStep("details");
    }
  }, []);

  function updateItem(i: number, field: keyof ItemRow, value: string | number) {
    setItems((prev) => prev.map((it, idx) => (idx === i ? { ...it, [field]: value } : it)));
  }

  const total = items.reduce((sum, it) => sum + it.quantity * it.unitPrice, 0);
  const effectiveTotal = total || ocr?.totalAmount || 0;
  const { ex, gst } = gstOf(effectiveTotal);

  /**
   * Files the receipt with the server, which stores the image and the row and
   * hands back the saved record — including the id and image path it assigned.
   * The photo travels as a data URL and is uploaded to storage server-side; it
   * is never written into the receipt row.
   */
  async function handleSubmit() {
    if (!storeName.trim() || saving) return;
    setSaving(true);
    setSaveError(null);

    const payload = {
      storeName: storeName.trim(),
      category,
      date: new Date(`${date}T12:00:00`).toISOString(),
      totalAmount: total || (ocr?.totalAmount ?? 0),
      currency: "AUD",
      items: items
        .filter((i) => i.name.trim())
        .map((i) => ({
          name: i.name,
          quantity: i.quantity,
          unitPrice: i.unitPrice,
          totalPrice: parseFloat((i.quantity * i.unitPrice).toFixed(2)),
        })),
      paymentMethod,
      imageDataUrl,
      tags: tagInput
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
    };

    try {
      const res = await fetch("/api/receipts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? "Could not file the receipt");
      }
      const saved: Receipt = await res.json();
      onAdd(saved);
    } catch (err) {
      console.error("Failed to file receipt:", err);
      setSaveError(err instanceof Error ? err.message : "Could not file the receipt");
      setSaving(false);
    }
  }

  const heading =
    step === "photo" ? "New Entry" : step === "scanning" ? "Scanning" : ocr ? "Confirm Entry" : "Manual Entry";

  return (
    <div
      onClick={step !== "scanning" ? onClose : undefined}
      role="dialog"
      aria-modal="true"
      aria-label="Add a receipt"
      style={{
        position: "fixed",
        inset: 0,
        background: "oklch(20% 0.01 90 / 0.55)",
        backdropFilter: "blur(4px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        zIndex: 50,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="scrollbar-none paper"
        style={{
          width: 430,
          maxWidth: "100%",
          borderRadius: 0,
          padding: "24px 26px 22px",
          boxShadow: "10px 10px 0 rgba(20,20,30,0.16), 0 24px 60px rgba(20,20,30,0.28)",
          display: "flex",
          flexDirection: "column",
          maxHeight: "88vh",
          overflowY: "auto",
          boxSizing: "border-box",
          fontFamily: MONO,
          color: T.ink,
        }}
      >
        {/* -- Slip head ---------------------------------------------- */}
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
          <div>
            <h3
              style={{
                margin: 0,
                fontSize: 19,
                fontWeight: 800,
                letterSpacing: "0.1em",
                textTransform: "uppercase",
              }}
            >
              {heading}
            </h3>
            <div style={{ marginTop: 6 }}>
              <MetaLine size={9} color={T.faint}>
                RECEIPTLY POS · ENTRY SLIP · STEP {step === "photo" ? "1" : step === "scanning" ? "2" : "3"} OF 3
              </MetaLine>
            </div>
          </div>
          {step !== "scanning" && (
            <button
              onClick={onClose}
              aria-label="Close"
              className="paper-btn"
              style={{
                width: 30,
                height: 30,
                flexShrink: 0,
                borderRadius: 0,
                background: "transparent",
                borderWidth: 1,
                borderStyle: "solid",
                borderColor: T.line,
                cursor: "pointer",
                fontSize: 15,
                fontFamily: MONO,
                color: T.label,
              }}
            >
              ×
            </button>
          )}
        </div>

        <DashRule margin="16px 0" />

        {/* -- STEP: PHOTO -------------------------------------------- */}
        {step === "photo" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <MetaLine size={10} color={T.soft} align="center">
              PRESENT RECEIPT TO SCANNER
            </MetaLine>

            <input
              ref={cameraRef}
              type="file"
              accept={PICKER_ACCEPT}
              capture="environment"
              hidden
              onChange={(e) => e.target.files?.[0] && handleImageFile(e.target.files[0])}
            />
            <button
              onClick={() => cameraRef.current?.click()}
              className="paper-btn"
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 10,
                padding: "20px 0",
                minHeight: 60,
                borderRadius: 0,
                borderWidth: 1.5,
                borderStyle: "dashed",
                borderColor: T.ink,
                background: "transparent",
                color: T.ink,
                fontSize: 13,
                fontWeight: 700,
                letterSpacing: "0.14em",
                textTransform: "uppercase",
                fontFamily: MONO,
                cursor: "pointer",
              }}
            >
              <Camera size={17} aria-hidden />
              Capture
            </button>

            <input
              ref={fileRef}
              type="file"
              accept={PICKER_ACCEPT}
              hidden
              onChange={(e) => e.target.files?.[0] && handleImageFile(e.target.files[0])}
            />
            <button
              onClick={() => fileRef.current?.click()}
              className="paper-btn"
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 10,
                padding: "14px 0",
                minHeight: 48,
                borderRadius: 0,
                borderWidth: 1,
                borderStyle: "solid",
                borderColor: T.line,
                background: "transparent",
                color: T.label,
                fontSize: 12,
                letterSpacing: "0.12em",
                textTransform: "uppercase",
                fontFamily: MONO,
                cursor: "pointer",
              }}
            >
              <Upload size={15} aria-hidden />
              Upload From Library
            </button>

            <PerfLine margin="6px 0" label="OR" />

            <button
              onClick={() => setStep("details")}
              style={{
                border: "none",
                background: "none",
                color: T.soft,
                fontSize: 11,
                letterSpacing: "0.12em",
                textTransform: "uppercase",
                fontFamily: MONO,
                cursor: "pointer",
                padding: "10px 0",
                minHeight: 44,
              }}
            >
              Key In Manually →
            </button>
          </div>
        )}

        {/* -- STEP: SCANNING ----------------------------------------- */}
        {step === "scanning" && (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 20,
              padding: "18px 0",
            }}
          >
            {imageDataUrl && (
              <div
                style={{
                  position: "relative",
                  width: 112,
                  height: 176,
                  overflow: "hidden",
                  borderWidth: 1,
                  borderStyle: "solid",
                  borderColor: T.line,
                  flexShrink: 0,
                }}
              >
                <img
                  src={imageDataUrl}
                  alt="The receipt currently being scanned"
                  style={{ width: "100%", height: "100%", objectFit: "cover" }}
                />
                <div
                  aria-hidden
                  style={{
                    position: "absolute",
                    left: 0,
                    right: 0,
                    height: 2,
                    top: `${scanProgress.pct}%`,
                    background: `linear-gradient(90deg, transparent, ${T.accent}, transparent)`,
                    boxShadow: `0 0 8px ${T.accent}`,
                    transition: "top 0.4s ease",
                  }}
                />
              </div>
            )}

            <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: 10 }}>
              <BlockMeter pct={scanProgress.pct} />
              <MetaLine size={9} color={T.faint} align="center">
                {scanProgress.status}
              </MetaLine>
            </div>

            <DashRule margin="2px 0" />

            <MetaLine size={9} color={T.soft} align="center">
              <Sparkles size={9} aria-hidden style={{ display: "inline", verticalAlign: "middle", marginRight: 5 }} />
              READING VIA QWEN 3.8 VISION · DO NOT REMOVE PAPER
            </MetaLine>
          </div>
        )}

        {/* -- STEP: DETAILS ------------------------------------------ */}
        {step === "details" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {scanError && (
              <div
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 8,
                  padding: "10px 12px",
                  borderWidth: 1,
                  borderStyle: "solid",
                  borderColor: "oklch(60% 0.14 25)",
                  color: "oklch(40% 0.12 25)",
                  fontSize: 11,
                  lineHeight: 1.6,
                  letterSpacing: "0.04em",
                }}
              >
                <AlertCircle size={13} aria-hidden style={{ flexShrink: 0, marginTop: 2 }} />
                <span>SCAN FAILED. KEY THE DETAILS IN BY HAND. ({scanError})</span>
              </div>
            )}

            {ocr && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 10,
                  padding: "9px 11px",
                  borderWidth: 1,
                  borderStyle: "solid",
                  borderColor: T.accent,
                  color: T.accent,
                  fontSize: 9,
                  letterSpacing: "0.12em",
                  textTransform: "uppercase",
                }}
              >
                <span style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 700 }}>
                  <Sparkles size={11} aria-hidden />
                  Auto-Scanned
                </span>
                {compressedKB && (
                  <span style={{ color: T.soft }}>
                    {compressedKB.original}KB → {compressedKB.compressed}KB
                  </span>
                )}
              </div>
            )}

            {imageDataUrl && (
              <div style={{ position: "relative" }}>
                <img
                  src={imageDataUrl}
                  alt="The scanned receipt attached to this entry"
                  style={{
                    width: "100%",
                    maxHeight: 140,
                    objectFit: "cover",
                    filter: "grayscale(0.3) contrast(1.05)",
                    borderWidth: 1,
                    borderStyle: "solid",
                    borderColor: T.line,
                  }}
                />
                <button
                  onClick={() => setImageDataUrl(undefined)}
                  aria-label="Remove photo"
                  style={{
                    position: "absolute",
                    top: 8,
                    right: 8,
                    width: 30,
                    height: 30,
                    display: "grid",
                    placeItems: "center",
                    borderRadius: 0,
                    background: T.paper,
                    borderWidth: 1,
                    borderStyle: "solid",
                    borderColor: T.ink,
                    cursor: "pointer",
                  }}
                >
                  <Trash2 size={13} aria-hidden style={{ color: T.muted }} />
                </button>
              </div>
            )}

            <div>
              <label htmlFor="store" style={{ ...labelStyle, display: "flex", alignItems: "center", gap: 8 }}>
                Merchant
                {ocr && <ConfidenceBadge score={ocr.confidence.storeName} />}
              </label>
              <input
                id="store"
                type="text"
                value={storeName}
                onChange={(e) => setStoreName(e.target.value)}
                placeholder="E.G. WOOLWORTHS"
                style={fieldStyle}
              />
            </div>

            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <div style={{ flex: "1 1 150px" }}>
                <label htmlFor="dept" style={labelStyle}>
                  Department
                </label>
                <select
                  id="dept"
                  value={category}
                  onChange={(e) => setCategory(e.target.value as ProductCategory)}
                  style={fieldStyle}
                >
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
              <div style={{ flex: "1 1 150px" }}>
                <label htmlFor="date" style={{ ...labelStyle, display: "flex", alignItems: "center", gap: 8 }}>
                  Date
                  {ocr && <ConfidenceBadge score={ocr.confidence.date} />}
                </label>
                <input
                  id="date"
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  style={fieldStyle}
                />
              </div>
            </div>

            <div>
              <span style={labelStyle}>Tender</span>
              <div style={{ display: "flex", gap: 8 }}>
                {(["card", "digital", "cash"] as const).map((pm) => (
                  <button
                    key={pm}
                    onClick={() => setPaymentMethod(pm)}
                    aria-pressed={paymentMethod === pm}
                    style={{ ...seg(paymentMethod === pm), minHeight: 40 }}
                  >
                    {pm}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <span style={{ ...labelStyle, display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                Line Items
                {ocr && <ConfidenceBadge score={ocr.confidence.items} />}
              </span>

              {/* Column heads mirror the printed receipt so the form and its
                  output read as the same document. */}
              <div
                style={{
                  display: "flex",
                  gap: 8,
                  fontSize: 9,
                  letterSpacing: "0.14em",
                  color: T.faint,
                  marginBottom: 6,
                }}
              >
                <span style={{ flex: 1 }}>ITEM</span>
                <span style={{ width: 54, textAlign: "center" }}>QTY</span>
                <span style={{ width: 78, textAlign: "right" }}>UNIT</span>
                {items.length > 1 && <span style={{ width: 32 }} />}
              </div>

              {items.map((it, i) => (
                <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
                  <input
                    type="text"
                    value={it.name}
                    onChange={(e) => updateItem(i, "name", e.target.value)}
                    placeholder={`ITEM ${String(i + 1).padStart(2, "0")}`}
                    aria-label={`Item ${i + 1} name`}
                    style={{ ...fieldStyle, flex: 1, minWidth: 0 }}
                  />
                  <input
                    type="number"
                    min={1}
                    value={it.quantity}
                    onChange={(e) => updateItem(i, "quantity", parseInt(e.target.value) || 1)}
                    aria-label={`Item ${i + 1} quantity`}
                    style={{ ...fieldStyle, width: 54, textAlign: "center" }}
                  />
                  <input
                    type="number"
                    step="0.01"
                    min={0}
                    value={it.unitPrice || ""}
                    onChange={(e) => updateItem(i, "unitPrice", parseFloat(e.target.value) || 0)}
                    placeholder="0.00"
                    aria-label={`Item ${i + 1} unit price`}
                    style={{ ...fieldStyle, width: 78, textAlign: "right" }}
                  />
                  {items.length > 1 && (
                    <button
                      onClick={() => setItems(items.filter((_, idx) => idx !== i))}
                      aria-label={`Remove item ${i + 1}`}
                      className="paper-btn"
                      style={{
                        width: 32,
                        height: 34,
                        flexShrink: 0,
                        borderRadius: 0,
                        borderWidth: 1,
                        borderStyle: "solid",
                        borderColor: T.line,
                        background: "transparent",
                        cursor: "pointer",
                        color: T.soft,
                        fontFamily: MONO,
                      }}
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}

              <button
                onClick={() => setItems([...items, { name: "", quantity: 1, unitPrice: 0 }])}
                style={{
                  border: "none",
                  background: "none",
                  color: T.accent,
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: "0.12em",
                  textTransform: "uppercase",
                  cursor: "pointer",
                  padding: "8px 0",
                  minHeight: 40,
                  fontFamily: MONO,
                }}
              >
                + Add Line
              </button>
            </div>

            {/* Live totals, printed exactly as they will appear on the receipt. */}
            <div>
              <DashRule margin="0 0 8px" />
              <DotRow label="SUBTOTAL (EX GST)" value={fmtAmt(ex)} size={11} color={T.muted} />
              <DotRow label="GST 10%" value={fmtAmt(gst)} size={11} color={T.muted} />
              <DoubleRule margin="8px 0" />
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "baseline",
                  fontSize: 16,
                  fontWeight: 800,
                  letterSpacing: "0.08em",
                }}
              >
                <span>TOTAL</span>
                <span style={{ fontVariantNumeric: "tabular-nums" }}>{fmtMoney(effectiveTotal)}</span>
              </div>
            </div>

            <div>
              <label htmlFor="tags" style={labelStyle}>
                Tags (optional)
              </label>
              <input
                id="tags"
                type="text"
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                placeholder="WEEKLY-SHOP, REIMBURSABLE"
                style={fieldStyle}
              />
            </div>

            <PerfLine margin="2px 0 6px" />

            <div style={{ display: "flex", gap: 10 }}>
              <button
                onClick={onClose}
                className="paper-btn"
                style={{
                  flex: "0 0 auto",
                  borderWidth: 1,
                  borderStyle: "solid",
                  borderColor: T.line,
                  background: "transparent",
                  borderRadius: 0,
                  padding: "13px 18px",
                  minHeight: 46,
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: "0.12em",
                  textTransform: "uppercase",
                  cursor: "pointer",
                  color: T.label,
                  fontFamily: MONO,
                }}
              >
                Exit
              </button>
              <button
                onClick={handleSubmit}
                disabled={!storeName.trim() || saving}
                className="paper-btn paper-btn-accent"
                style={{
                  flex: 1,
                  borderWidth: 1.5,
                  borderStyle: "solid",
                  borderColor: storeName.trim() ? T.accent : T.line,
                  background: "transparent",
                  color: storeName.trim() ? T.accent : T.faint,
                  borderRadius: 0,
                  padding: "13px 18px",
                  minHeight: 46,
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: "0.14em",
                  textTransform: "uppercase",
                  cursor: saving ? "wait" : storeName.trim() ? "pointer" : "not-allowed",
                  fontFamily: MONO,
                  opacity: saving ? 0.6 : 1,
                }}
              >
                {saving ? "Filing…" : "Print Receipt"}
              </button>
            </div>

            {saveError && (
              <div role="alert">
                <MetaLine size={9} color="oklch(45% 0.15 25)" align="center">
                  {saveError}
                </MetaLine>
              </div>
            )}

            {!storeName.trim() && (
              <MetaLine size={9} color={T.faint} align="center">
                MERCHANT REQUIRED TO PRINT
              </MetaLine>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

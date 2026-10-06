/**
 * Bounds on what the vision model is allowed to hand back.
 *
 * The model reads an image supplied by whoever is holding the phone, and text
 * inside that image can steer it. No prompt wording prevents that, so the model
 * output is treated the same way any other untrusted input is: parsed against a
 * schema, clamped to sane ranges, and never trusted for its size or shape.
 *
 * This runs server-side, before the scan response is returned, so an unbounded
 * payload never reaches the browser or the database.
 */

export const MAX_STORE_NAME_CHARS = 120;
export const MAX_ITEM_NAME_CHARS = 100;
export const MAX_ITEMS = 100;
export const MAX_RECEIPT_AMOUNT = 1_000_000;
export const MAX_ITEM_QUANTITY = 10_000;

const PAYMENT_METHODS = ["card", "cash", "digital"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export interface ScannedItem {
  name: string;
  quantity: number;
  unitPrice: number;
}

export interface ScannedReceipt {
  storeName: string;
  date: string;
  time: string;
  totalAmount: number;
  paymentMethod: PaymentMethod;
  items: ScannedItem[];
  confidence: { storeName: number; date: number; total: number; items: number };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

/**
 * Trims a model-supplied string to a printable single line within `max`.
 * Newlines and control characters are collapsed rather than preserved: a store
 * name is one line on a receipt, and multi-line output is a sign the model was
 * steered rather than reading.
 */
export function cleanString(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u001F\u007F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** A money value the ledger can hold: finite, non-negative, two decimals. */
export function cleanAmount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return round2(clamp(value, 0, MAX_RECEIPT_AMOUNT));
}

function cleanConfidence(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return clamp(value, 0, 1);
}

function cleanItems(value: unknown): ScannedItem[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .slice(0, MAX_ITEMS)
    .map((item) => {
      const quantity =
        typeof item.quantity === "number" && Number.isFinite(item.quantity)
          ? clamp(Math.round(item.quantity), 1, MAX_ITEM_QUANTITY)
          : 1;
      return {
        name: cleanString(item.name, MAX_ITEM_NAME_CHARS),
        quantity,
        unitPrice: cleanAmount(item.unitPrice),
      };
    })
    .filter((item) => item.name);
}

/**
 * Normalises a raw model response into a receipt the rest of the app can hold.
 * Never throws and never returns a field outside its documented range — a
 * hostile or nonsensical response degrades to empty values, not an error.
 */
export function parseOcrResult(raw: unknown): ScannedReceipt {
  const r: Record<string, unknown> =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};

  const date = typeof r.date === "string" && ISO_DATE.test(r.date) && !Number.isNaN(Date.parse(r.date))
    ? r.date
    : "";

  const confidence = (
    typeof r.confidence === "object" && r.confidence !== null
      ? (r.confidence as Record<string, unknown>)
      : {}
  );

  return {
    storeName: cleanString(r.storeName, MAX_STORE_NAME_CHARS),
    date,
    time: typeof r.time === "string" && CLOCK_TIME.test(r.time) ? r.time : "",
    totalAmount: cleanAmount(r.totalAmount),
    paymentMethod: PAYMENT_METHODS.includes(r.paymentMethod as PaymentMethod)
      ? (r.paymentMethod as PaymentMethod)
      : "card",
    items: cleanItems(r.items),
    confidence: {
      storeName: cleanConfidence(confidence.storeName),
      date: cleanConfidence(confidence.date),
      total: cleanConfidence(confidence.total),
      items: cleanConfidence(confidence.items),
    },
  };
}

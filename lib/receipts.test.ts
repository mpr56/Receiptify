import { describe, expect, test } from "vitest";
import { MAX_ITEMS, MAX_ITEM_NAME_CHARS, MAX_RECEIPT_AMOUNT, MAX_STORE_NAME_CHARS } from "./ocrSchema";
import { MAX_NOTES_CHARS, MAX_TAGS, MAX_TAG_CHARS, parseNewReceipt } from "./receipts";

const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const JPEG_DATA_URL = `data:image/jpeg;base64,${JPEG_BYTES.toString("base64")}`;

const VALID = {
  storeName: "Alex & Co",
  category: "Food & Dining",
  date: "2026-03-14T12:00:00.000Z",
  totalAmount: 24.5,
  currency: "AUD",
  paymentMethod: "card",
  items: [{ name: "Flat White", quantity: 2, unitPrice: 5.25, totalPrice: 10.5 }],
  tags: ["weekly-shop"],
};

/** Unwraps a success result, failing the test if the body was rejected. */
function ok(body: unknown) {
  const result = parseNewReceipt(body);
  if ("error" in result) throw new Error(`expected success, got: ${result.error}`);
  return result.input;
}

describe("parseNewReceipt", () => {
  test("accepts a well-formed receipt", () => {
    const input = ok(VALID);

    expect(input.storeName).toBe("Alex & Co");
    expect(input.totalAmount).toBe(24.5);
    expect(input.items).toHaveLength(1);
  });

  test("truncates a store name past the cap", () => {
    expect(ok({ ...VALID, storeName: "A".repeat(5000) }).storeName).toHaveLength(
      MAX_STORE_NAME_CHARS
    );
  });

  test("clamps a total above the maximum", () => {
    expect(ok({ ...VALID, totalAmount: 1e12 }).totalAmount).toBe(MAX_RECEIPT_AMOUNT);
  });

  test("caps the number of line items", () => {
    const items = Array.from({ length: 4000 }, (_, i) => ({
      name: `Item ${i}`,
      quantity: 1,
      unitPrice: 1,
      totalPrice: 1,
    }));

    expect(ok({ ...VALID, items }).items).toHaveLength(MAX_ITEMS);
  });

  test("truncates an overlong item name", () => {
    const items = [{ name: "B".repeat(4000), quantity: 1, unitPrice: 1, totalPrice: 1 }];

    expect(ok({ ...VALID, items }).items[0].name).toHaveLength(MAX_ITEM_NAME_CHARS);
  });

  test("clamps an item total price above the maximum", () => {
    const items = [{ name: "Gold Bar", quantity: 1, unitPrice: 1, totalPrice: 1e308 }];

    expect(ok({ ...VALID, items }).items[0].totalPrice).toBe(MAX_RECEIPT_AMOUNT);
  });

  test("caps the number of tags and their length", () => {
    const tags = Array.from({ length: 500 }, (_, i) => `tag-${i}`.repeat(50));
    const input = ok({ ...VALID, tags });

    expect(input.tags).toHaveLength(MAX_TAGS);
    expect(input.tags.every((t) => t.length <= MAX_TAG_CHARS)).toBe(true);
  });

  test("truncates overlong notes", () => {
    expect(ok({ ...VALID, notes: "N".repeat(50_000) }).notes).toHaveLength(MAX_NOTES_CHARS);
  });

  test("falls back to AUD for a currency that is not a three-letter code", () => {
    expect(ok({ ...VALID, currency: "A".repeat(9000) }).currency).toBe("AUD");
    expect(ok({ ...VALID, currency: "usd" }).currency).toBe("USD");
  });

  test("accepts a valid receipt image and exposes its decoded bytes", () => {
    const input = ok({ ...VALID, imageDataUrl: JPEG_DATA_URL });

    expect(input.image).toEqual({ contentType: "image/jpeg", bytes: JPEG_BYTES });
  });

  test("rejects a payload whose bytes are not the image type it claims", () => {
    const html = Buffer.from("<html><script>alert(1)</script></html>", "ascii");
    const result = parseNewReceipt({
      ...VALID,
      imageDataUrl: `data:image/jpeg;base64,${html.toString("base64")}`,
    });

    expect(result).toEqual({ error: "File content does not match its image type" });
  });

  test("rejects a non-image mime type", () => {
    const pdf = Buffer.from("%PDF-1.7", "ascii");
    const result = parseNewReceipt({
      ...VALID,
      imageDataUrl: `data:application/pdf;base64,${pdf.toString("base64")}`,
    });

    expect(result).toEqual({ error: "Unsupported image type" });
  });

  test("leaves the image unset when none was supplied", () => {
    expect(ok(VALID).image).toBeUndefined();
  });

  test("still requires a store name and a parseable date", () => {
    expect(parseNewReceipt({ ...VALID, storeName: "   " })).toEqual({
      error: "storeName is required",
    });
    expect(parseNewReceipt({ ...VALID, date: "nonsense" })).toEqual({
      error: "date must be an ISO date string",
    });
  });
});

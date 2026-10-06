import { describe, expect, test } from "vitest";
import { MAX_IMAGE_BYTES, parseImageDataUrl } from "./imageValidation";

/** Builds a data URL from raw bytes, the way a browser would. */
function dataUrl(mime: string, bytes: Buffer): string {
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const WEBP = Buffer.concat([
  Buffer.from("RIFF", "ascii"),
  Buffer.from([0x24, 0x00, 0x00, 0x00]),
  Buffer.from("WEBP", "ascii"),
  Buffer.from("VP8 ", "ascii"),
]);

describe("parseImageDataUrl", () => {
  test("accepts a JPEG data URL and returns its bytes", () => {
    const result = parseImageDataUrl(dataUrl("image/jpeg", JPEG));

    expect(result).toEqual({ contentType: "image/jpeg", bytes: JPEG });
  });

  test("accepts a PNG data URL", () => {
    const result = parseImageDataUrl(dataUrl("image/png", PNG));

    expect(result).toEqual({ contentType: "image/png", bytes: PNG });
  });

  test("accepts a WebP data URL", () => {
    const result = parseImageDataUrl(dataUrl("image/webp", WEBP));

    expect(result).toEqual({ contentType: "image/webp", bytes: WEBP });
  });

  test("rejects a mime type outside the allowlist", () => {
    const pdf = Buffer.from("%PDF-1.7", "ascii");

    expect(parseImageDataUrl(dataUrl("application/pdf", pdf))).toEqual({
      error: "Unsupported image type",
    });
  });

  test("rejects an SVG, which is a scriptable image format", () => {
    const svg = Buffer.from("<svg onload=\"alert(1)\"></svg>", "ascii");

    expect(parseImageDataUrl(dataUrl("image/svg+xml", svg))).toEqual({
      error: "Unsupported image type",
    });
  });

  test("rejects HTML bytes wearing an image/jpeg label", () => {
    const html = Buffer.from("<html><script>alert(1)</script></html>", "ascii");

    expect(parseImageDataUrl(dataUrl("image/jpeg", html))).toEqual({
      error: "File content does not match its image type",
    });
  });

  test("rejects a PNG payload declared as image/jpeg", () => {
    expect(parseImageDataUrl(dataUrl("image/jpeg", PNG))).toEqual({
      error: "File content does not match its image type",
    });
  });

  test("rejects an image larger than the size cap", () => {
    const huge = Buffer.concat([JPEG, Buffer.alloc(MAX_IMAGE_BYTES, 0x41)]);

    expect(parseImageDataUrl(dataUrl("image/jpeg", huge))).toEqual({
      error: "Image is too large",
    });
  });

  test("accepts an image exactly at the size cap", () => {
    const exact = Buffer.concat([JPEG, Buffer.alloc(MAX_IMAGE_BYTES - JPEG.length, 0x41)]);
    const result = parseImageDataUrl(dataUrl("image/jpeg", exact));

    expect(result).toEqual({ contentType: "image/jpeg", bytes: exact });
  });

  test("rejects a string that is not a data URL", () => {
    expect(parseImageDataUrl("https://example.com/receipt.jpg")).toEqual({
      error: "Unsupported image type",
    });
  });

  test("rejects a data URL with an empty payload", () => {
    expect(parseImageDataUrl("data:image/jpeg;base64,")).toEqual({
      error: "Unsupported image type",
    });
  });

  test("rejects a payload too short to identify", () => {
    expect(parseImageDataUrl(dataUrl("image/jpeg", Buffer.from([0xff, 0xd8])))).toEqual({
      error: "File content does not match its image type",
    });
  });

  test("rejects non-string input", () => {
    expect(parseImageDataUrl(undefined)).toEqual({ error: "No image provided" });
    expect(parseImageDataUrl(null)).toEqual({ error: "No image provided" });
    expect(parseImageDataUrl({ dataUrl: "data:image/jpeg;base64,abc" })).toEqual({
      error: "No image provided",
    });
  });

  test("rejects an oversized string without decoding it", () => {
    // Well past the cap: the guard must fire on string length, before base64
    // decoding allocates a buffer this size.
    const oversized = "data:image/jpeg;base64," + "A".repeat(MAX_IMAGE_BYTES * 2);

    expect(parseImageDataUrl(oversized)).toEqual({ error: "Image is too large" });
  });
});

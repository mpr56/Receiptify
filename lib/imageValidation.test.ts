import { describe, expect, test } from "vitest";
import { MAX_IMAGE_BYTES, parseImageDataUrl, readImageDimensions } from "./imageValidation";
import { MAX_IMAGE_SIDE } from "./imageLimits";
import { jpegOfSize, pngOfSize, RECEIPT_SIZE, webpOfSize } from "./__fixtures__/images";

/** Builds a data URL from raw bytes, the way a browser would. */
function dataUrl(mime: string, bytes: Buffer): string {
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

const JPEG = jpegOfSize(RECEIPT_SIZE.width, RECEIPT_SIZE.height);
const PNG = pngOfSize(RECEIPT_SIZE.width, RECEIPT_SIZE.height);
const WEBP = webpOfSize(RECEIPT_SIZE.width, RECEIPT_SIZE.height);

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

    if ("error" in result) throw new Error(result.error);
    expect(result.contentType).toBe("image/jpeg");
    // Not toEqual: it walks all 5 MiB element by element, which takes seconds
    // and times out on CI runners. Buffer.equals is a single memcmp.
    expect(result.bytes.equals(exact)).toBe(true);
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

  test("rejects an image too small to read", () => {
    const result = parseImageDataUrl(dataUrl("image/png", pngOfSize(150, 300)));

    expect(result).toEqual({
      error: "That image is too small to read (150×300px). Use a photo at least 200×400px.",
    });
  });

  test("rejects an image larger than the dimension cap", () => {
    const result = parseImageDataUrl(dataUrl("image/jpeg", jpegOfSize(1000, MAX_IMAGE_SIDE + 1)));

    expect(result).toEqual({
      error: `That image is too large (1000×${MAX_IMAGE_SIDE + 1}px). Try a smaller photo.`,
    });
  });

  test("rejects an image whose header holds no dimensions", () => {
    // Valid JPEG magic, but straight into scan data with no frame header.
    const headless = Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x08, 0, 0, 0, 0, 0, 0]);

    expect(parseImageDataUrl(dataUrl("image/jpeg", headless))).toEqual({
      error: "Could not read the image dimensions.",
    });
  });
});

describe("readImageDimensions", () => {
  test("reads a JPEG frame header after other segments", () => {
    // An APP0 segment first, as real cameras write, then the frame.
    const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]);
    const jpeg = jpegOfSize(640, 1500);
    const withApp0 = Buffer.concat([jpeg.subarray(0, 2), app0, jpeg.subarray(2)]);

    expect(readImageDimensions(withApp0, "image/jpeg")).toEqual({ width: 640, height: 1500 });
  });

  test("reads PNG and extended WebP headers", () => {
    expect(readImageDimensions(pngOfSize(300, 900), "image/png")).toEqual({ width: 300, height: 900 });
    expect(readImageDimensions(webpOfSize(300, 900), "image/webp")).toEqual({ width: 300, height: 900 });
  });

  test("reads lossy and lossless WebP headers", () => {
    const lossy = Buffer.alloc(30);
    lossy.write("RIFF", 0, "ascii");
    lossy.write("WEBP", 8, "ascii");
    lossy.write("VP8 ", 12, "ascii");
    lossy.set([0x9d, 0x01, 0x2a], 23);
    lossy.writeUInt16LE(321, 26);
    lossy.writeUInt16LE(654, 28);
    expect(readImageDimensions(lossy, "image/webp")).toEqual({ width: 321, height: 654 });

    const lossless = Buffer.alloc(30);
    lossless.write("RIFF", 0, "ascii");
    lossless.write("WEBP", 8, "ascii");
    lossless.write("VP8L", 12, "ascii");
    lossless[20] = 0x2f;
    lossless.writeUInt32LE((321 - 1) | ((654 - 1) << 14), 21);
    expect(readImageDimensions(lossless, "image/webp")).toEqual({ width: 321, height: 654 });
  });

  test("returns null for a truncated header", () => {
    expect(readImageDimensions(pngOfSize(300, 900).subarray(0, 20), "image/png")).toBeNull();
    expect(readImageDimensions(jpegOfSize(300, 900).subarray(0, 8), "image/jpeg")).toBeNull();
  });
});

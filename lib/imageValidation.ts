/**
 * The one place image uploads are validated.
 *
 * Both upload paths — the OCR scan and the storage write — call through here,
 * so the rules cannot drift apart between them. Nothing downstream should
 * re-derive a content type from a caller-supplied string.
 */

import {
  ALLOWED_IMAGE_TYPES,
  checkImageDimensions,
  MAX_IMAGE_BYTES,
  type AllowedImageType,
} from "@/lib/imageLimits";

export { ALLOWED_IMAGE_TYPES, MAX_IMAGE_BYTES };
export type { AllowedImageType };

/**
 * Base64 costs 4 characters per 3 bytes. Capping the string first means an
 * oversized payload is rejected before `Buffer.from` allocates it.
 */
const MAX_DATA_URL_CHARS = Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 64;

/**
 * Only the three raster types are allowed. SVG is deliberately absent: it is a
 * scriptable document, not an image, and neither the OCR nor the storage bucket
 * has any use for one.
 */
const DATA_URL = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/;

export interface ValidatedImage {
  bytes: Buffer;
  contentType: AllowedImageType;
}

/**
 * Identifies an image by its leading bytes. A declared content type is just a
 * caller's claim; this is what the bytes actually are.
 */
function sniffImageType(bytes: Buffer): AllowedImageType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }

  const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= PNG_MAGIC.length && PNG_MAGIC.every((b, i) => bytes[i] === b)) {
    return "image/png";
  }

  // WebP is a RIFF container: "RIFF" <4-byte length> "WEBP".
  if (
    bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }

  return null;
}

/**
 * Reads pixel dimensions from an image header without decoding it. Returns
 * null when the header is missing or malformed, which the caller treats as a
 * rejection: a file whose size cannot be read is not one worth scanning.
 */
export function readImageDimensions(
  bytes: Buffer,
  type: AllowedImageType
): { width: number; height: number } | null {
  if (type === "image/png") {
    // The IHDR chunk always comes first: width and height at bytes 16 and 20.
    if (bytes.length < 24 || bytes.toString("ascii", 12, 16) !== "IHDR") return null;
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }

  if (type === "image/webp") {
    if (bytes.length < 30) return null;
    const chunk = bytes.toString("ascii", 12, 16);
    if (chunk === "VP8X") {
      // Extended format: 24-bit little-endian (width - 1) and (height - 1).
      return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 };
    }
    if (chunk === "VP8 ") {
      // Lossy: a keyframe start code, then 14-bit width and height.
      if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
      return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
    }
    if (chunk === "VP8L") {
      // Lossless: a 0x2f signature, then 14-bit (width - 1) and (height - 1) packed.
      if (bytes[20] !== 0x2f) return null;
      const bits = bytes.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    return null;
  }

  // JPEG: walk the marker segments until a start-of-frame, which holds the size.
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1];
    if (marker === 0xff) {
      offset += 1; // fill byte
      continue;
    }
    // Standalone markers carry no length field.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      offset += 2;
      continue;
    }
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2) return null;
    // SOF0–SOF15, except DHT (C4), JPG (C8) and DAC (CC), which share the range.
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      if (offset + 9 > bytes.length) return null;
      return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) };
    }
    // Image data starts at SOS; a frame header after that would be malformed.
    if (marker === 0xda || marker === 0xd9) return null;
    offset += 2 + length;
  }
  return null;
}

/**
 * Turns an untrusted data URL into bytes, or into a reason to refuse it. The
 * reasons are safe to hand back to the caller — they describe the input, never
 * anything about the server.
 */
export function parseImageDataUrl(dataUrl: unknown): ValidatedImage | { error: string } {
  if (typeof dataUrl !== "string" || dataUrl.length === 0) {
    return { error: "No image provided" };
  }

  if (dataUrl.length > MAX_DATA_URL_CHARS) {
    return { error: "Image is too large" };
  }

  const match = dataUrl.match(DATA_URL);
  if (!match) return { error: "Unsupported image type" };

  const contentType = match[1] as AllowedImageType;
  const bytes = Buffer.from(match[2], "base64");

  if (bytes.length > MAX_IMAGE_BYTES) return { error: "Image is too large" };

  // The declared type has to survive contact with the actual bytes. This is
  // what keeps an HTML or PDF payload from being stored under an image label.
  if (sniffImageType(bytes) !== contentType) {
    return { error: "File content does not match its image type" };
  }

  // Read from the header, not trusted from the caller, and checked against the
  // same bounds the browser applies before it uploads.
  const dimensions = readImageDimensions(bytes, contentType);
  if (!dimensions) return { error: "Could not read the image dimensions." };
  const sizeRejection = checkImageDimensions(dimensions.width, dimensions.height);
  if (sizeRejection) return { error: sizeRejection };

  return { bytes, contentType };
}

/**
 * The one place image uploads are validated.
 *
 * Both upload paths — the OCR scan and the storage write — call through here,
 * so the rules cannot drift apart between them. Nothing downstream should
 * re-derive a content type from a caller-supplied string.
 */

import { ALLOWED_IMAGE_TYPES, MAX_IMAGE_BYTES, type AllowedImageType } from "@/lib/imageLimits";

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

  return { bytes, contentType };
}

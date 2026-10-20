/**
 * Image limits shared by the browser and the server.
 *
 * Kept free of Node and DOM APIs so both sides import the same numbers and the
 * two checks cannot drift apart. The browser check is a courtesy — it turns a
 * doomed upload into an instant, readable message — and the server repeats it
 * in lib/imageValidation.ts, which is where the decision actually counts.
 */

/**
 * What may be uploaded. The browser always re-encodes to JPEG before sending,
 * so this is also what the server will accept.
 */
export const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type AllowedImageType = (typeof ALLOWED_IMAGE_TYPES)[number];

/**
 * What the file picker may hand us. Wider than the upload list because the
 * canvas step converts to JPEG on the way out: HEIC and HEIF are what an iPhone
 * camera produces by default, and refusing them would break capture on iOS
 * without making anything safer, since the server still only ever sees JPEG.
 */
export const ALLOWED_PICKER_TYPES = [
  ...ALLOWED_IMAGE_TYPES,
  "image/heic",
  "image/heif",
] as const;

/** 5MB of decoded image, after the browser has compressed it. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** 15MB for the file as picked, before compression. Covers a modern phone photo. */
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

/**
 * Pixel bounds. A receipt is a narrow strip of small print, so the floor is
 * about legibility: below 200px across or 400px long, line items blur into
 * each other and the scan would only spend quota to return guesses.
 */
export const MIN_IMAGE_SHORT_SIDE = 200;
export const MIN_IMAGE_LONG_SIDE = 400;

/**
 * Ceiling on what the server accepts. The browser never sends more than
 * 1800px tall (see lib/imageProcessor.ts), so this is headroom for direct API
 * callers, and it bounds the vision tokens a single scan can spend.
 */
export const MAX_IMAGE_SIDE = 4096;

/**
 * Ceiling on the picked photo before it is scaled down. 60MP clears a 48MP
 * phone camera; anything beyond that is more likely a panorama or a
 * decompression bomb than a receipt, and decoding it can exhaust a phone's
 * memory before the canvas ever shrinks it.
 */
export const MAX_SOURCE_PIXELS = 60_000_000;

/**
 * Screens decoded dimensions. Returns a message to show the user, or null when
 * the image is usable. `maxSide` defaults to the server ceiling; the browser
 * passes Infinity for the source photo, which it scales down itself, and
 * relies on `MAX_SOURCE_PIXELS` instead.
 */
export function checkImageDimensions(
  width: number,
  height: number,
  { maxSide = MAX_IMAGE_SIDE, maxPixels = Infinity }: { maxSide?: number; maxPixels?: number } = {}
): string | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return "Could not read the image dimensions.";
  }
  const short = Math.min(width, height);
  const long = Math.max(width, height);
  if (short < MIN_IMAGE_SHORT_SIDE || long < MIN_IMAGE_LONG_SIDE) {
    return `That image is too small to read (${width}×${height}px). Use a photo at least ${MIN_IMAGE_SHORT_SIDE}×${MIN_IMAGE_LONG_SIDE}px.`;
  }
  if (long > maxSide || width * height > maxPixels) {
    return `That image is too large (${width}×${height}px). Try a smaller photo.`;
  }
  return null;
}

export function isAllowedImageType(type: string): type is AllowedImageType {
  return (ALLOWED_IMAGE_TYPES as readonly string[]).includes(type);
}

/** The `accept` attribute for a file input, kept in step with the list above. */
export const PICKER_ACCEPT = ALLOWED_PICKER_TYPES.join(",");

/**
 * Screens a picked file before any work is done on it. Returns a message to
 * show the user, or null when the file is worth processing.
 */
export function checkUploadFile(file: { type: string; size: number }): string | null {
  if (!(ALLOWED_PICKER_TYPES as readonly string[]).includes(file.type)) {
    return "Choose a JPEG, PNG or WebP image.";
  }
  if (file.size <= 0) return "That image is empty.";
  if (file.size > MAX_UPLOAD_BYTES) {
    return `That image is over ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB. Try a smaller photo.`;
  }
  return null;
}

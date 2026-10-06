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

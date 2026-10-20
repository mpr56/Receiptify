import { describe, expect, test } from "vitest";
import {
  checkImageDimensions,
  checkUploadFile,
  MAX_IMAGE_SIDE,
  MAX_SOURCE_PIXELS,
  MAX_UPLOAD_BYTES,
  MIN_IMAGE_LONG_SIDE,
  MIN_IMAGE_SHORT_SIDE,
} from "./imageLimits";

describe("checkUploadFile", () => {
  test("accepts a JPEG within the size limit", () => {
    expect(checkUploadFile({ type: "image/jpeg", size: 2_000_000 })).toBeNull();
  });

  test("accepts PNG and WebP", () => {
    expect(checkUploadFile({ type: "image/png", size: 1000 })).toBeNull();
    expect(checkUploadFile({ type: "image/webp", size: 1000 })).toBeNull();
  });

  test("accepts HEIC and HEIF, which iPhones produce", () => {
    // The canvas step re-encodes to JPEG before anything is uploaded, so these
    // never reach the server as HEIC. Rejecting them here would break capture
    // on iOS, where they are the default camera format.
    expect(checkUploadFile({ type: "image/heic", size: 1000 })).toBeNull();
    expect(checkUploadFile({ type: "image/heif", size: 1000 })).toBeNull();
  });

  test("rejects a file type outside the allowlist", () => {
    expect(checkUploadFile({ type: "application/pdf", size: 1000 })).toBe(
      "Choose a JPEG, PNG or WebP image."
    );
    expect(checkUploadFile({ type: "image/svg+xml", size: 1000 })).toBe(
      "Choose a JPEG, PNG or WebP image."
    );
  });

  test("rejects a file with no reported type", () => {
    expect(checkUploadFile({ type: "", size: 1000 })).toBe("Choose a JPEG, PNG or WebP image.");
  });

  test("rejects a file above the upload size limit", () => {
    expect(checkUploadFile({ type: "image/jpeg", size: MAX_UPLOAD_BYTES + 1 })).toBe(
      "That image is over 15MB. Try a smaller photo."
    );
  });

  test("accepts a file exactly at the upload size limit", () => {
    expect(checkUploadFile({ type: "image/jpeg", size: MAX_UPLOAD_BYTES })).toBeNull();
  });

  test("rejects an empty file", () => {
    expect(checkUploadFile({ type: "image/jpeg", size: 0 })).toBe("That image is empty.");
  });
});

describe("checkImageDimensions", () => {
  test("accepts a typical receipt photo", () => {
    expect(checkImageDimensions(800, 1800)).toBeNull();
  });

  test("accepts a landscape image, judged by its short and long sides", () => {
    expect(checkImageDimensions(1800, 800)).toBeNull();
  });

  test("accepts an image exactly at the floor and the ceiling", () => {
    expect(checkImageDimensions(MIN_IMAGE_SHORT_SIDE, MIN_IMAGE_LONG_SIDE)).toBeNull();
    expect(checkImageDimensions(MAX_IMAGE_SIDE, MAX_IMAGE_SIDE)).toBeNull();
  });

  test("rejects a thumbnail too small to read", () => {
    expect(checkImageDimensions(MIN_IMAGE_SHORT_SIDE - 1, 1000)).toMatch(/too small/);
    expect(checkImageDimensions(300, MIN_IMAGE_LONG_SIDE - 1)).toMatch(/too small/);
  });

  test("rejects a side over the server ceiling", () => {
    expect(checkImageDimensions(1000, MAX_IMAGE_SIDE + 1)).toMatch(/too large/);
  });

  test("lets the browser trade the side ceiling for a pixel budget", () => {
    // A 48MP phone photo is fine before scaling; a 100MP panorama is not.
    const source = { maxSide: Infinity, maxPixels: MAX_SOURCE_PIXELS };
    expect(checkImageDimensions(6048, 8064, source)).toBeNull();
    expect(checkImageDimensions(10_000, 10_000, source)).toMatch(/too large/);
  });

  test("rejects dimensions that could not be read", () => {
    expect(checkImageDimensions(0, 1000)).toBe("Could not read the image dimensions.");
    expect(checkImageDimensions(NaN, 1000)).toBe("Could not read the image dimensions.");
  });
});

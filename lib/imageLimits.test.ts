import { describe, expect, test } from "vitest";
import { checkUploadFile, MAX_UPLOAD_BYTES } from "./imageLimits";

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

/**
 * Receipt image processor
 * - Crops to portrait receipt ratio (~3:7)
 * - Converts to greyscale (smaller file + better OCR)
 * - Compresses to JPEG targeting ~150KB
 */

import { checkUploadFile } from "@/lib/imageLimits";

const RECEIPT_ASPECT = 3 / 7; // width / height, typical receipt
const MAX_HEIGHT = 1800;        // px, enough for Tesseract, not overkill
const JPEG_QUALITY = 0.55;      // ~150KB for a 1080px-wide greyscale JPEG

export interface ProcessedImage {
  dataUrl: string;       // compressed greyscale JPEG
  originalSizeKB: number;
  compressedSizeKB: number;
  width: number;
  height: number;
}

function toGreyscale(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const imageData = ctx.getImageData(0, 0, w, h);
  const d = imageData.data;
  for (let i = 0; i < d.length; i += 4) {
    const grey = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
    d[i] = d[i + 1] = d[i + 2] = grey;
  }
  ctx.putImageData(imageData, 0, 0);
}

export async function processReceiptImage(file: File): Promise<ProcessedImage> {
  // Screened before any decoding work, so an unusable file fails immediately
  // with something readable. The server re-checks; this is only for the user.
  const rejection = checkUploadFile(file);
  if (rejection) throw new Error(rejection);

  const originalSizeKB = Math.round(file.size / 1024);

  return new Promise((resolve, reject) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);

    img.onload = () => {
      URL.revokeObjectURL(objectUrl);

      const srcW = img.naturalWidth;
      const srcH = img.naturalHeight;

      // --- Determine crop ---
      // If image is already portrait-ish, just constrain height.
      // If it's landscape (photo taken sideways), rotate by cropping center column.
      let cropX = 0, cropW = srcW;
      const cropY = 0, cropH = srcH;

      const srcRatio = srcW / srcH;
      if (srcRatio > 0.8) {
        // Too wide (landscape or square), crop to receipt column from center
        cropW = Math.round(srcH * RECEIPT_ASPECT);
        cropX = Math.round((srcW - cropW) / 2);
      }

      // Scale down so height ≤ MAX_HEIGHT
      const scale = Math.min(1, MAX_HEIGHT / cropH);
      const outW = Math.round(cropW * scale);
      const outH = Math.round(cropH * scale);

      const canvas = document.createElement("canvas");
      canvas.width = outW;
      canvas.height = outH;
      const ctx = canvas.getContext("2d")!;

      // Draw cropped + scaled
      ctx.drawImage(img, cropX, cropY, cropW, cropH, 0, 0, outW, outH);

      // Greyscale
      toGreyscale(ctx, outW, outH);

      // Slight contrast boost, helps OCR on faded thermal receipts
      ctx.filter = "contrast(1.15) brightness(1.05)";
      ctx.drawImage(canvas, 0, 0);
      ctx.filter = "none";

      canvas.toBlob(
        (blob) => {
          if (!blob) return reject(new Error("Canvas toBlob failed"));
          const reader = new FileReader();
          reader.onload = (e) => {
            resolve({
              dataUrl: e.target!.result as string,
              originalSizeKB,
              compressedSizeKB: Math.round(blob.size / 1024),
              width: outW,
              height: outH,
            });
          };
          reader.readAsDataURL(blob);
        },
        "image/jpeg",
        JPEG_QUALITY
      );
    };

    img.onerror = () => reject(new Error("Failed to load image"));
    img.src = objectUrl;
  });
}

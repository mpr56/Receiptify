/**
 * Minimal image headers for tests. Each carries just enough structure for
 * magic-byte sniffing and dimension reading; none of them decode to pixels.
 */

/** SOI, then a baseline SOF0 frame header holding the size. */
export function jpegOfSize(width: number, height: number): Buffer {
  const b = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0, 0, 0, 0, 0x01, 0x01, 0x11, 0x00]);
  b.writeUInt16BE(height, 7);
  b.writeUInt16BE(width, 9);
  return b;
}

/** PNG signature, then an IHDR chunk holding the size. */
export function pngOfSize(width: number, height: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]).copy(b, 0);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

/** RIFF/WEBP container with an extended (VP8X) header holding the size. */
export function webpOfSize(width: number, height: number): Buffer {
  const b = Buffer.alloc(30);
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(22, 4);
  b.write("WEBP", 8, "ascii");
  b.write("VP8X", 12, "ascii");
  b.writeUInt32LE(10, 16);
  b.writeUIntLE(width - 1, 24, 3);
  b.writeUIntLE(height - 1, 27, 3);
  return b;
}

/** A size that passes every dimension check: a typical scanned receipt. */
export const RECEIPT_SIZE = { width: 800, height: 1800 } as const;

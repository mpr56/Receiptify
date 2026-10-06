/**
 * Size-capped JSON body reading.
 *
 * Route handlers get no body limit by default, so `req.json()` on its own will
 * happily parse whatever a caller sends. Both upload endpoints read their body
 * through here instead.
 */

/**
 * 8MB. A 5MB image is roughly 6.7MB once base64-encoded; the remainder covers
 * the surrounding JSON.
 */
export const MAX_BODY_BYTES = 8 * 1024 * 1024;

export type JsonBody = { json: unknown } | { error: string; status: number };

const TOO_LARGE = { error: "Request body is too large", status: 413 } as const;

export async function readJsonBody(req: Request): Promise<JsonBody> {
  // A declared Content-Length lets us refuse before reading anything.
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return { ...TOO_LARGE };

  let text: string;
  try {
    text = await req.text();
  } catch {
    return { error: "Invalid JSON body", status: 400 };
  }

  // The header is a claim, not a measurement — check what actually arrived.
  // Byte length, not string length: multi-byte characters weigh more than one.
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) return { ...TOO_LARGE };

  try {
    return { json: JSON.parse(text) };
  } catch {
    return { error: "Invalid JSON body", status: 400 };
  }
}

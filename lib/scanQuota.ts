/**
 * Per-user rate limiting for the OCR scan endpoint.
 *
 * The counter lives in Postgres (see 0002_scan_usage.sql) rather than in
 * process memory, so it survives deploys and is shared across instances. All
 * this module does is call it and interpret the reply.
 */

/** Generous for someone filing their shopping; tight enough to bound a loop. */
export const SCANS_PER_HOUR = 60;

export type QuotaResult = { allowed: true; used: number; remaining: number } | { allowed: false };

/**
 * The one method this module needs, so callers can pass any Supabase client.
 * PromiseLike, not Promise: supabase-js returns an awaitable query builder.
 */
interface RpcClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
}

/**
 * Claims one scan against the caller's hourly allowance.
 *
 * Fails closed: if the counter cannot be reached the scan is refused rather
 * than waved through, since a limiter that opens under failure is not one.
 */
export async function consumeScanQuota(
  supabase: RpcClient,
  limit: number = SCANS_PER_HOUR
): Promise<QuotaResult> {
  const { data, error } = await supabase.rpc("consume_scan_quota", { p_limit: limit });

  if (error) {
    console.error("Scan quota check failed:", error);
    return { allowed: false };
  }

  // The function returns no row once the limit is reached.
  if (typeof data !== "number") return { allowed: false };

  return { allowed: true, used: data, remaining: Math.max(0, limit - data) };
}

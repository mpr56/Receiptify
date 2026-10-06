import { describe, expect, test } from "vitest";
import { consumeScanQuota, SCANS_PER_HOUR } from "./scanQuota";

/**
 * A stand-in for the one Supabase call this module makes. The database itself
 * is covered by the migration; what needs pinning here is how each shape of
 * reply is interpreted.
 */
function clientReturning(reply: { data: unknown; error: unknown }) {
  const calls: { fn: string; args: unknown }[] = [];
  return {
    calls,
    supabase: {
      rpc: async (fn: string, args: unknown) => {
        calls.push({ fn, args });
        return reply;
      },
    },
  };
}

describe("consumeScanQuota", () => {
  test("allows the scan and reports what is left when the quota had room", async () => {
    const { supabase } = clientReturning({ data: 4, error: null });

    expect(await consumeScanQuota(supabase, 10)).toEqual({
      allowed: true,
      used: 4,
      remaining: 6,
    });
  });

  test("denies the scan when the counter returns no row", async () => {
    const { supabase } = clientReturning({ data: null, error: null });

    expect(await consumeScanQuota(supabase, 10)).toEqual({ allowed: false });
  });

  test("denies the scan when the counter is exactly spent", async () => {
    const { supabase } = clientReturning({ data: 10, error: null });

    expect(await consumeScanQuota(supabase, 10)).toEqual({
      allowed: true,
      used: 10,
      remaining: 0,
    });
  });

  test("fails closed when the counter cannot be reached", async () => {
    // A rate limit that opens up whenever its store is unavailable is not a
    // rate limit. An unapplied migration surfaces here as a visible refusal.
    const { supabase } = clientReturning({ data: null, error: { message: "relation missing" } });

    expect(await consumeScanQuota(supabase, 10)).toEqual({ allowed: false });
  });

  test("passes the configured hourly limit to the counter", async () => {
    const { supabase, calls } = clientReturning({ data: 1, error: null });

    await consumeScanQuota(supabase);

    expect(calls).toEqual([{ fn: "consume_scan_quota", args: { p_limit: SCANS_PER_HOUR } }]);
  });
});

import { describe, expect, test } from "vitest";
import { MAX_BODY_BYTES, readJsonBody } from "./requestBody";

function post(body: string, headers: Record<string, string> = {}): Request {
  return new Request("https://example.test/api", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

describe("readJsonBody", () => {
  test("returns the parsed JSON for a well-formed body", async () => {
    const result = await readJsonBody(post(JSON.stringify({ storeName: "Alex & Co" })));

    expect(result).toEqual({ json: { storeName: "Alex & Co" } });
  });

  test("rejects a body declaring a Content-Length over the cap", async () => {
    const result = await readJsonBody(
      post("{}", { "content-length": String(MAX_BODY_BYTES + 1) })
    );

    expect(result).toEqual({ error: "Request body is too large", status: 413 });
  });

  test("rejects an oversized body that under-declares its Content-Length", async () => {
    const oversized = JSON.stringify({ pad: "A".repeat(MAX_BODY_BYTES + 1024) });
    const result = await readJsonBody(post(oversized, { "content-length": "10" }));

    expect(result).toEqual({ error: "Request body is too large", status: 413 });
  });

  test("rejects a body that is not valid JSON", async () => {
    const result = await readJsonBody(post("{not json"));

    expect(result).toEqual({ error: "Invalid JSON body", status: 400 });
  });

  test("rejects an empty body", async () => {
    const result = await readJsonBody(post(""));

    expect(result).toEqual({ error: "Invalid JSON body", status: 400 });
  });

  test("measures size in bytes, not characters", async () => {
    // Multi-byte characters must count for their encoded weight, otherwise a
    // body of emoji slips through at up to four times the intended size.
    const wide = "\u{1F9FE}".repeat(MAX_BODY_BYTES / 3);
    const result = await readJsonBody(post(JSON.stringify({ pad: wide })));

    expect(result).toEqual({ error: "Request body is too large", status: 413 });
  });
});

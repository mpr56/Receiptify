# Image upload hardening

Branch: `2-severe-uploads-currently-have-no-restrictions`
Status: **code complete, uncommitted. One blocking deploy step outstanding.**
Last worked: 2026-09-08

Context: image uploads had no restrictions on type, size, or content, and the
images are sent to a vision model for OCR. This note records what was wrong,
what changed, and what still needs doing.

---

## Pick this up here

1. **Apply the migration — scanning is broken until you do.**
   `supabase/migrations/0002_scan_usage.sql` creates the `consume_scan_quota`
   function. The rate limiter fails closed by design, so until that function
   exists **every scan returns 429**. Run it via the Supabase SQL editor or
   `supabase db push` (no `supabase` CLI was on PATH at the time of writing).
   If failing closed is the wrong call for your environment, see
   [Open questions](#open-questions).
2. Nothing is committed. `git status` shows the full change set.
3. Verify with `npm test` (63 tests), `npx tsc --noEmit`, `npm run build`.

---

## Findings

Numbered as originally reported; all five are addressed.

### 1. `/api/scan` accepted any payload, not just images

The data-URL regex was `/^data:([^;]+);base64,(.+)$/` — `[^;]+` matches *any*
mime type, and the result was cast with `as` to an image union, which the type
system cannot catch. `data:application/pdf;base64,…` or `text/html` passed
straight through to the vision provider. No size limit, and no check that the
bytes were actually an image.

### 2. No server-side size limit on either upload route

The browser compresses to ~150KB, but the browser is not a security boundary —
`/api/scan` and `/api/receipts` are both directly callable by any signed-in
user. Next.js route handlers do not cap `req.json()` by default (the 4MB limit
applies to Server Actions and Pages API routes, not App Router handlers), so a
multi-MB base64 blob was parsed into memory and forwarded upstream.

### 3. No rate limiting on `/api/scan`

Every call spends real tokens at the vision provider. A signed-in user could
loop it.

### 4. The model's response was never validated

`lib/ocr.ts` applied `??` defaults but no bounds, and `parseNewReceipt` capped
no string lengths or array sizes. A steered model could return a 1MB
`storeName`, 50,000 items, or `totalAmount: 1e308`, and it would reach the
database.

### 5. Raw upstream errors leaked to the client

`/api/scan` interpolated the caught error message into its response, which can
carry upstream request detail.

### On prompt injection specifically — scope correction

The original concern was that the OCR "could be prompted to run malicious
scripts or return sensitive data." Worth recording why that framing overstates
it, so nobody re-litigates this later:

- The system prompt holds no secrets — it is a parsing schema. Nothing to
  exfiltrate.
- `response_format: { type: "json_object" }` constrains the output shape.
- Output is rendered as React values (auto-escaped) and written through the
  Supabase client (parameterized). No `eval`, no `dangerouslySetInnerHTML`, no
  string-built SQL.
- The storage bucket is private with per-user RLS on the path prefix
  (`0001_receipts.sql`), so a mislabeled stored file cannot be served to
  another user.

So there is no script-execution or cross-user-leak path. The real exposure is
**attacker-chosen data landing in the user's own ledger, and unbounded model
output flowing into memory and the DB** — which is finding 4.

You also cannot filter adversarial text out of an image. The durable mitigation
is treating model output as untrusted input (`lib/ocrSchema.ts`) and keeping the
human confirm step in `AddReceiptModal`. The system-prompt wording added in
this change is marginal and should not be mistaken for the defense.

---

## What changed

| File | Change |
|---|---|
| `lib/imageLimits.ts` | **New.** Isomorphic constants + `checkUploadFile`. Shared by browser and server so the two checks cannot drift. |
| `lib/imageValidation.ts` | **New.** `parseImageDataUrl` — the single server-side gate. Finding 1, 2. |
| `lib/ocrSchema.ts` | **New.** `parseOcrResult` — clamps the model's reply. Finding 4. |
| `lib/requestBody.ts` | **New.** `readJsonBody` — size-capped body reading. Finding 2. |
| `lib/scanQuota.ts` | **New.** `consumeScanQuota` wrapper. Finding 3. |
| `supabase/migrations/0002_scan_usage.sql` | **New.** `scan_usage` table + `consume_scan_quota`. Finding 3. |
| `app/api/scan/route.ts` | Auth → capped body → image validation → quota → upstream call. Generic errors. Findings 1–5. |
| `app/api/receipts/route.ts` | Reads body via `readJsonBody`; consumes pre-validated `input.image`. |
| `lib/receipts.ts` | `parseNewReceipt` validates and decodes the image itself; write-side caps on store name, items, tags, notes, currency. `decodeDataUrl` removed. |
| `lib/ocr.ts` | Reuses `parseOcrResult` instead of hand-rolled `??` defaults. |
| `lib/imageProcessor.ts` | Calls `checkUploadFile` before any decoding work. |
| `app/components/AddReceiptModal.tsx` | File inputs use `PICKER_ACCEPT` rather than `image/*`. |
| `vitest.config.mts`, `package.json` | **New dev dep:** `vitest`. Added `npm test`. |

### The limits, in one place

Defined in `lib/imageLimits.ts` and `lib/ocrSchema.ts`:

| Limit | Value |
|---|---|
| Upload types (server accepts) | `image/jpeg`, `image/png`, `image/webp` |
| Picker types (browser offers) | the above + `image/heic`, `image/heif` |
| Decoded image | 5MB |
| Picked file, pre-compression | 15MB |
| Request body | 8MB |
| Scans per user per hour | 60 |
| Store name | 120 chars |
| Item name | 100 chars |
| Line items | 100 |
| Receipt amount | 1,000,000 |
| Item quantity | 10,000 |
| Tags / tag length | 20 / 40 chars |
| Notes | 2,000 chars |

---

## Decisions worth not re-deriving

**Magic-byte sniffing, not just a mime allowlist.** A declared content type is
the caller's claim. `parseImageDataUrl` sniffs the leading bytes (JPEG `FF D8
FF`, PNG 8-byte signature, WebP `RIFF….WEBP`) and rejects when they disagree
with the declared type. ~15 lines, no dependency. This is what stops HTML or
PDF bytes being stored under an image label.

**SVG is deliberately excluded** from the upload allowlist. It is a scriptable
document, not a raster image, and neither the OCR nor the bucket has any use
for one.

**The picker allowlist is wider than the upload allowlist, on purpose.**
Narrowing the file inputs to the three raster types would have broken iPhone
capture — iOS hands back HEIC, and the canvas step in `imageProcessor.ts`
already re-encodes to JPEG before anything is uploaded. So the picker accepts
HEIC/HEIF while the server still only ever sees JPEG/PNG/WebP. There is a test
pinning this (`lib/imageLimits.test.ts`, "accepts HEIC and HEIF"). Do not
"tighten" it without reading that test first.

**Body size is measured in bytes, not characters.** `Content-Length` is checked
first as a cheap early reject, then the body is re-measured with
`Buffer.byteLength` — the header is a claim, and string length would let
multi-byte payloads through at up to 4× the intended size.

**Quota is spent after validation.** A malformed request costs the caller
nothing; only a valid scan counts against them.

**The quota check and increment are one SQL statement.**
`INSERT … ON CONFLICT … DO UPDATE … WHERE count < p_limit RETURNING count`.
A `SELECT` then `UPDATE` would let two concurrent requests both read a count
under the limit and both proceed — exactly what a rate limit exists to stop.
No returned row means denied.

**`consume_scan_quota` is `SECURITY DEFINER`; `scan_usage` grants only
`SELECT` to `authenticated`.** Granting write access would let a client reset
its own counter. The select policy exists for a future "scans remaining"
display.

**The rate limiter fails closed.** If the counter cannot be reached, the scan
is refused. A limiter that opens under failure is not a limiter. The cost is
that an unapplied migration takes scanning down loudly rather than silently
disabling the control — see step 1 above.

**Image decoding moved into `parseNewReceipt`.** It returns validated
`image: { bytes, contentType }` on the input, so the route no longer re-parses
a caller-supplied data URL. `decodeDataUrl` and its regex are gone; don't
reintroduce a second parse site.

---

## Explicitly not done

- Virus/malware scanning of uploads.
- Server-side EXIF stripping — the canvas re-encode already drops it on the
  browser path, and the bucket is private.
- Any attempt to filter adversarial text out of images. Not solvable this way;
  see the scope correction above.

## Open questions

- **Fail-closed vs fail-open on the quota store.** Currently closed. If an
  outage taking scanning down is worse than an outage temporarily lifting the
  rate limit, flip it in `lib/scanQuota.ts` — the behaviour is pinned by the
  test "fails closed when the counter cannot be reached", so change that test
  deliberately rather than deleting it.
- **60 scans/hour** was a judgement call: generous for someone filing their
  shopping, tight enough to bound a loop. Tune `SCANS_PER_HOUR` if real usage
  says otherwise.
- `/api/receipts` has no rate limit. Lower value to an attacker (no token
  spend, and RLS caps it to their own rows), but it is unbounded storage
  writes. Not in scope for this branch.

## Verification run at the time of writing

```
npm test          → 6 files, 63 tests passing
npx tsc --noEmit  → clean
npm run lint      → 0 errors, 3 pre-existing warnings (img elements, custom font)
npm run build     → succeeds
```

Test files: `lib/imageValidation.test.ts` (14), `lib/ocrSchema.test.ts` (16),
`lib/receipts.test.ts` (14), `lib/imageLimits.test.ts` (8),
`lib/requestBody.test.ts` (6), `lib/scanQuota.test.ts` (5).

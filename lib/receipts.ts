import type { SupabaseClient } from "@supabase/supabase-js";
import {
  Receipt,
  ReceiptItem,
  ReceiptPage,
  ReceiptRow,
  ReceiptStats,
  ProductCategory,
  SortField,
} from "@/types";
import { CATEGORIES, getStoreColor, getInitials } from "@/lib/data";
import { parseImageDataUrl, type ValidatedImage } from "@/lib/imageValidation";
import {
  cleanAmount,
  cleanString,
  MAX_ITEMS,
  MAX_ITEM_NAME_CHARS,
  MAX_ITEM_QUANTITY,
  MAX_STORE_NAME_CHARS,
} from "@/lib/ocrSchema";

export const PAGE_SIZE = 50;

/**
 * Write-side bounds. The scan route already clamps what the model returns, but
 * this endpoint is callable on its own, so it enforces the same limits rather
 * than assuming a body came from our own client.
 */
export const MAX_TAGS = 20;
export const MAX_TAG_CHARS = 40;
export const MAX_NOTES_CHARS = 2_000;

const CURRENCY_CODE = /^[A-Za-z]{3}$/;

const PAYMENT_METHODS = ["cash", "card", "digital"] as const;
const SORT_FIELDS: SortField[] = ["date", "amount", "store"];

// ---------------------------------------------------------------------------
// Row <-> Receipt
// ---------------------------------------------------------------------------

/**
 * storeColor and storeLogoInitials are computed here rather than stored, so a
 * change to the palette in lib/data.ts reaches every existing receipt.
 */
export function rowToReceipt(row: ReceiptRow): Receipt {
  const storeName = row.store_name;
  return {
    id: row.id,
    storeName,
    storeLogoInitials: getInitials(storeName),
    storeColor: getStoreColor(storeName),
    category: row.category as ProductCategory,
    date: row.purchased_at,
    totalAmount: Number(row.total_amount),
    currency: row.currency,
    items: Array.isArray(row.items) ? row.items : [],
    paymentMethod: row.payment_method,
    tags: row.tags ?? [],
    notes: row.notes ?? undefined,
    imagePath: row.image_path ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Keyset cursors
// ---------------------------------------------------------------------------
// A cursor is the sort value and id of the last row on the previous page. The
// value is always carried as text and cast back to its real type in SQL, which
// keeps one cursor format working across all three sort fields.

interface Cursor {
  value: string;
  id: string;
}

export function encodeCursor(receipt: Receipt, sort: SortField): string {
  const value =
    sort === "amount"
      ? String(receipt.totalAmount)
      : sort === "store"
        ? receipt.storeName
        : receipt.date;
  return Buffer.from(JSON.stringify({ v: value, i: receipt.id }), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string | null | undefined): Cursor | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof parsed?.v !== "string" || typeof parsed?.i !== "string") return null;
    return { value: parsed.v, id: parsed.i };
  } catch {
    // A malformed cursor means "start from the beginning", not a 500.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export interface ListOptions {
  search?: string;
  categories?: string[];
  sort?: SortField;
  cursor?: string | null;
  limit?: number;
}

/** Normalises whatever arrived on the query string into safe RPC arguments. */
export function parseListParams(params: URLSearchParams): ListOptions {
  const sort = params.get("sort");
  const categories = params.getAll("category").filter((c) => CATEGORIES.includes(c as ProductCategory));
  return {
    search: params.get("search")?.trim() || undefined,
    categories: categories.length ? categories : undefined,
    sort: SORT_FIELDS.includes(sort as SortField) ? (sort as SortField) : "date",
    cursor: params.get("cursor"),
  };
}

export async function listReceipts(
  supabase: SupabaseClient,
  opts: ListOptions = {}
): Promise<ReceiptPage> {
  const sort = opts.sort ?? "date";
  const limit = opts.limit ?? PAGE_SIZE;
  const cursor = decodeCursor(opts.cursor);

  // Ask for one more row than the page holds: its presence is what tells us
  // there is a next page, without a second count query.
  const { data, error } = await supabase.rpc("list_receipts", {
    p_search: opts.search ?? null,
    p_categories: opts.categories ?? null,
    p_sort: sort,
    p_cursor_value: cursor?.value ?? null,
    p_cursor_id: cursor?.id ?? null,
    p_limit: limit + 1,
  });

  if (error) throw new Error(`list_receipts failed: ${error.message}`);

  const rows = (data ?? []) as ReceiptRow[];
  const hasMore = rows.length > limit;
  const receipts = rows.slice(0, limit).map(rowToReceipt);

  return {
    receipts,
    nextCursor: hasMore && receipts.length ? encodeCursor(receipts[receipts.length - 1], sort) : null,
  };
}

export async function getReceiptStats(
  supabase: SupabaseClient,
  opts: Pick<ListOptions, "search" | "categories"> = {}
): Promise<ReceiptStats> {
  const { data, error } = await supabase.rpc("receipt_stats", {
    p_search: opts.search ?? null,
    p_categories: opts.categories ?? null,
  });

  if (error) throw new Error(`receipt_stats failed: ${error.message}`);

  // The function returns a single row; PostgREST hands back an array.
  const row = (Array.isArray(data) ? data[0] : data) ?? {};
  return {
    receiptCount: Number(row.receipt_count ?? 0),
    totalSpend: Number(row.total_spend ?? 0),
    avgBasket: Number(row.avg_basket ?? 0),
    largestAmount: row.largest_amount == null ? null : Number(row.largest_amount),
    largestStore: row.largest_store ?? null,
    totalCount: Number(row.total_count ?? 0),
  };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface NewReceiptInput {
  storeName: string;
  category: ProductCategory;
  date: string;
  totalAmount: number;
  currency: string;
  paymentMethod: "cash" | "card" | "digital";
  items: ReceiptItem[];
  tags: string[];
  notes?: string;
  /**
   * Transient: uploaded to storage, never written to the row. Already decoded
   * and type-checked, so callers never re-parse a caller-supplied data URL.
   */
  image?: ValidatedImage;
}

/**
 * Validates an untrusted request body. Returns the input or a reason string —
 * the caller turns that into a 400.
 */
export function parseNewReceipt(body: unknown): { input: NewReceiptInput } | { error: string } {
  if (typeof body !== "object" || body === null) return { error: "Expected an object" };
  const b = body as Record<string, unknown>;

  const storeName = cleanString(b.storeName, MAX_STORE_NAME_CHARS);
  if (!storeName) return { error: "storeName is required" };

  const date = typeof b.date === "string" ? b.date : "";
  if (!date || Number.isNaN(Date.parse(date))) return { error: "date must be an ISO date string" };

  const category = CATEGORIES.includes(b.category as ProductCategory)
    ? (b.category as ProductCategory)
    : "Other";

  const paymentMethod = PAYMENT_METHODS.includes(b.paymentMethod as (typeof PAYMENT_METHODS)[number])
    ? (b.paymentMethod as "cash" | "card" | "digital")
    : "card";

  const items: ReceiptItem[] = Array.isArray(b.items)
    ? b.items
        .filter((i): i is Record<string, unknown> => typeof i === "object" && i !== null)
        .slice(0, MAX_ITEMS)
        .map((i) => {
          const rawQuantity = Number(i.quantity);
          const quantity = Number.isFinite(rawQuantity)
            ? Math.min(MAX_ITEM_QUANTITY, Math.max(0, Math.round(rawQuantity)))
            : 0;
          const unitPrice = cleanAmount(Number(i.unitPrice));
          const totalPrice = Number(i.totalPrice);
          return {
            name: cleanString(i.name, MAX_ITEM_NAME_CHARS),
            quantity,
            unitPrice,
            totalPrice: Number.isFinite(totalPrice) && totalPrice !== 0
              ? cleanAmount(totalPrice)
              : cleanAmount(quantity * unitPrice),
          };
        })
        .filter((i) => i.name)
    : [];

  const rawTotal = Number(b.totalAmount);
  if (!Number.isFinite(rawTotal) || rawTotal < 0) return { error: "totalAmount must be a number" };

  // Decoded here rather than in the route, so the bytes are validated once and
  // the caller never sees an unchecked data URL.
  let image: ValidatedImage | undefined;
  if (b.imageDataUrl !== undefined && b.imageDataUrl !== null) {
    const parsedImage = parseImageDataUrl(b.imageDataUrl);
    if ("error" in parsedImage) return { error: parsedImage.error };
    image = parsedImage;
  }

  const currency =
    typeof b.currency === "string" && CURRENCY_CODE.test(b.currency)
      ? b.currency.toUpperCase()
      : "AUD";

  const notes = cleanString(b.notes, MAX_NOTES_CHARS);

  return {
    input: {
      storeName,
      category,
      date,
      totalAmount: cleanAmount(rawTotal),
      currency,
      paymentMethod,
      items,
      tags: Array.isArray(b.tags)
        ? b.tags
            .map((t) => cleanString(t, MAX_TAG_CHARS))
            .filter(Boolean)
            .slice(0, MAX_TAGS)
        : [],
      notes: notes || undefined,
      image,
    },
  };
}

export function newReceiptToRow(input: NewReceiptInput, userId: string, id: string, imagePath: string | null) {
  return {
    id,
    user_id: userId,
    store_name: input.storeName,
    category: input.category,
    purchased_at: new Date(input.date).toISOString(),
    total_amount: input.totalAmount,
    currency: input.currency,
    payment_method: input.paymentMethod,
    tags: input.tags,
    notes: input.notes ?? null,
    items: input.items,
    image_path: imagePath,
  };
}

export const RECEIPTS_BUCKET = "receipts";

/** Objects live at {userId}/{receiptId}.ext so storage policies can authorise on the prefix. */
export function imagePathFor(userId: string, receiptId: string, contentType: string): string {
  const ext = contentType === "image/png" ? "png" : contentType === "image/webp" ? "webp" : "jpg";
  return `${userId}/${receiptId}.${ext}`;
}

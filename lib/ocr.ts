import { ProductCategory } from "@/types";
import { NOT_A_RECEIPT, parseOcrResult, type ScannedReceipt } from "@/lib/ocrSchema";

export interface OCRResult extends ScannedReceipt {
  category: ProductCategory;
}

/**
 * The scan worked but the image is not a receipt. Kept apart from other scan
 * failures because the image itself is the problem: falling through to manual
 * entry would file the wrong photo against the receipt.
 */
export class NotAReceiptError extends Error {
  constructor(message = "That doesn't look like a receipt. Try another photo.") {
    super(message);
    this.name = "NotAReceiptError";
  }
}

// --- Category inference -------------------------------------------------------
const CATEGORY_MAP: { keywords: string[]; category: ProductCategory }[] = [
  { keywords: ["woolworths", "coles", "aldi", "iga", "foodland", "harris farm", "grocery", "supermarket"], category: "Groceries" },
  { keywords: ["mcdonald", "kfc", "hungry jack", "subway", "domino", "pizza", "noodle", "sushi", "cafe", "restaurant", "uber eats", "doordash", "menulog", "grill", "burger", "bakery", "coffee", "alex & co", "bistro", "kitchen", "dining", "eatery"], category: "Food & Dining" },
  { keywords: ["jb hi-fi", "jbhifi", "apple", "harvey norman", "officeworks", "samsung", "tech", "computer", "electronics", "phone", "camera"], category: "Electronics" },
  { keywords: ["chemist", "pharmacy", "priceline", "terry white", "amcal", "health", "medical", "vitamin", "supplement"], category: "Health & Pharmacy" },
  { keywords: ["adidas", "nike", "kmart", "target", "big w", "cotton on", "h&m", "zara", "uniqlo", "myer", "david jones", "sport", "apparel", "fashion", "clothing", "shoes"], category: "Clothing & Apparel" },
  { keywords: ["uber", "taxi", "transport", "bus", "train", "opal", "parking", "toll", "fuel", "petrol", "shell", "bp", "caltex", "ampol"], category: "Transportation" },
  { keywords: ["netflix", "spotify", "steam", "cinema", "event", "ticketek", "game", "entertainment", "movie"], category: "Entertainment" },
  { keywords: ["bunnings", "ikea", "garden", "hardware", "plumbing", "paint", "mitre 10"], category: "Home & Garden" },
  { keywords: ["telstra", "optus", "vodafone", "insurance", "bank", "subscription", "internet", "nbn"], category: "Services" },
];

export function inferCategory(storeName: string): ProductCategory {
  const lower = storeName.toLowerCase();
  for (const { keywords, category } of CATEGORY_MAP) {
    if (keywords.some((kw) => lower.includes(kw))) return category;
  }
  return "Other";
}

// --- Main export, single vision API call -------------------------------------
export async function scanReceipt(
  imageDataUrl: string,
  onProgress?: (pct: number, status: string) => void
): Promise<OCRResult> {
  onProgress?.(15, "Sending to Qwen 3.8 Vision…");

  const response = await fetch("/api/scan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ imageDataUrl }),
  });

  onProgress?.(75, "Reading receipt…");

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    if (err.code === NOT_A_RECEIPT) throw new NotAReceiptError(err.error);
    throw new Error(err.error ?? "Scan failed");
  }

  onProgress?.(92, "Structuring data…");

  // The route already clamps this; running it again costs nothing and means the
  // shape holds even if this function is ever pointed at another endpoint.
  const parsed = parseOcrResult(await response.json());

  onProgress?.(100, "Done");

  return { ...parsed, category: inferCategory(parsed.storeName) };
}

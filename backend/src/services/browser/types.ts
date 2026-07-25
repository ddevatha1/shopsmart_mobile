/**
 * Shared types for the generic browser-extraction framework (see
 * BrowserAdapter.ts for the pipeline overview). Deliberately separate from
 * `types/index.ts`'s `ApiProduct` — this framework is meant to work against
 * *any* grocery site, including ones ShopSmart hasn't decided to support in
 * production yet, so its output type (`BrowserProduct`) uses a plain
 * `store: string` rather than the closed `ApiProduct['store']` union.
 * Promoting a browser-discovered store into production (the way Harris
 * Teeter was promoted onto the Kroger adapter) is a separate, deliberate
 * step — adding it to that union and mapping `BrowserProduct` -> `ApiProduct`
 * — not something this experimental framework does on its own.
 */
import type { Page } from 'playwright';
import type { StoreLocation } from '../../types/index.ts';

/** The one thing a new store genuinely needs to supply — everything else
 * (session handling, search-input detection, network capture, product
 * detection, normalization, relevance ranking) is generic. */
export interface BrowserStoreConfig {
  storeName: string;
  /** Builds the URL to load for a given search query — typically a store's
   * own search-results page. */
  buildSearchUrl(query: string, zipcode?: string): string;
  /** Optional — only needed for sites that gate real local pricing behind
   * a delivery-zip/store-picker step the generic best-effort zip-input
   * heuristic (see BrowserAdapter.ts) can't reliably find on its own.
   * Errors here are swallowed by the caller (best-effort, not required for
   * the search to proceed). */
  setLocation?(page: Page, zipcode: string): Promise<void>;
  /** Optional override tried before the generic search-input selector
   * list — only needed if a specific site's markup defeats every generic
   * heuristic. */
  searchInputSelector?: string;
  /** Echoed onto every normalized product from this run, the same as every
   * direct-API adapter already attaches a resolved StoreLocation. */
  location?: StoreLocation;
}

export type CanonicalField =
  | 'name' | 'price' | 'id' | 'upc' | 'image' | 'category'
  | 'department' | 'aisle' | 'brand' | 'promotions' | 'availability';

export interface FieldMatch {
  field: CanonicalField;
  sourceKey: string;
  value: unknown;
}

/** A JSON object ProductExtractor judged product-shaped, plus which fields
 * it matched and where — the "evidence trail" ProductNormalizer reads
 * instead of assuming a fixed schema. */
export interface ProductCandidate {
  raw: Record<string, unknown>;
  matches: FieldMatch[];
  /** 0-1 — fraction of all recognized canonical fields this candidate
   * matched. Confidence, not relevance: a candidate can be a
   * high-confidence *product* that's completely irrelevant to the
   * shopper's query (see SearchRanker.ts, which handles relevance
   * separately). */
  confidence: number;
  /** Which captured network response this came from — provenance, same
   * principle as `StoreLocation.source` elsewhere in this app: a result
   * should always be traceable back to real evidence, never just trusted. */
  sourceUrl: string;
}

export interface BrowserProduct {
  id: string;
  store: string;
  name: string;
  brand: string;
  price: number;
  pricePerUnit?: string;
  image_url?: string;
  rating: number;
  reviewCount?: number;
  isLiveData: true;
  size: string;
  upc?: string;
  category?: string;
  department?: string;
  aisle?: string;
  inStock?: boolean;
  promotions?: string[];
  location?: StoreLocation;
  sourceUrl: string;
}

export interface RankedProduct {
  product: BrowserProduct;
  /** 0-1, from computeRelevance's 0-100 scale — see SearchRanker.ts. */
  relevanceScore: number;
  matchType: 'direct' | 'related';
}

export interface CapturedResponse {
  url: string;
  method: string;
  status: number;
  json: unknown;
}

export interface BrowserSearchResult {
  products: RankedProduct[];
  /** Every distinct URL a JSON response was captured from this run —
   * informational/debugging only (see BrowserAdapter.ts's header comment
   * on why this framework doesn't auto-persist/replay these). */
  discoveredEndpoints: string[];
  durationMs: number;
  attempts: number;
}

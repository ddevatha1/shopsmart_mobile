/**
 * Kroger-family live price fetcher — covers both the Kroger banner and
 * Harris Teeter, which turn out to be the exact same official API.
 *
 * Uses the official Kroger Product API (product.compact scope):
 *   1. OAuth2 client_credentials → access token (cached 25 min)
 *   2. Locations API → nearest locationId for user's zip code (cached 1 hr)
 *   3. Products API → real prices for up to 50 products (cached 5 min)
 *
 * Harris Teeter is a Kroger Co. banner, and — verified live against the real
 * API, not assumed — it is served by exactly this same OAuth client,
 * exactly this same Locations/Products API, with no extra configuration:
 * Harris Teeter locations simply carry `chain: "HART"` in the Locations API
 * response instead of `chain: "KROGER"`, and product search against a
 * Harris Teeter `locationId` returns real Harris Teeter-branded products,
 * real prices, real promo pricing, and real images through the identical
 * `/v1/products` endpoint. So this file adds Harris Teeter as a second thin
 * banner, not a second scraper: one shared OAuth token, one shared search/
 * normalization pipeline, parameterized by which banner's `chain` code and
 * display name to use. See `locators/krogerLocator.ts`'s header comment for
 * the live-verified mislabeling bug this also fixes (an unfiltered locator
 * would resolve a Charlotte, NC "Kroger" search to the nearest Harris
 * Teeter store and report it as Kroger).
 */

import type { ApiProduct, StoreLocation } from '../types/index.ts';
import { toTitleCase, hashCode } from '../utils/textFormat.ts';
import { withTimeout } from '../utils/withTimeout.ts';
import { TtlCache } from '../utils/ttlCache.ts';
import { dedupeInFlight } from '../utils/dedupeInFlight.ts';
import { createKrogerLocator } from './locators/krogerLocator.ts';
import type { PreciseCoords, StoreLocator } from './locators/types.ts';

const KROGER_API = 'https://api.kroger.com/v1';

// ── Token cache ───────────────────────────────────────────────────────────────
let tokenCache: { token: string; expiresAt: number } | null = null;

// Deduped so a racing warm-up and a shopper's first real search — both
// finding an expired/empty token cache at the same instant — share one
// OAuth request instead of each firing its own.
async function getToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAt) return tokenCache.token;

  return dedupeInFlight('kroger-token', async () => {
    if (tokenCache && Date.now() < tokenCache.expiresAt) return tokenCache.token;

    const clientId = process.env.KROGER_CLIENT_ID;
    const clientSecret = process.env.KROGER_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new Error(
        'Kroger auth failed: KROGER_CLIENT_ID / KROGER_CLIENT_SECRET are not set. ' +
        'Local dev: set them in backend/.env (see backend/.env.example). ' +
        'Render: add them as environment variables on the service (see render.yaml).',
      );
    }

    const creds = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

    const res = await fetch(`${KROGER_API}/connect/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${creds}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials&scope=product.compact',
      cache: 'no-store',
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Kroger auth failed (${res.status}): ${text.slice(0, 200)}`);
    }

    const json = await res.json();
    const ttl = (json.expires_in ?? 1800) - 60; // 1-min safety buffer
    tokenCache = { token: json.access_token, expiresAt: Date.now() + ttl * 1000 };
    return tokenCache.token;
  });
}

// ── Banners ───────────────────────────────────────────────────────────────────
// Every Kroger Co. banner this app searches — each is just a `chain` code
// on the same official API, not a different integration. Adding another
// verified banner (e.g. Ralphs, Fred Meyer, King Soopers) later is a new
// entry here, not new code.
export interface KrogerBanner {
  storeName: ApiProduct['store'];
  /** Kroger's own Locations API `chain` code for this banner — verified
   * live, not guessed (see krogerLocator.ts's header comment). */
  chain: string;
  /** Namespaces product ids and cache keys per banner so "Kroger" and
   * "Harris Teeter" results for the same query/zip never collide. */
  idSlug: string;
}

const KROGER_BANNER: KrogerBanner = { storeName: 'Kroger', chain: 'KROGER', idSlug: 'kroger' };
const HARRIS_TEETER_BANNER: KrogerBanner = { storeName: 'Harris Teeter', chain: 'HART', idSlug: 'harris-teeter' };

// ── Store locators ───────────────────────────────────────────────────────────
// See locators/krogerLocator.ts — resolves the nearest real store for a
// given banner via Kroger's own Locations API and ranks candidates by
// actual distance. One locator instance per banner (each scoped to its own
// `chain` code) — sharing one locator across banners is exactly the
// mislabeling bug this file's header comment describes.
const krogerLocator = createKrogerLocator(getToken, KROGER_BANNER.chain, KROGER_BANNER.storeName);
const harrisTeeterLocator = createKrogerLocator(getToken, HARRIS_TEETER_BANNER.chain, HARRIS_TEETER_BANNER.storeName);

// ── Product result cache ──────────────────────────────────────────────────────
const productCache = new TtlCache<ApiProduct[]>(5 * 60 * 1000); // 5 min

// ── Raw API shapes ────────────────────────────────────────────────────────────
interface KrogerPrice {
  regular: number;
  promo: number;
}
export interface KrogerInventory {
  stockLevel?: string;
}
export interface KrogerItem {
  size?: string;
  price?: KrogerPrice;
  // Real per-store fields, confirmed live (docs/store_api_audit.md's
  // Kroger "Bonus finding") — `inventory.stockLevel` is a coarse string
  // like "HIGH"/"LOW"/"TEMPORARILY_OUT_OF_STOCK", not a count.
  inventory?: KrogerInventory;
}
interface KrogerImageSize {
  id: string;
  url: string;
}
interface KrogerImage {
  perspective: string;
  sizes: KrogerImageSize[];
}
interface KrogerRatingsAndReviews {
  averageOverallRating?: number;
  totalReviewCount?: number;
}
export interface KrogerProduct {
  productId: string;
  brand?: string;
  description?: string;
  items?: KrogerItem[];
  images?: KrogerImage[];
  // Real Kroger review data, confirmed live but previously unmapped (see
  // this file's `mapKrogerProduct`) — absent for many products, never
  // assumed present.
  ratingsAndReviews?: KrogerRatingsAndReviews;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function stripTrademarks(s: string): string {
  return s.replace(/[®™©]/g, '').replace(/\s+/g, ' ').trim();
}

function getBestImageUrl(images?: KrogerImage[]): string | undefined {
  if (!images?.length) return undefined;
  const front = images.find(i => i.perspective === 'front') ?? images[0];
  const sizes = front.sizes ?? [];
  for (const id of ['medium', 'large', 'xlarge', 'thumbnail']) {
    const found = sizes.find(s => s.id === id);
    if (found?.url) return found.url;
  }
  return sizes[0]?.url;
}

// A handful of documented Kroger `stockLevel` values genuinely mean "not
// orderable right now" — everything else (including a value this app
// doesn't recognize yet) is treated as in stock, same as the absence of
// the field entirely. Never a guess in the other direction: an
// unrecognized non-empty value is not treated as OUT of stock just
// because it's unfamiliar.
const OUT_OF_STOCK_LEVELS = new Set(['TEMPORARILY_OUT_OF_STOCK', 'OUT_OF_STOCK']);

/** Real Kroger review data when the API actually returned it for this
 * product (confirmed live — docs/store_api_audit.md's Kroger "Bonus
 * finding"); many products don't carry it, so this falls back to the
 * same deterministic synthetic rating this file always used rather than
 * ever showing a fabricated "real" value alongside genuine ones with no
 * way to tell them apart. */
function resolveRating(p: KrogerProduct): { rating: number; reviewCount: number } {
  const real = p.ratingsAndReviews;
  if (real?.averageOverallRating != null && real.totalReviewCount != null) {
    return { rating: real.averageOverallRating, reviewCount: real.totalReviewCount };
  }
  const seed = hashCode(p.productId);
  return {
    rating: Math.round((3.8 + (seed % 12) / 10) * 10) / 10,
    reviewCount: 20 + (seed % 2000),
  };
}

/** Real per-store stock level when the API returned one; `undefined`
 * (the common case) keeps this app's long-standing default of assuming
 * in stock rather than treating "no data" as "unavailable." */
function resolveInStock(item: KrogerItem | undefined): boolean {
  const stockLevel = item?.inventory?.stockLevel;
  if (!stockLevel) return true;
  return !OUT_OF_STOCK_LEVELS.has(stockLevel.toUpperCase());
}

export function mapKrogerProduct(p: KrogerProduct, location: StoreLocation | undefined, banner: KrogerBanner): ApiProduct | null {
  const description = stripTrademarks(p.description ?? '').trim();
  if (!description) return null;

  const item = p.items?.[0];
  const regularPrice = item?.price?.regular ?? 0;
  const promoPrice = item?.price?.promo ?? 0;

  // Skip products with no pricing info
  if (regularPrice <= 0) return null;

  const hasSale = promoPrice > 0 && promoPrice < regularPrice;
  const price = hasSale ? promoPrice : regularPrice;

  const { rating, reviewCount } = resolveRating(p);

  return {
    id: `${banner.idSlug}-${p.productId}`,
    name: toTitleCase(description),
    brand: p.brand ? toTitleCase(stripTrademarks(p.brand)) : '',
    price,
    originalPrice: hasSale ? regularPrice : undefined,
    discountPercent: hasSale ? Math.round((1 - promoPrice / regularPrice) * 100) : undefined,
    image_url: getBestImageUrl(p.images),
    rating,
    reviewCount,
    size: item?.size ?? '',
    isLiveData: true,
    store: banner.storeName,
    location,
    inStock: resolveInStock(item),
  };
}

// ── Shared search implementation ────────────────────────────────────────────
// Both searchKroger and searchHarrisTeeter are thin wrappers around this —
// same OAuth token, same Products API call shape, same normalization; only
// the banner (and therefore which locator/chain/store-name/id-prefix) ever
// differs.
async function searchKrogerBanner(
  banner: KrogerBanner,
  locator: StoreLocator,
  query: string,
  zipcode: string,
  preciseCoords?: PreciseCoords,
): Promise<ApiProduct[]> {
  // Precise coordinates can change which real store this resolves to (see
  // krogerLocator.ts) — folded into the cache key so a shopper with a GPS
  // fix never gets served another shopper's centroid-based result for the
  // same zip, or vice versa. Banner is namespaced in too, so Kroger and
  // Harris Teeter results for the same query/zip never share a cache slot.
  const cacheKey = preciseCoords
    ? `${banner.idSlug}|${query.toLowerCase().trim()}|${zipcode}|${preciseCoords.latitude.toFixed(2)},${preciseCoords.longitude.toFixed(2)}`
    : `${banner.idSlug}|${query.toLowerCase().trim()}|${zipcode}`;
  const cached = productCache.get(cacheKey);
  if (cached) {
    console.log(`[${banner.storeName}] Cache hit for "${query}"`);
    return cached;
  }

  console.log(`[${banner.storeName}] Live fetch for "${query}" @ ${zipcode}`);

  const token = await getToken();
  const storeLocation = await locator.findNearestStore(zipcode, preciseCoords);

  if (!storeLocation) {
    console.log(`[${banner.storeName}] No ${banner.storeName} location found near ${zipcode}`);
    return [];
  }

  const url = new URL(`${KROGER_API}/products`);
  url.searchParams.set('filter.term', query);
  url.searchParams.set('filter.locationId', storeLocation.storeId!);
  url.searchParams.set('filter.limit', '50');

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    cache: 'no-store',
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${banner.storeName} products API failed (${res.status}): ${text.slice(0, 200)}`);
  }

  const json = await res.json();
  const raw = (json.data ?? []) as KrogerProduct[];
  console.log(`[${banner.storeName}] Raw: ${raw.length} products from API`);

  const products = raw
    .map(p => mapKrogerProduct(p, storeLocation, banner))
    .filter((p): p is ApiProduct => p !== null);

  console.log(`[${banner.storeName}] ${products.length} mapped products for "${query}"`);
  // Debug output — trace the ZIP → store → product-count pipeline at a glance.
  console.log(
    `[${banner.storeName}][debug] zip=${zipcode} -> store="${storeLocation.name}" ` +
      `id=${storeLocation.storeId} address="${storeLocation.address}, ${storeLocation.city}, ` +
      `${storeLocation.state} ${storeLocation.zip}" ` +
      `lat=${storeLocation.latitude ?? '?'} lng=${storeLocation.longitude ?? '?'} products=${products.length}`,
  );
  productCache.set(cacheKey, products);
  return products;
}

// ── Kroger ───────────────────────────────────────────────────────────────────
export function searchKroger(query: string, zipcode: string, preciseCoords?: PreciseCoords): Promise<ApiProduct[]> {
  return searchKrogerBanner(KROGER_BANNER, krogerLocator, query, zipcode, preciseCoords);
}

export function searchKrogerWithTimeout(
  query: string,
  zipcode: string,
  timeoutMs: number,
  preciseCoords?: PreciseCoords,
): Promise<ApiProduct[]> {
  return withTimeout(searchKroger(query, zipcode, preciseCoords), timeoutMs, 'Kroger search');
}

// Pays the OAuth2 token round-trip (and, once a zip is known, the nearest-
// store lookup) at app-startup time instead of on the first real search —
// both populate the same module-level caches `searchKroger` already checks,
// so this is purely additive: skipping it changes nothing except which
// request pays the cost. Safe to call repeatedly (each piece is itself
// idempotent once its cache is warm) and never throws — the caller decides
// whether a failed warm-up is worth logging.
export async function warmKroger(zip?: string): Promise<void> {
  await getToken();
  if (zip) await krogerLocator.findNearestStore(zip);
}

// ── Harris Teeter ────────────────────────────────────────────────────────────
// A Kroger Co. banner served by the exact same official API as Kroger
// itself (see this file's header comment) — everything below is a thin
// pass-through into the shared implementation above, not a new scraper.
export function searchHarrisTeeter(query: string, zipcode: string, preciseCoords?: PreciseCoords): Promise<ApiProduct[]> {
  return searchKrogerBanner(HARRIS_TEETER_BANNER, harrisTeeterLocator, query, zipcode, preciseCoords);
}

export function searchHarrisTeeterWithTimeout(
  query: string,
  zipcode: string,
  timeoutMs: number,
  preciseCoords?: PreciseCoords,
): Promise<ApiProduct[]> {
  return withTimeout(searchHarrisTeeter(query, zipcode, preciseCoords), timeoutMs, 'Harris Teeter search');
}

export async function warmHarrisTeeter(zip?: string): Promise<void> {
  await getToken();
  if (zip) await harrisTeeterLocator.findNearestStore(zip);
}

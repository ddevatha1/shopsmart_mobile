/**
 * Aldi live price fetcher — GraphQL `SearchResultsPlacements`.
 *
 * Built from a real captured cURL (browser session), then empirically
 * minimized by replaying stripped-down variants against the live endpoint.
 * Findings (see the integration report for the full test matrix):
 *
 *   - Only `x-ic-view-layer: true` is required to avoid a 401 — user-agent,
 *     x-client-identifier, and x-ic-qp each individually made no difference.
 *   - A session cookie IS required for real data. Without one, the API
 *     returns HTTP 200 with `{ data: { noopQueryField: ... } }` — a
 *     placeholder, not an error — rather than actual search results.
 *   - `pageViewId` and `x-ic-qp` are per-request tracing IDs, not fixed
 *     session tokens — generating a fresh UUID per call works fine.
 *
 * Session cookie — obtained automatically, no manual capture needed:
 * a plain unauthenticated `GET https://www.aldi.us/` (a normal page load,
 * same as any visitor's first visit) issues a fresh `__Host-instacart_sid`
 * via `Set-Cookie`, and that alone is sufficient for real search results.
 * Verified across multiple independent fresh session + search cycles.
 * `_instacart_session_id` (present in the originally captured browser
 * cURL) turned out to be unnecessary — dropping it entirely still returns
 * full results, so it was never establishing anything session search
 * actually depends on. No login, no CAPTCHA, no JS execution, and no
 * cookie replay is involved: this is the same anonymous session bootstrap
 * every visitor's browser goes through, done with a plain HTTP GET.
 * getAldiSessionCookie() below caches the cookie in memory and
 * automatically re-establishes a fresh one if it's stale or if the API
 * signals an invalid session (`noopQueryField`).
 */

import type { ApiProduct, StoreLocation } from '../types/index.ts';
import { toTitleCase, hashCode } from '../utils/textFormat.ts';
import { withTimeout } from '../utils/withTimeout.ts';
import { TtlCache } from '../utils/ttlCache.ts';
import { createAldiLocator } from './locators/aldiLocator.ts';

const ALDI_HOME_URL = 'https://www.aldi.us/';
const ALDI_GRAPHQL_URL = 'https://www.aldi.us/graphql';
// Persisted-query hash for the SearchResultsPlacements operation — an API
// contract identifier, not a secret (same pattern as the GraphQL query text
// already hardcoded in traderJoesLiveScraper.ts/sproutsLiveScraper.ts).
const PERSISTED_QUERY_HASH =
  '6f8d4a3f450d8d25dbb87b6b5bcb82180a1b3c972366fb1fb7de816c05523f4a';

const productCache = new TtlCache<ApiProduct[]>(5 * 60 * 1000); // 5 min

// ── Session cookie — fetched once, reused, refreshed on expiry/invalidation ────
// Same shape as krogerLiveScraper.ts's token cache: a single current value
// plus its own expiry, not a multi-key TtlCache (there's only ever one).
let sessionCache: { cookie: string; expiresAt: number } | null = null;
const SESSION_REUSE_MS = 6 * 60 * 60 * 1000; // reuse for 6h; cookie itself is valid ~30 days server-side

async function establishAldiSession(): Promise<string> {
  const res = await fetch(ALDI_HOME_URL, { redirect: 'follow', cache: 'no-store' });
  await res.text().catch(() => undefined); // drain body

  if (!res.ok) {
    throw new Error(`Aldi session init failed: homepage returned HTTP ${res.status}`);
  }

  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const sidCookie = setCookies.find(c => c.startsWith('__Host-instacart_sid='));
  if (!sidCookie) {
    throw new Error('Aldi session init failed: no __Host-instacart_sid cookie was issued by the homepage response.');
  }

  return sidCookie.split(';')[0];
}

async function getAldiSessionCookie(forceRefresh = false): Promise<string> {
  if (!forceRefresh && sessionCache && Date.now() < sessionCache.expiresAt) {
    return sessionCache.cookie;
  }

  console.log('[Aldi] Establishing a fresh anonymous session...');
  const cookie = await establishAldiSession();
  sessionCache = { cookie, expiresAt: Date.now() + SESSION_REUSE_MS };
  console.log('[Aldi] Session established.');
  return cookie;
}

// ── Store locator ─────────────────────────────────────────────────────────────
// See locators/aldiLocator.ts — resolves the nearest real Aldi store via
// Aldi's own store-locator endpoint, sharing this same session cache.
const aldiLocator = createAldiLocator(getAldiSessionCookie);

// ── Raw API shape (only fields we consume) ──────────────────────────────────
interface AldiPriceViewSection {
  priceString?: string;
  priceValueString?: string;
}
interface AldiPrice {
  viewSection?: AldiPriceViewSection;
}
interface AldiItemImage {
  url?: string;
}
interface AldiTrackingProperties {
  product_category_name?: string;
}
interface AldiItemViewSection {
  itemImage?: AldiItemImage;
  trackingProperties?: AldiTrackingProperties;
}
interface AldiAvailability {
  available?: boolean;
}
export interface AldiItem {
  productId?: string;
  id?: string;
  name?: string;
  brandName?: string;
  size?: string;
  price?: AldiPrice;
  availability?: AldiAvailability;
  viewSection?: AldiItemViewSection;
}
interface AldiContent {
  items?: AldiItem[];
}
export interface AldiPlacement {
  content?: AldiContent;
}
interface AldiSearchResponse {
  data?: {
    searchResultsPlacements?: {
      placements?: AldiPlacement[];
    };
    // Returned instead of real data when the session cookie is missing/invalid.
    noopQueryField?: unknown;
  };
}

export function normalizeAldiProduct(item: AldiItem, location?: StoreLocation): ApiProduct | null {
  const name = (item.name ?? '').trim();
  if (!name) return null;

  const priceStr = item.price?.viewSection?.priceValueString;
  const price = priceStr !== undefined ? parseFloat(priceStr) : NaN;
  if (!Number.isFinite(price) || price <= 0) return null;

  const productId = item.productId ?? item.id ?? '';
  const seed = hashCode(productId || name);
  const rating = Math.round((3.8 + (seed % 12) / 10) * 10) / 10;
  const reviewCount = 20 + (seed % 2000);

  return {
    id: `aldi-${productId || name}`,
    name: toTitleCase(name),
    brand: item.brandName ? toTitleCase(item.brandName) : '',
    price,
    image_url: item.viewSection?.itemImage?.url || undefined,
    rating,
    reviewCount,
    size: item.size ?? '',
    upc: undefined, // not present in this response schema
    isLiveData: true,
    store: 'Aldi',
    location,
    inStock: item.availability?.available ?? undefined,
    category: item.viewSection?.trackingProperties?.product_category_name || undefined,
  };
}

// Product items live inside whichever placements are item grids/carousels —
// checking for a populated `items` array is simpler and more robust than
// filtering on the placement's __typename.
export function extractItemsFromPlacements(placements: AldiPlacement[] | undefined): AldiItem[] {
  if (!placements) return [];
  return placements.flatMap(p => (Array.isArray(p.content?.items) ? p.content.items : []));
}

async function fetchSearchResults(
  query: string,
  resolvedPostalCode: string,
  shopId: string,
  zoneId: string,
  sessionCookie: string,
): Promise<AldiSearchResponse> {
  const variables = {
    action: null,
    query,
    pageViewId: crypto.randomUUID(), // per-request tracing ID, not a fixed session token
    elevatedProductId: null,
    searchSource: 'search',
    filters: [],
    disableReformulation: false,
    disableLlm: false,
    forceInspiration: false,
    orderBy: 'bestMatch',
    clusterId: null,
    includeDebugInfo: false,
    clusteringStrategy: null,
    contentManagementSearchParams: { itemGridColumnCount: 5 },
    shopId,
    postalCode: resolvedPostalCode,
    zoneId,
    first: 30,
  };
  const extensions = { persistedQuery: { version: 1, sha256Hash: PERSISTED_QUERY_HASH } };

  const url = new URL(ALDI_GRAPHQL_URL);
  url.searchParams.set('operationName', 'SearchResultsPlacements');
  url.searchParams.set('variables', JSON.stringify(variables));
  url.searchParams.set('extensions', JSON.stringify(extensions));

  const res = await fetch(url.toString(), {
    headers: {
      accept: '*/*',
      'content-type': 'application/json',
      'x-ic-view-layer': 'true',
      cookie: sessionCookie,
    },
    cache: 'no-store',
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Aldi API failed (${res.status}): ${text.slice(0, 200)}`);
  }

  return (await res.json()) as AldiSearchResponse;
}

// ── Main search function ──────────────────────────────────────────────────────
export async function searchAldi(
  query: string,
  postalCode?: string,
): Promise<ApiProduct[]> {
  if (!postalCode) {
    throw new Error('Aldi search failed: a postal code is required to find the nearest store.');
  }

  const storeLocation = await aldiLocator.findNearestStore(postalCode);
  if (!storeLocation?.storeId) {
    console.log(`[Aldi] No Aldi location found near ${postalCode}`);
    return [];
  }
  const shopId = storeLocation.storeId;
  // Confirmed live: the zone filter can be omitted entirely (an empty
  // string) without affecting results — it isn't tied to a specific shop.
  const zoneId = '';

  const cacheKey = `${query.toLowerCase().trim()}|${postalCode}|${shopId}`;
  const cached = productCache.get(cacheKey);
  if (cached) {
    console.log(`[Aldi] Cache hit for "${query}"`);
    return cached;
  }

  console.log(`[Aldi] Live fetch for "${query}" @ postal ${postalCode}, shop ${shopId} (${storeLocation.name})`);

  let sessionCookie = await getAldiSessionCookie();
  let json = await fetchSearchResults(query, postalCode, shopId, zoneId, sessionCookie);

  // Self-heal once: a cached session can go stale between requests even
  // within its reuse window — if the API signals an invalid session,
  // force a fresh one and retry exactly once before giving up.
  if (json.data?.noopQueryField !== undefined) {
    console.log('[Aldi] Session appears stale — establishing a new one and retrying once.');
    sessionCookie = await getAldiSessionCookie(true);
    json = await fetchSearchResults(query, postalCode, shopId, zoneId, sessionCookie);
  }

  if (json.data?.noopQueryField !== undefined) {
    throw new Error(
      'Aldi API returned an empty placeholder response even after establishing a fresh session — ' +
      'the search flow itself may have changed upstream.',
    );
  }

  const rawItems = extractItemsFromPlacements(json.data?.searchResultsPlacements?.placements);
  console.log(`[Aldi] Raw: ${rawItems.length} items from API`);

  const products = rawItems
    .map(item => normalizeAldiProduct(item, storeLocation))
    .filter((p): p is ApiProduct => p !== null);

  console.log(`[Aldi] ${products.length} mapped products for "${query}"`);
  // Debug output — trace the ZIP → store → product-count pipeline at a glance.
  console.log(
    `[Aldi][debug] zip=${postalCode} -> store="${storeLocation.name}" id=${shopId} ` +
      `address="${storeLocation.address}, ${storeLocation.city}, ${storeLocation.state} ${storeLocation.zip}" ` +
      `lat=${storeLocation.latitude ?? '?'} lng=${storeLocation.longitude ?? '?'} products=${products.length}`,
  );
  productCache.set(cacheKey, products);
  return products;
}

// ── Timeout wrapper ───────────────────────────────────────────────────────────
export function searchAldiWithTimeout(
  query: string,
  postalCode: string | undefined,
  timeoutMs: number,
): Promise<ApiProduct[]> {
  return withTimeout(searchAldi(query, postalCode), timeoutMs, 'Aldi search');
}

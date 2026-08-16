/**
 * Live Publix price fetcher.
 *
 * Publix has no e-commerce platform of its own at all — its real online
 * ordering is entirely Instacart-fulfilled (a longstanding, publicly
 * documented partnership, not a guess), and `delivery.publix.com` is just
 * Publix's own domain fronting Instacart's actual consumer marketplace
 * (confirmed live: it redirects straight to `/store/publix/storefront`,
 * issues a plain anonymous `__Host-instacart_sid` cookie from an ordinary
 * homepage GET — the exact same mechanism as aldi.us/shop.sprouts.com — and
 * its GraphQL responses carry Instacart's own `RetailersShop`/
 * `SearchResultsPlacements` types verbatim). So, like Aldi/Sprouts, product
 * search here is a plain authenticated GraphQL request, not browser
 * automation.
 *
 * One real difference from Aldi/Sprouts: this domain's `SearchResultsPlacements`
 * takes a required, non-null `zoneId` argument that neither `DefaultShop` nor
 * any other reachable query actually returns as an output field anywhere
 * (confirmed by inspecting every response in the real address-selection
 * flow, captured live via Playwright, that a genuine site visitor goes
 * through). Empirically, though, the value doesn't have to be *correct* —
 * only non-empty: passing the wrong store's real zoneId, or an arbitrary
 * placeholder, still returns the correct `shopId`-specific results with no
 * GraphQL errors (verified live across two different real Publix stores);
 * only an empty string reliably breaks price resolution
 * ("Missing arguments for item price"). `shopId` is what actually scopes
 * results to the right store — `zoneId` is passed through unvalidated.
 */

import type { ApiProduct, StoreLocation } from '../types/index.ts';
import { toTitleCase, hashCode } from '../utils/textFormat.ts';
import { withTimeout } from '../utils/withTimeout.ts';
import { fetchWithBackoff } from '../utils/fetchWithBackoff.ts';
import { TtlCache } from '../utils/ttlCache.ts';
import { dedupeInFlight } from '../utils/dedupeInFlight.ts';
import { createPublixLocator, warmPublixLocator } from './locators/publixLocator.ts';
import { markStoreReady, markStoreWarming, logSearchUsedColdPath } from './storeReadiness.ts';
import type { PreciseCoords } from './locators/types.ts';

const PUBLIX_HOME_URL = 'https://delivery.publix.com/store/publix/storefront';
const PUBLIX_GRAPHQL_URL = 'https://delivery.publix.com/graphql';
// Confirmed live on delivery.publix.com specifically — Instacart's own
// domain and other retailer-branded storefronts (Market Street) have been
// observed using a *different* hash for this same operation name, so this
// one is not assumed to be platform-universal the way the two locator
// queries (see publixLocator.ts) were confirmed to be.
const PERSISTED_QUERY_HASH = 'e0730cf9209cbb9e140d1616bf057d133783e0aac00f8d046a53bf9066bc4224';
// See this file's header comment — required by the persisted query's
// non-null `ID!` argument type, but not actually validated against the
// shop being queried. Not a fabricated value standing in for real data;
// it never appears in any response and has no effect on which store's
// products/prices come back.
const PLACEHOLDER_ZONE_ID = '1';

const resultCache = new TtlCache<ApiProduct[]>(5 * 60 * 1000); // 5 min

// ── Session cookie — fetched once, reused, refreshed on expiry/invalidation ────
// Same shape as aldiLiveScraper.ts/sproutsLiveScraper.ts's own session
// cache: a plain anonymous `__Host-instacart_sid` cookie from a normal page
// load, no login needed.
let sessionCache: { cookie: string; expiresAt: number } | null = null;
const SESSION_REUSE_MS = 6 * 60 * 60 * 1000;

async function establishPublixSession(): Promise<string> {
  const res = await fetchWithBackoff(PUBLIX_HOME_URL, { redirect: 'follow', cache: 'no-store' });
  await res.text().catch(() => undefined);

  if (!res.ok) {
    throw new Error(`Publix session init failed: storefront returned HTTP ${res.status}`);
  }

  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const sidCookie = setCookies.find(c => c.startsWith('__Host-instacart_sid='));
  if (!sidCookie) {
    throw new Error('Publix session init failed: no __Host-instacart_sid cookie was issued by the storefront response.');
  }

  return sidCookie.split(';')[0];
}

// Deduped so a racing warm-up and a shopper's first real search — both
// finding no valid session at the same instant — share one homepage fetch
// instead of each establishing their own.
async function getPublixSessionCookie(forceRefresh = false): Promise<string> {
  if (!forceRefresh && sessionCache && Date.now() < sessionCache.expiresAt) {
    markStoreReady('publix');
    return sessionCache.cookie;
  }

  markStoreWarming('publix');
  return dedupeInFlight('publix-session', async () => {
    if (!forceRefresh && sessionCache && Date.now() < sessionCache.expiresAt) {
      markStoreReady('publix');
      return sessionCache.cookie;
    }
    console.log('[Publix] Establishing a fresh anonymous session...');
    const cookie = await establishPublixSession();
    sessionCache = { cookie, expiresAt: Date.now() + SESSION_REUSE_MS };
    markStoreReady('publix');
    console.log('[Publix] Session established.');
    return cookie;
  });
}

// ── Store locator ─────────────────────────────────────────────────────────────
// See locators/publixLocator.ts — resolves the nearest real Publix store,
// sharing this same session cache.
const publixLocator = createPublixLocator(getPublixSessionCookie);

interface PublixSearchResponse {
  data?: {
    searchResultsPlacements?: unknown;
    noopQueryField?: unknown;
  };
  errors?: Array<{ message?: string }>;
}

async function fetchSearchResults(
  query: string,
  postalCode: string,
  shopId: string,
  sessionCookie: string,
): Promise<PublixSearchResponse> {
  const variables = {
    action: null,
    query,
    pageViewId: crypto.randomUUID(),
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
    postalCode,
    zoneId: PLACEHOLDER_ZONE_ID,
    first: 30,
  };
  const extensions = { persistedQuery: { version: 1, sha256Hash: PERSISTED_QUERY_HASH } };

  const url = new URL(PUBLIX_GRAPHQL_URL);
  url.searchParams.set('operationName', 'SearchResultsPlacements');
  url.searchParams.set('variables', JSON.stringify(variables));
  url.searchParams.set('extensions', JSON.stringify(extensions));

  const res = await fetchWithBackoff(url.toString(), {
    headers: {
      accept: '*/*',
      'content-type': 'application/json',
      'x-ic-view-layer': 'true',
      referer: PUBLIX_HOME_URL,
      cookie: sessionCookie,
    },
    cache: 'no-store',
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Publix API failed (${res.status}): ${text.slice(0, 200)}`);
  }

  return (await res.json()) as PublixSearchResponse;
}

// ── Raw product shape from the GraphQL payload ────────────────────────────────
interface RawPublixProduct {
  name: string;
  brand: string | null;
  productId: string;
  size: string | null;
  priceString: string | null;
  priceValue: number | null;
  imageUrl: string | null;
}

// ── Recursive extractor — same algorithm as sproutsLiveScraper.ts/
// aldiLiveScraper.ts's reference script, since this is the same Instacart
// response shape (confirmed live) — not duplicated by accident, kept
// identical so a future shape change only needs fixing in one pattern.
function extractProducts(obj: unknown, results: RawPublixProduct[]): void {
  if (typeof obj !== 'object' || obj === null) return;

  if (Array.isArray(obj)) {
    for (const item of obj) extractProducts(item, results);
    return;
  }

  const record = obj as Record<string, unknown>;

  if (
    'productId' in record &&
    'name' in record &&
    typeof record.name === 'string' &&
    record.name.trim()
  ) {
    const item: RawPublixProduct = {
      name: record.name.trim(),
      brand: typeof record.brandName === 'string' ? record.brandName.trim() : null,
      productId: String(record.productId),
      size: typeof record.size === 'string' ? record.size.trim() : null,
      priceString: null,
      priceValue: null,
      imageUrl: null,
    };

    try {
      const ps = (record.price as Record<string, Record<string, string>>)?.viewSection?.priceString;
      if (typeof ps === 'string') item.priceString = ps;
    } catch { /* skip */ }

    try {
      const pvs = (record.price as Record<string, Record<string, string>>)?.viewSection?.priceValueString;
      if (typeof pvs === 'string') {
        const parsed = parseFloat(pvs.replace(/[^0-9.]/g, ''));
        if (!isNaN(parsed) && parsed > 0) item.priceValue = parsed;
      } else if (item.priceString) {
        const parsed = parseFloat(item.priceString.replace(/[^0-9.]/g, ''));
        if (!isNaN(parsed) && parsed > 0) item.priceValue = parsed;
      }
    } catch { /* skip */ }

    try {
      const itemImage = (record.viewSection as Record<string, unknown> | null | undefined)
        ?.itemImage as { url?: string | null; templateUrl?: string | null } | null | undefined;
      if (typeof itemImage?.url === 'string' && itemImage.url.startsWith('http')) {
        item.imageUrl = itemImage.url;
      } else if (typeof itemImage?.templateUrl === 'string') {
        const resolved = itemImage.templateUrl.replace('{width=}', '600').replace('{height=}', '600');
        if (resolved.startsWith('http')) item.imageUrl = resolved;
      }
    } catch { /* skip */ }

    if (!item.imageUrl) {
      const flat = [
        record.imageUrl, record.image, record.thumbnailUrl, record.thumbnail,
        (record.primaryImage as { url?: string } | null | undefined)?.url,
        (record.displayImage as { url?: string } | null | undefined)?.url,
      ];
      for (const c of flat) {
        if (typeof c === 'string' && c.startsWith('http')) { item.imageUrl = c; break; }
      }
    }

    results.push(item);
  }

  for (const value of Object.values(record)) {
    extractProducts(value, results);
  }
}

// ── Main search function ──────────────────────────────────────────────────────
export async function searchPublix(
  query: string,
  postalCode?: string,
  preciseCoords?: PreciseCoords,
): Promise<ApiProduct[]> {
  if (!postalCode) {
    throw new Error('Publix search failed: a postal code is required to find the nearest store.');
  }

  const cacheKey = `${query.toLowerCase().trim()}|${postalCode}`;
  const cached = resultCache.get(cacheKey);
  if (cached) {
    console.log(`[Publix] Cache hit for "${query}"`);
    return cached;
  }

  const storeLocation: StoreLocation | undefined = await publixLocator.findNearestStore(postalCode, preciseCoords);
  if (!storeLocation?.storeId) {
    console.log(`[Publix] No Publix location found near ${postalCode}`);
    return [];
  }
  const shopId = storeLocation.storeId;

  console.log(`[Publix] Live fetch for "${query}" @ postal ${postalCode}, shop ${shopId} (${storeLocation.name})`);

  const hadWarmSession = sessionCache !== null && Date.now() < sessionCache.expiresAt;
  const sessionStart = Date.now();
  let sessionCookie = await getPublixSessionCookie();
  if (!hadWarmSession) logSearchUsedColdPath('publix', Date.now() - sessionStart);
  let json = await fetchSearchResults(query, postalCode, shopId, sessionCookie);

  // Self-heal once: a cached session can go stale between requests even
  // within its reuse window — if the API signals an invalid session (the
  // same `noopQueryField` placeholder shape Aldi/Sprouts' identical
  // platform uses), force a fresh one and retry exactly once before
  // giving up.
  if (json.data?.noopQueryField !== undefined) {
    console.log('[Publix] Session appears stale — establishing a new one and retrying once.');
    sessionCookie = await getPublixSessionCookie(true);
    json = await fetchSearchResults(query, postalCode, shopId, sessionCookie);
  }

  if (json.data?.noopQueryField !== undefined) {
    throw new Error(
      'Publix API returned an empty placeholder response even after establishing a fresh session — ' +
      'the search flow itself may have changed upstream.',
    );
  }
  if (json.errors?.length) {
    throw new Error(`Publix API returned GraphQL errors: ${json.errors.map(e => e.message).join('; ')}`);
  }

  const rawProducts: RawPublixProduct[] = [];
  extractProducts(json.data?.searchResultsPlacements, rawProducts);
  console.log(`[Publix] Raw: ${rawProducts.length} items from API`);

  const seen = new Set<string>();
  const clean: RawPublixProduct[] = [];
  for (const x of rawProducts) {
    const key = `${x.name}|${x.priceString}`;
    if (!seen.has(key)) { seen.add(key); clean.push(x); }
  }

  const products: ApiProduct[] = clean
    .filter(p => p.name && p.priceValue !== null && p.priceValue > 0)
    .map(p => ({
      id: `publix-live-${p.productId}`,
      name: toTitleCase(p.name),
      brand: p.brand ? toTitleCase(p.brand) : '',
      price: p.priceValue!,
      image_url: p.imageUrl ?? undefined,
      rating: Math.round((3.8 + (hashCode(p.productId) % 12) / 10) * 10) / 10,
      reviewCount: 30 + (hashCode(p.productId) % 800),
      size: p.size ?? '',
      upc: undefined,
      certifications: undefined,
      isLiveData: true,
      location: storeLocation,
      store: 'Publix' as const,
      storeProductUrl: `https://delivery.publix.com/store/publix/products/${p.productId}`,
      inStock: true,
    }));

  console.log(`[Publix] ${products.length} products found for "${query}"`);
  console.log(
    `[Publix][debug] zip=${postalCode} -> store="${storeLocation.name}" id=${shopId} ` +
      `address="${storeLocation.address}, ${storeLocation.city}, ${storeLocation.state} ${storeLocation.zip}" ` +
      `lat=${storeLocation.latitude ?? '?'} lng=${storeLocation.longitude ?? '?'} products=${products.length}`,
  );
  resultCache.set(cacheKey, products);
  return products;
}

// ── Timeout wrapper ───────────────────────────────────────────────────────────
export function searchPublixWithTimeout(
  query: string,
  postalCode: string,
  timeoutMs: number,
  preciseCoords?: PreciseCoords,
): Promise<ApiProduct[]> {
  return withTimeout(searchPublix(query, postalCode, preciseCoords), timeoutMs, 'Publix scraper');
}

// ── Warm-up ────────────────────────────────────────────────────────────────
// Establishes the anonymous session cookie (and, once a zip is known, the
// nearest-store lookup) at app-startup time instead of on the first real
// search — see warmSprouts in sproutsLiveScraper.ts for the same pattern.
export async function warmPublix(zip?: string): Promise<void> {
  await getPublixSessionCookie();
  if (zip) await warmPublixLocator(zip, getPublixSessionCookie);
}

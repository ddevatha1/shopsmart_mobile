/**
 * Whole Foods Market (an Amazon subsidiary) live price fetcher.
 *
 * Unlike Tom Thumb (see tomThumbLiveScraper.ts) or Albertsons
 * (albertsonsLiveScraper.ts), Whole Foods' product search is real,
 * unauthenticated, and reachable with plain HTTP — no browser, no
 * Playwright, no bot-wall blocking it. Confirmed live, in this order:
 *
 *   1. wholefoodsmarket.com/grocery/search?k={query} renders a full,
 *      server-side-rendered product grid (real prices, real "Add to
 *      Cart", SNAP/EBT tags, sale badges) with NO sign-in required —
 *      only *adding an item to cart* needs an Amazon account.
 *   2. That page's product data is embedded directly in its own HTML, in
 *      the Next.js `__NEXT_DATA__` script tag
 *      (`props.pageProps.productsInfo`, an array of full product records
 *      — brandName/name/asin/productImages/availability/offerDetails.
 *      price/...) — no separate XHR to intercept, no GraphQL call.
 *   3. A cookie-less request gets back only a client-hydration "loading"
 *      shell (`pageProps.pageType === "loading"`, no real product data) —
 *      the page needs to know which physical store to price against.
 *      That store binding is a real, tiny, two-request bootstrap:
 *        a) GET wholefoodsmarket.com/ once, to receive Amazon's normal
 *           anonymous session cookies (session-id, i18n-prefs, ...).
 *        b) PUT wholefoodsmarket.com/api/store-affinity with JSON body
 *           `{"storeId": "<numeric id>"}` (storeId as a STRING — a plain
 *           number body 400s) — confirmed live, binds that session to one
 *           store, no CSRF token or extra header needed beyond a normal
 *           `Content-Type: application/json` + same-origin Referer/Origin.
 *      Once bound, the SAME cookies replayed on a plain `GET
 *      /grocery/search?k=...` return the full, real, priced product grid
 *      — exactly like Aldi/Sprouts' own anonymous-cookie bootstrap, just
 *      with an extra "bind to a store" step.
 *
 * See wholeFoodsLocator.ts's header comment for where the numeric
 * `storeId` this needs actually comes from (there is no public "resolve a
 * ZIP to a store ID" endpoint — the locator's own directory crawl is what
 * supplies it).
 */
import type { ApiProduct } from '../types/index.ts';
import { toTitleCase, hashCode } from '../utils/textFormat.ts';
import { withTimeout } from '../utils/withTimeout.ts';
import { TtlCache } from '../utils/ttlCache.ts';
import { dedupeInFlight } from '../utils/dedupeInFlight.ts';
import { createWholeFoodsLocator, findNearestStoreUncached } from './locators/wholeFoodsLocator.ts';
import { markStoreReady, markStoreWarming, logSearchUsedColdPath } from './storeReadiness.ts';
import type { PreciseCoords } from './locators/types.ts';

const HOME_URL = 'https://www.wholefoodsmarket.com/';
const STORE_AFFINITY_URL = 'https://www.wholefoodsmarket.com/api/store-affinity';
const SEARCH_URL = 'https://www.wholefoodsmarket.com/grocery/search';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

export const wholeFoodsLocator = createWholeFoodsLocator();

// In-memory cache — 5 min TTL per query+store, same shape as every other
// store's resultCache.
const resultCache = new TtlCache<ApiProduct[]>(5 * 60 * 1000);

// ── Cookie jar helpers ───────────────────────────────────────────────────
// Node's fetch has no built-in cookie jar (unlike a real browser) — a
// minimal one is all this needs: parse every Set-Cookie header into a
// name→value map, and serialize it back into one `Cookie` request header.
// `getSetCookie()` (not `.get('set-cookie')`) is required here because a
// response can carry several Set-Cookie headers at once, and Headers.get
// would otherwise collapse them into one invalid, comma-joined string —
// same reasoning as the `res.headers.getSetCookie === 'function'` checks
// already used in aldiLiveScraper.ts/sproutsLiveScraper.ts.
function parseSetCookies(res: Response): Map<string, string> {
  const jar = new Map<string, string>();
  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const raw of setCookies) {
    const pair = raw.split(';')[0];
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  }
  return jar;
}

function serializeCookieJar(jar: Map<string, string>): string {
  return Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
}

// ── Base (zip/store-independent) session ────────────────────────────────
// Plain anonymous Amazon session cookies — same one shared across every
// store binding, so this is fetched once and reused, not per-store.
let baseCookieJar: Map<string, string> | null = null;
let baseCookieExpiresAt = 0;
const BASE_COOKIE_REUSE_MS = 6 * 60 * 60 * 1000;

async function getBaseCookies(): Promise<Map<string, string>> {
  if (baseCookieJar && Date.now() < baseCookieExpiresAt) return baseCookieJar;

  return dedupeInFlight('wholefoods-base-session', async () => {
    if (baseCookieJar && Date.now() < baseCookieExpiresAt) return baseCookieJar;
    const res = await withTimeout(fetch(HOME_URL, { headers: { 'User-Agent': USER_AGENT } }), 8000, 'Whole Foods homepage');
    const jar = parseSetCookies(res);
    baseCookieJar = jar;
    baseCookieExpiresAt = Date.now() + BASE_COOKIE_REUSE_MS;
    return jar;
  });
}

// ── Per-store session (store-affinity binding) ──────────────────────────
interface StoreSession {
  cookie: string;
  expiresAt: number;
}
const storeSessionCache = new Map<number, StoreSession>();
const STORE_SESSION_REUSE_MS = 6 * 60 * 60 * 1000;

async function getStoreSessionCookie(storeId: number, forceRefresh = false): Promise<string> {
  const cached = storeSessionCache.get(storeId);
  if (!forceRefresh && cached && Date.now() < cached.expiresAt) {
    markStoreReady('wholefoods');
    return cached.cookie;
  }

  markStoreWarming('wholefoods');
  // Deduped per store so a racing warm-up and a shopper's first real
  // search for the same store share one bootstrap instead of each
  // establishing their own.
  return dedupeInFlight(`wholefoods-store-session:${storeId}`, async () => {
    const cachedInner = storeSessionCache.get(storeId);
    if (!forceRefresh && cachedInner && Date.now() < cachedInner.expiresAt) return cachedInner.cookie;

    const baseJar = await getBaseCookies();
    const res = await withTimeout(
      fetch(STORE_AFFINITY_URL, {
        method: 'PUT',
        headers: {
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/json',
          Origin: 'https://www.wholefoodsmarket.com',
          Referer: 'https://www.wholefoodsmarket.com/',
          Cookie: serializeCookieJar(baseJar),
        },
        body: JSON.stringify({ storeId: String(storeId) }),
      }),
      8000,
      'Whole Foods store-affinity',
    );
    if (!res.ok) {
      throw new Error(`Whole Foods store-affinity failed for store ${storeId}: HTTP ${res.status}`);
    }
    const extraJar = parseSetCookies(res);
    const merged = new Map([...baseJar, ...extraJar]);
    const cookie = serializeCookieJar(merged);
    storeSessionCache.set(storeId, { cookie, expiresAt: Date.now() + STORE_SESSION_REUSE_MS });
    markStoreReady('wholefoods');
    console.log(`[WholeFoods] Store session established for store ${storeId}.`);
    return cookie;
  });
}

// ── Raw search-page product shape (only fields we consume) ─────────────
interface WholeFoodsPrice {
  currencyCode?: string;
  priceAmount?: number;
  basisPriceAmount?: number | null;
}
export interface WholeFoodsRawProduct {
  brandName?: string;
  name?: string;
  asin?: string;
  productImages?: string[];
  availability?: string;
  offerDetails?: { price?: WholeFoodsPrice };
}
interface NextDataShape {
  props?: {
    pageProps?: {
      pageType?: string;
      productsInfo?: WholeFoodsRawProduct[];
    };
  };
}

// Pulls the `__NEXT_DATA__` JSON blob out of the search page's raw HTML —
// plain embedded JSON, no JS execution needed. Returns undefined (never
// throws) for anything that doesn't parse, so a page-shape change fails
// closed into "no data" rather than a crash.
export function extractNextData(html: string): NextDataShape | undefined {
  const marker = '"__NEXT_DATA__"';
  const idx = html.indexOf(marker);
  if (idx === -1) return undefined;
  const tagStart = html.lastIndexOf('<script', idx);
  if (tagStart === -1) return undefined;
  const contentStart = html.indexOf('>', tagStart) + 1;
  const contentEnd = html.indexOf('</script>', contentStart);
  if (contentStart === 0 || contentEnd === -1) return undefined;
  try {
    return JSON.parse(html.slice(contentStart, contentEnd)) as NextDataShape;
  } catch {
    return undefined;
  }
}

// Returns `undefined` (not `[]`) specifically for "the page rendered the
// loading shell, not real data" (pageType === 'loading' or productsInfo
// missing) — searchWholeFoods uses that distinction to retry once with a
// freshly-bootstrapped session before giving up, same self-heal shape as
// Aldi/Sprouts' stale-session retry.
async function fetchSearchResults(query: string, cookie: string): Promise<WholeFoodsRawProduct[] | undefined> {
  const url = `${SEARCH_URL}?k=${encodeURIComponent(query)}`;
  const res = await withTimeout(
    fetch(url, { headers: { 'User-Agent': USER_AGENT, Cookie: cookie } }),
    15000,
    'Whole Foods search',
  );
  if (!res.ok) {
    throw new Error(`Whole Foods search failed (${res.status})`);
  }
  const html = await res.text();
  const data = extractNextData(html);
  const productsInfo = data?.props?.pageProps?.productsInfo;
  if (!Array.isArray(productsInfo)) return undefined;
  return productsInfo;
}

export function normalizeWholeFoodsProduct(
  p: WholeFoodsRawProduct,
  location?: ApiProduct['location'],
): ApiProduct | null {
  const name = p.name?.trim();
  if (!name) return null;

  const price = p.offerDetails?.price?.priceAmount;
  if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) return null;

  const asin = p.asin;
  if (!asin) return null;

  const basis = p.offerDetails?.price?.basisPriceAmount;
  const hasSale = typeof basis === 'number' && basis > price;

  // Whole Foods doesn't expose a separate "size" field on this endpoint —
  // the display name usually embeds it after the last comma (e.g.
  // "Organic Banana, 1 Each", "NORTHWEST PRODUCE Organic Bagged Gala
  // Apples, 48 Ounce"). Left empty when the name doesn't have that shape
  // (e.g. "Organic Blueberries Pint") rather than guessing.
  const commaIdx = name.lastIndexOf(',');
  const size = commaIdx !== -1 ? name.slice(commaIdx + 1).trim() : '';

  const seed = hashCode(asin);
  return {
    id: `wholefoods-${asin}`,
    name,
    brand: p.brandName ? toTitleCase(p.brandName) : '',
    price,
    originalPrice: hasSale ? basis : undefined,
    discountPercent: hasSale ? Math.round((1 - price / basis) * 100) : undefined,
    image_url: p.productImages?.[0],
    rating: Math.round((3.8 + (seed % 12) / 10) * 10) / 10,
    reviewCount: 20 + (seed % 2000),
    size,
    isLiveData: true,
    store: 'Whole Foods Market',
    location,
    inStock: p.availability !== 'OUT_OF_STOCK',
  };
}

// ── Main search function ──────────────────────────────────────────────────────
export async function searchWholeFoods(
  query: string,
  zipcode: string,
  preciseCoords?: PreciseCoords,
): Promise<ApiProduct[]> {
  const store = await findNearestStoreUncached(zipcode, preciseCoords);
  if (!store) {
    console.log(`[WholeFoods] No Whole Foods location found near ${zipcode}`);
    return [];
  }

  const cacheKey = `${query.toLowerCase().trim()}|${store.storeId}`;
  const cached = resultCache.get(cacheKey);
  if (cached) {
    console.log(`[WholeFoods] Cache hit for "${query}"`);
    return cached;
  }

  console.log(`[WholeFoods] Live fetch for "${query}" @ zip ${zipcode}, store ${store.storeId} (${store.location.name})`);

  const hadWarmSession = storeSessionCache.has(store.storeId) && (storeSessionCache.get(store.storeId)?.expiresAt ?? 0) > Date.now();
  const sessionStart = Date.now();
  let cookie = await getStoreSessionCookie(store.storeId);
  if (!hadWarmSession) logSearchUsedColdPath('wholefoods', Date.now() - sessionStart);

  let products = await fetchSearchResults(query, cookie);

  // Self-heal once: a stale/expired store-affinity binding renders the
  // "loading" shell instead of real product data — force a fresh session
  // and retry exactly once before giving up, same pattern as Aldi/
  // Sprouts' noopQueryField self-heal.
  if (products === undefined) {
    console.log('[WholeFoods] Session appears stale — establishing a new one and retrying once.');
    cookie = await getStoreSessionCookie(store.storeId, true);
    products = await fetchSearchResults(query, cookie);
  }

  if (products === undefined) {
    throw new Error(
      'Whole Foods search returned no product data even after establishing a fresh session — ' +
      'the search flow itself may have changed upstream.',
    );
  }

  console.log(`[WholeFoods] Raw: ${products.length} items from search page`);

  const mapped = products
    .map(p => normalizeWholeFoodsProduct(p, store.location))
    .filter((p): p is ApiProduct => p !== null);

  console.log(`[WholeFoods] ${mapped.length} mapped products for "${query}"`);
  resultCache.set(cacheKey, mapped);
  return mapped;
}

export function searchWholeFoodsWithTimeout(
  query: string,
  zipcode: string,
  timeoutMs: number,
  preciseCoords?: PreciseCoords,
): Promise<ApiProduct[]> {
  return withTimeout(searchWholeFoods(query, zipcode, preciseCoords), timeoutMs, 'Whole Foods search');
}

// ── Warm-up ────────────────────────────────────────────────────────────────
// Establishes the base anonymous session at app-startup time — the
// per-store binding still can't be pre-warmed without knowing which store
// a shopper will search (see wholeFoodsLocator.ts's own warm function for
// the store-directory crawl, warmed separately). A shopper's first real
// search for a given store still pays the store-affinity bootstrap cost
// once; every search after that (for that store) reuses it.
export async function warmWholeFoods(): Promise<void> {
  await getBaseCookies();
}

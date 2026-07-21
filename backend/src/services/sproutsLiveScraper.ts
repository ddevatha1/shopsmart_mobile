/**
 * Live Sprouts price fetcher.
 *
 * Sprouts runs on the same Instacart-backed ordering platform as Aldi
 * (confirmed live: identical GraphQL endpoint shape, identical persisted
 * query hash, identical session-cookie auth) — so, like Aldi, product
 * search is a plain authenticated GraphQL request, not browser automation.
 *
 * This used to drive a full Playwright browser instead (visit storefront,
 * dismiss the store-picker modal, navigate to the search URL, intercept the
 * GraphQL response). That approach is what's replaced here, for a specific
 * reason: it never actually followed the shopper's ZIP. Sprouts resolves
 * "which store is active" server-side from the request's real IP address,
 * not from the browser's spoofed `navigator.geolocation` — verified live by
 * setting Playwright's geolocation to Chicago and confirming the site still
 * selected the same store as before. Every search was silently using
 * whichever store that server's real IP happens to be near, regardless of
 * what ZIP the shopper searched from.
 *
 * The fix (see locators/sproutsLocator.ts) is to resolve the nearest store
 * explicitly via Sprouts' own store-locator endpoint
 * (shop.sprouts.com/idp/v1/shops?postal_code=) and pass that store's ID
 * directly into the search request as an explicit variable — the same
 * store then drives both the returned products and the displayed address,
 * for any ZIP, not just whatever the server's own network happens to sit
 * near.
 */

import { chromium } from 'playwright';
import type { Browser, BrowserContext, Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import type { ApiProduct } from '../types/index.ts';
import { toTitleCase, hashCode } from '../utils/textFormat.ts';
import { withTimeout } from '../utils/withTimeout.ts';
import { TtlCache } from '../utils/ttlCache.ts';
import { createSproutsLocator } from './locators/sproutsLocator.ts';

const SESSION_PATH = path.join(process.cwd(), '.sprouts-session.json');
const SPROUTS_HOME_URL = 'https://shop.sprouts.com/';
const SPROUTS_GRAPHQL_URL = 'https://shop.sprouts.com/graphql';
// Same persisted-query hash as aldiLiveScraper.ts — both retailers run the
// same Instacart-backed SearchResultsPlacements operation.
const PERSISTED_QUERY_HASH =
  '6f8d4a3f450d8d25dbb87b6b5bcb82180a1b3c972366fb1fb7de816c05523f4a';

// In-memory cache — 5 min TTL per query+zip
const resultCache = new TtlCache<ApiProduct[]>(5 * 60 * 1000);

// ── Session cookie — fetched once, reused, refreshed on expiry/invalidation ────
// Same shape as aldiLiveScraper.ts's session cache: a plain anonymous
// `__Host-instacart_sid` cookie from a normal homepage GET, no login needed.
let sessionCache: { cookie: string; expiresAt: number } | null = null;
const SESSION_REUSE_MS = 6 * 60 * 60 * 1000;

async function establishSproutsSession(): Promise<string> {
  const res = await fetch(SPROUTS_HOME_URL, { redirect: 'follow', cache: 'no-store' });
  await res.text().catch(() => undefined);

  if (!res.ok) {
    throw new Error(`Sprouts session init failed: homepage returned HTTP ${res.status}`);
  }

  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const sidCookie = setCookies.find(c => c.startsWith('__Host-instacart_sid='));
  if (!sidCookie) {
    throw new Error('Sprouts session init failed: no __Host-instacart_sid cookie was issued by the homepage response.');
  }

  return sidCookie.split(';')[0];
}

async function getSproutsSessionCookie(forceRefresh = false): Promise<string> {
  if (!forceRefresh && sessionCache && Date.now() < sessionCache.expiresAt) {
    return sessionCache.cookie;
  }

  console.log('[Sprouts] Establishing a fresh anonymous session...');
  const cookie = await establishSproutsSession();
  sessionCache = { cookie, expiresAt: Date.now() + SESSION_REUSE_MS };
  console.log('[Sprouts] Session established.');
  return cookie;
}

// ── Store locator ─────────────────────────────────────────────────────────────
// See locators/sproutsLocator.ts — resolves the nearest real Sprouts store,
// sharing this same session cache.
const sproutsLocator = createSproutsLocator(getSproutsSessionCookie);

interface SproutsSearchResponse {
  data?: {
    searchResultsPlacements?: unknown;
    noopQueryField?: unknown;
  };
}

async function fetchSearchResults(
  query: string,
  postalCode: string,
  shopId: string,
  zoneId: string,
  sessionCookie: string,
): Promise<SproutsSearchResponse> {
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
    zoneId,
    first: 30,
  };
  const extensions = { persistedQuery: { version: 1, sha256Hash: PERSISTED_QUERY_HASH } };

  const url = new URL(SPROUTS_GRAPHQL_URL);
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
    throw new Error(`Sprouts API failed (${res.status}): ${text.slice(0, 200)}`);
  }

  return (await res.json()) as SproutsSearchResponse;
}

// ── Raw product shape from the GraphQL payload ────────────────────────────────
interface RawSproutsProduct {
  name: string;
  brand: string | null;
  productId: string;
  size: string | null;
  priceString: string | null;
  priceValue: number | null;
  imageUrl: string | null;
}

// ── Recursive extractor — identical algorithm to the Python script ─────────────
function extractProducts(obj: unknown, results: RawSproutsProduct[]): void {
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
    const item: RawSproutsProduct = {
      name: record.name.trim(),
      brand: typeof record.brandName === 'string' ? record.brandName.trim() : null,
      productId: String(record.productId),
      size: typeof record.size === 'string' ? record.size.trim() : null,
      priceString: null,
      priceValue: null,
      imageUrl: null,
    };

    try {
      const ps = (record.price as Record<string, Record<string, string>>)
        ?.viewSection?.priceString;
      if (typeof ps === 'string') item.priceString = ps;
    } catch { /* skip */ }

    try {
      const pvs = (record.price as Record<string, Record<string, string>>)
        ?.viewSection?.priceValueString;
      if (typeof pvs === 'string') {
        const parsed = parseFloat(pvs.replace(/[^0-9.]/g, ''));
        if (!isNaN(parsed) && parsed > 0) item.priceValue = parsed;
      }
    } catch { /* skip */ }

    // Image URL — the real photo Sprouts' own page shows for this product
    // lives at `viewSection.itemImage` (an Instacart-backed `Image` node
    // with a direct `url` and a templated `templateUrl`, e.g.
    // `.../image-server/{width=}x{height=}/.../large_<uuid>.png` — the
    // template needs {width=}/{height=} filled in before it's a usable
    // URL, so it's only used when the direct `url` is missing). This is
    // present on every item the live payload has been observed to
    // return; the `images[]`/flat-field checks below are kept only as a
    // defensive fallback for payload shapes not seen in practice.
    try {
      const itemImage = (record.viewSection as Record<string, unknown> | null | undefined)
        ?.itemImage as { url?: string | null; templateUrl?: string | null } | null | undefined;
      if (typeof itemImage?.url === 'string' && itemImage.url.startsWith('http')) {
        item.imageUrl = itemImage.url;
      } else if (typeof itemImage?.templateUrl === 'string') {
        const resolved = itemImage.templateUrl
          .replace('{width=}', '600')
          .replace('{height=}', '600');
        if (resolved.startsWith('http')) item.imageUrl = resolved;
      }
    } catch { /* skip */ }

    // Fallback: legacy/alternate Instacart field shapes, in case a future
    // payload variant omits viewSection.itemImage.
    try {
      const imgs = record.images as Array<{
        url?: string; src?: string;
        sizes?: Array<{ id: string; url: string }>;
      }> | undefined;
      if (!item.imageUrl && imgs?.length) {
        const first = imgs[0];
        if (typeof first.url === 'string' && first.url.startsWith('http')) {
          item.imageUrl = first.url;
        } else if (first.sizes?.length) {
          for (const pref of ['large', 'xlarge', 'medium', 'small', 'thumbnail']) {
            const s = first.sizes.find(sz => sz.id === pref);
            if (s?.url) { item.imageUrl = s.url; break; }
          }
          if (!item.imageUrl) item.imageUrl = first.sizes[0]?.url ?? null;
        } else if (typeof first.src === 'string') {
          item.imageUrl = first.src;
        }
      }
    } catch { /* skip */ }
    // Fallback: flat string fields and nested image objects
    if (!item.imageUrl) {
      const flat = [
        record.imageUrl, record.image, record.thumbnailUrl, record.thumbnail,
        record.photo, record.photoUrl, record.srcUrl,
        (record.primaryImage as { url?: string } | null | undefined)?.url,
        (record.displayImage as { url?: string } | null | undefined)?.url,
        (record.defaultImage as { url?: string } | null | undefined)?.url,
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

// ── Browser context factory ───────────────────────────────────────────────────
// Uses a realistic user-agent and disables automation-detection signals.
async function buildContext(browser: Browser): Promise<BrowserContext> {
  const baseOpts = {
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
    timezoneId: 'America/Chicago',
    geolocation: { latitude: 30.2672, longitude: -97.7431 }, // Austin TX
    permissions: ['geolocation'],
  };

  if (fs.existsSync(SESSION_PATH)) {
    try {
      return await browser.newContext({ ...baseOpts, storageState: SESSION_PATH });
    } catch { /* fall through */ }
  }
  return await browser.newContext(baseOpts);
}

// Patch navigator.webdriver so sites don't detect Playwright
async function stealthPage(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).cdc_adoQpoasnfa76pfcZLmcfl_Array;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).cdc_adoQpoasnfa76pfcZLmcfl_Promise;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).cdc_adoQpoasnfa76pfcZLmcfl_Symbol;
  });
}

// ── Main search function ──────────────────────────────────────────────────────
export async function searchSprouts(query: string, postalCode?: string): Promise<ApiProduct[]> {
  if (!postalCode) {
    throw new Error('Sprouts search failed: a postal code is required to find the nearest store.');
  }

  const cacheKey = `${query.toLowerCase().trim()}|${postalCode}`;
  const cached = resultCache.get(cacheKey);
  if (cached) {
    console.log(`[Sprouts] Cache hit for "${query}"`);
    return cached;
  }

  const storeLocation = await sproutsLocator.findNearestStore(postalCode);
  if (!storeLocation?.storeId) {
    console.log(`[Sprouts] No Sprouts location found near ${postalCode}`);
    return [];
  }
  const shopId = storeLocation.storeId;
  // Confirmed live: the zone filter can be omitted entirely (an empty
  // string), same as Aldi — it isn't tied to a specific shop.
  const zoneId = '';

  console.log(`[Sprouts] Live fetch for "${query}" @ postal ${postalCode}, shop ${shopId} (${storeLocation.name})`);

  let sessionCookie = await getSproutsSessionCookie();
  let json = await fetchSearchResults(query, postalCode, shopId, zoneId, sessionCookie);

  // Self-heal once: a cached session can go stale between requests even
  // within its reuse window — if the API signals an invalid session,
  // force a fresh one and retry exactly once before giving up.
  if (json.data?.noopQueryField !== undefined) {
    console.log('[Sprouts] Session appears stale — establishing a new one and retrying once.');
    sessionCookie = await getSproutsSessionCookie(true);
    json = await fetchSearchResults(query, postalCode, shopId, zoneId, sessionCookie);
  }

  if (json.data?.noopQueryField !== undefined) {
    throw new Error(
      'Sprouts API returned an empty placeholder response even after establishing a fresh session — ' +
      'the search flow itself may have changed upstream.',
    );
  }

  const rawProducts: RawSproutsProduct[] = [];
  extractProducts(json.data?.searchResultsPlacements, rawProducts);
  console.log(`[Sprouts] Raw: ${rawProducts.length} items from API`);

  // ── De-duplicate (same logic as the original Python reference script) ────
  const seen = new Set<string>();
  const clean: RawSproutsProduct[] = [];
  for (const x of rawProducts) {
    const key = `${x.name}|${x.priceString}`;
    if (!seen.has(key)) { seen.add(key); clean.push(x); }
  }

  // ── Map to ApiProduct ─────────────────────────────────────────────────────
  const products: ApiProduct[] = clean
    .filter(p => p.name && p.priceValue !== null && p.priceValue > 0)
    .map(p => ({
      id: `sprouts-live-${p.productId}`,
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
      store: 'Sprouts' as const,
      storeProductUrl: `https://shop.sprouts.com/store/sprouts/products/${p.productId}`,
      inStock: true,
    }));

  console.log(`[Sprouts] ${products.length} products found for "${query}"`);
  // Debug output — trace the ZIP → store → product-count pipeline at a glance.
  console.log(
    `[Sprouts][debug] zip=${postalCode} -> store="${storeLocation.name}" id=${shopId} ` +
      `address="${storeLocation.address}, ${storeLocation.city}, ${storeLocation.state} ${storeLocation.zip}" ` +
      `lat=${storeLocation.latitude ?? '?'} lng=${storeLocation.longitude ?? '?'} products=${products.length}`,
  );
  resultCache.set(cacheKey, products);
  return products;
}

// ── Timeout wrapper ───────────────────────────────────────────────────────────
export function searchSproutsWithTimeout(
  query: string,
  postalCode: string,
  timeoutMs: number,
): Promise<ApiProduct[]> {
  return withTimeout(searchSprouts(query, postalCode), timeoutMs, 'Sprouts scraper');
}

// ── Single-product image fetch ─────────────────────────────────────────────────
// Used by productImage.ts as an image-fallback tier: when a Sprouts listing
// came back from search without an image_url, this visits that exact
// product's own page (already known via storeProductUrl — no search
// needed) and reads whatever photo Sprouts' own site shows for it. Reuses
// the same context/session/stealth setup as the main scraper, but skips
// its GraphQL interception and modal-dismissal — a saved session already
// carries past the storefront modal, and a product page doesn't need it.
export async function fetchSproutsProductImage(
  productUrl: string,
  productName: string,
): Promise<string | null> {
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
      ],
    });

    const context = await buildContext(browser);
    const page = await context.newPage();
    await stealthPage(page);

    await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2500);

    // Every real product photo on Sprouts' site carries an `alt` equal to
    // the product name — the same signal the main scraper's DOM pass
    // matches on, just here compared directly to the name we already
    // have instead of a URL slug. Tracking pixels/icons have no alt text
    // and are filtered out by the size check.
    const imageUrl = await page.evaluate((name: string) => {
      const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      const targetWords = normalize(name).split(' ').filter(Boolean);
      if (targetWords.length === 0) return null;

      let best: { src: string; score: number } | null = null;
      for (const img of Array.from(document.querySelectorAll('img'))) {
        const src = img.currentSrc || img.src;
        if (!src || !src.startsWith('http') || src.includes('data:')) continue;
        if (img.naturalWidth < 200 || img.naturalHeight < 200) continue;
        const altWords = new Set(normalize(img.alt || '').split(' ').filter(Boolean));
        if (altWords.size === 0) continue;
        const matched = targetWords.filter(w => altWords.has(w)).length;
        const score = matched / targetWords.length;
        if (score > (best?.score ?? 0)) best = { src, score };
      }
      // Require near-complete word overlap — this is a same-site, exact
      // lookup (not a fuzzy third-party search), so a weak match here
      // means something's wrong rather than "close enough."
      return best && best.score >= 0.8 ? best.src : null;
    }, productName);

    return imageUrl;
  } catch (err) {
    console.warn('[Sprouts] product-image fetch failed:', err instanceof Error ? err.message : err);
    return null;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

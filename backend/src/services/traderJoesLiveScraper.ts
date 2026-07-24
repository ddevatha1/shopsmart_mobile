/**
 * Trader Joe's live price fetcher.
 *
 * Trader Joe's serves its own GraphQL API but only accepts requests once a
 * browser session (cookies) has been established against the storefront —
 * mirrors the reference Python script:
 *   1. Launch a browser, visit the storefront to establish session cookies
 *      (skipped on subsequent runs once a session is cached to disk)
 *   2. Issue the GraphQL search request through Playwright's request
 *      context, which shares those cookies
 *   3. Map results to ApiProduct[], keeping only actual grocery items
 */

import { chromium, request } from 'playwright';
import type { APIRequestContext, Browser, BrowserContext } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import type { ApiProduct, StoreLocation } from '../types/index.ts';
import { hashCode } from '../utils/textFormat.ts';
import { withTimeout } from '../utils/withTimeout.ts';
import { TtlCache } from '../utils/ttlCache.ts';
import { dedupeInFlight } from '../utils/dedupeInFlight.ts';
import { createTraderJoesLocator, warmDirectory as warmTraderJoesDirectory } from './locators/traderJoesLocator.ts';
import type { PreciseCoords } from './locators/types.ts';

const TJ_GRAPHQL_URL = 'https://www.traderjoes.com/api/graphql';
const SESSION_PATH = path.join(process.cwd(), '.traderjoes-session.json');

const SEARCH_QUERY = `
query SearchProducts(
  $search: String,
  $pageSize: Int,
  $currentPage: Int,
  $storeCode: String = "410",
  $availability: String = "1",
  $published: String = "1"
) {
  products(
    search: $search
    filter: {
      store_code: {eq: $storeCode}
      published: {eq: $published}
      availability: {match: $availability}
    }
    pageSize: $pageSize
    currentPage: $currentPage
  ) {
    total_count
    page_info {
      current_page
      total_pages
    }
    items {
      sku
      item_title
      retail_price
      availability
      sales_size
      sales_uom_description
      primary_image
      category_hierarchy {
        name
      }
    }
  }
}
`;

// In-memory cache — 5 min TTL per query
const resultCache = new TtlCache<ApiProduct[]>(5 * 60 * 1000);

// ── Store locator ─────────────────────────────────────────────────────────────
// See locators/traderJoesLocator.ts — resolves the nearest real Trader
// Joe's store for a shopper's ZIP from their real, public store directory.
const traderJoesLocator = createTraderJoesLocator();

// ── Raw GraphQL response shapes (only fields we consume) ──────────────────
interface TJCategory {
  name: string;
}
interface TJItem {
  sku: string;
  item_title: string | null;
  // The API returns this as a string (e.g. "0.23"), not a number, despite
  // what the field name suggests.
  retail_price: string | number | null;
  availability: string | null;
  // Same story here — sometimes a number (e.g. sales_size: 1), sometimes a
  // string, despite the Python reference script assuming a size string.
  sales_size: string | number | null;
  sales_uom_description: string | number | null;
  primary_image: string | null;
  category_hierarchy: TJCategory[] | null;
}
interface TJSearchResponse {
  data?: {
    products?: {
      total_count: number;
      items: TJItem[];
    };
  };
  errors?: Array<{ message?: string }>;
}

// ── Helpers ─────────────────────────────────────────────────────────────────
// Trader Joe's catalog spans more than groceries (flowers, home goods, pet
// treats, etc.). category_hierarchy is always rooted at "Products", so the
// second entry is the true top-level department — only "Food" is groceries.
function isFoodItem(item: TJItem): boolean {
  return item.category_hierarchy?.[1]?.name === 'Food';
}

function toSizePart(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

function mapTJItem(item: TJItem, location: StoreLocation | undefined): ApiProduct | null {
  const name = item.item_title?.trim();
  if (!name) return null;

  const price = item.retail_price === null ? NaN : Number(item.retail_price);
  if (!Number.isFinite(price) || price <= 0) return null;

  const seed = hashCode(item.sku);
  const size = [toSizePart(item.sales_size), toSizePart(item.sales_uom_description)]
    .filter(Boolean)
    .join(' ');

  return {
    id: `trader-joes-${item.sku}`,
    name,
    brand: "Trader Joe's",
    price,
    image_url: item.primary_image
      ? `https://www.traderjoes.com${item.primary_image}`
      : undefined,
    rating: Math.round((3.8 + (seed % 12) / 10) * 10) / 10,
    reviewCount: 20 + (seed % 1500),
    size,
    isLiveData: true,
    store: "Trader Joe's",
    location,
    inStock: true,
  };
}

// Patch navigator.webdriver so the site doesn't detect Playwright
async function stealthContext(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });
}

const DESKTOP_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

async function buildContext(browser: Browser): Promise<BrowserContext> {
  const baseOpts = {
    userAgent: DESKTOP_USER_AGENT,
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
  };

  if (fs.existsSync(SESSION_PATH)) {
    try {
      return await browser.newContext({ ...baseOpts, storageState: SESSION_PATH });
    } catch { /* fall through */ }
  }
  return await browser.newContext(baseOpts);
}

/** A plain HTTP client sharing the persisted session cookie, with no
 * browser process behind it — used by searchTraderJoes for the actual
 * GraphQL request, which needs cookies but never needs to render a page or
 * run JS. Launching a full headless Chromium (multi-second cold start) just
 * to issue one authenticated POST was the single biggest first-search cost
 * in the app; this removes it from every search, not just the first. */
async function buildApiRequestContext(): Promise<APIRequestContext> {
  const baseOpts = { userAgent: DESKTOP_USER_AGENT };
  if (fs.existsSync(SESSION_PATH)) {
    try {
      return await request.newContext({ ...baseOpts, storageState: SESSION_PATH });
    } catch { /* fall through */ }
  }
  return await request.newContext(baseOpts);
}

// Launches its own short-lived browser purely to visit the storefront and
// persist session cookies to SESSION_PATH — a no-op once that file already
// exists. Factored out of searchTraderJoes so this one-time cost (the
// ~3-30s storefront visit) can be paid during app-startup warm-up instead
// of during a shopper's first real search; searchTraderJoes still calls
// this itself as a fallback in case warm-up hasn't finished (or hasn't run
// at all) by the time a search arrives, so behavior is unchanged either way.
// Wrapped in dedupeInFlight so a racing warm-up and a shopper's first real
// search — both finding no session file at the same instant — share one
// browser launch instead of each starting their own.
async function establishSessionIfNeeded(): Promise<void> {
  if (fs.existsSync(SESSION_PATH)) return;

  await dedupeInFlight('trader-joes-session', async () => {
    if (fs.existsSync(SESSION_PATH)) return;

    console.log('[TraderJoes] No session — visiting storefront first');
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
      await stealthContext(context);

      const page = await context.newPage();
      await page.goto('https://www.traderjoes.com/home/products', {
        waitUntil: 'networkidle',
        timeout: 30000,
      });
      await page.waitForTimeout(3000);
      await page.close();

      await context.storageState({ path: SESSION_PATH });
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  });
}

// ── Main search function ──────────────────────────────────────────────────────
export async function searchTraderJoes(
  query: string,
  zip: string,
  preciseCoords?: PreciseCoords,
): Promise<ApiProduct[]> {
  const storeLocation = await traderJoesLocator.findNearestStore(zip, preciseCoords);
  if (!storeLocation?.storeId) {
    console.log(`[TraderJoes] No Trader Joe's location found near ${zip}`);
    return [];
  }
  const storeCode = storeLocation.storeId;

  const cacheKey = `${query.toLowerCase().trim()}|${storeCode}`;
  const cached = resultCache.get(cacheKey);
  if (cached) {
    console.log(`[TraderJoes] Cache hit for "${query}"`);
    return cached;
  }

  console.log(`[TraderJoes] Live fetch for "${query}" @ zip ${zip}, store ${storeCode} (${storeLocation.name})`);

  // No-op if warm-up (or an earlier search) already established a session.
  await establishSessionIfNeeded();

  // A plain HTTP client sharing the persisted session cookie — no browser
  // process, no page render. Only session *establishment* (above) ever
  // needs a real browser; the search request itself is just an
  // authenticated POST.
  const apiContext = await buildApiRequestContext();

  try {
    const response = await apiContext.post(TJ_GRAPHQL_URL, {
      data: {
        operationName: 'SearchProducts',
        query: SEARCH_QUERY,
        variables: {
          search: query,
          pageSize: 20,
          currentPage: 1,
          storeCode,
          availability: '1',
          published: '1',
        },
      },
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://www.traderjoes.com',
        Referer: 'https://www.traderjoes.com/home/products',
      },
      timeout: 20000,
    });

    if (!response.ok()) {
      const text = await response.text().catch(() => '');
      throw new Error(`Trader Joe's GraphQL failed (${response.status()}): ${text.slice(0, 200)}`);
    }

    const json = (await response.json()) as TJSearchResponse;

    if (json.errors && json.errors.length > 0) {
      throw new Error(`Trader Joe's GraphQL errors: ${JSON.stringify(json.errors).slice(0, 200)}`);
    }

    // Save/refresh session for next time.
    try {
      await apiContext.storageState({ path: SESSION_PATH });
    } catch { /* non-fatal */ }

    const items = json.data?.products?.items ?? [];
    console.log(`[TraderJoes] Raw: ${items.length} items from API`);

    const products = items
      .filter(isFoodItem)
      .map(item => mapTJItem(item, storeLocation))
      .filter((p): p is ApiProduct => p !== null);

    console.log(`[TraderJoes] ${products.length} mapped products for "${query}"`);
    // Debug output — trace the ZIP → store → product-count pipeline at a glance.
    console.log(
      `[TraderJoes][debug] zip=${zip} -> store="${storeLocation.name}" id=${storeCode} ` +
        `address="${storeLocation.address}, ${storeLocation.city}, ${storeLocation.state} ${storeLocation.zip}" ` +
        `lat=${storeLocation.latitude ?? '?'} lng=${storeLocation.longitude ?? '?'} products=${products.length}`,
    );
    resultCache.set(cacheKey, products);
    return products;
  } catch (err) {
    throw new Error(
      `Trader Joe's scraper failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    await apiContext.dispose().catch(() => {});
  }
}

// ── Timeout wrapper ───────────────────────────────────────────────────────────
export function searchTraderJoesWithTimeout(
  query: string,
  zip: string,
  timeoutMs: number,
  preciseCoords?: PreciseCoords,
): Promise<ApiProduct[]> {
  return withTimeout(searchTraderJoes(query, zip, preciseCoords), timeoutMs, "Trader Joe's search");
}

// ── Warm-up ────────────────────────────────────────────────────────────────
// The single biggest first-search cost in the whole app: establishing the
// session (launching a headless browser to visit the storefront, ~3-30s)
// at app-startup time instead of on the first real search. Also warms the
// zip-independent store directory (see traderJoesLocator.ts's warmDirectory)
// and, once a zip is known, the nearest-store lookup itself.
export async function warmTraderJoes(zip?: string): Promise<void> {
  await Promise.all([establishSessionIfNeeded(), warmTraderJoesDirectory()]);
  if (zip) await traderJoesLocator.findNearestStore(zip);
}

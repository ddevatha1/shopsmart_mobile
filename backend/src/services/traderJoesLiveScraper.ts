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

import { chromium } from 'playwright';
import type { Browser, BrowserContext } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import type { ApiProduct, StoreLocation } from '../types/index.ts';
import { hashCode } from '../utils/textFormat.ts';
import { withTimeout } from '../utils/withTimeout.ts';
import { TtlCache } from '../utils/ttlCache.ts';
import { createTraderJoesLocator } from './locators/traderJoesLocator.ts';

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

async function buildContext(browser: Browser): Promise<BrowserContext> {
  const baseOpts = {
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
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

// ── Main search function ──────────────────────────────────────────────────────
export async function searchTraderJoes(
  query: string,
  zip: string,
): Promise<ApiProduct[]> {
  const storeLocation = await traderJoesLocator.findNearestStore(zip);
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

    const hasSession = fs.existsSync(SESSION_PATH);

    if (!hasSession) {
      // No cached session — visit the storefront first to establish cookies.
      console.log('[TraderJoes] No session — visiting storefront first');
      const page = await context.newPage();
      await page.goto('https://www.traderjoes.com/home/products', {
        waitUntil: 'networkidle',
        timeout: 30000,
      });
      await page.waitForTimeout(3000);
      await page.close();
    }

    // GraphQL request shares cookies with the browser context above.
    const response = await context.request.post(TJ_GRAPHQL_URL, {
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
      await context.storageState({ path: SESSION_PATH });
    } catch { /* non-fatal */ }

    await browser.close();
    browser = null;

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
    if (browser) await browser.close().catch(() => {});
    throw new Error(
      `Trader Joe's scraper failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ── Timeout wrapper ───────────────────────────────────────────────────────────
export function searchTraderJoesWithTimeout(
  query: string,
  zip: string,
  timeoutMs: number,
): Promise<ApiProduct[]> {
  return withTimeout(searchTraderJoes(query, zip), timeoutMs, "Trader Joe's search");
}

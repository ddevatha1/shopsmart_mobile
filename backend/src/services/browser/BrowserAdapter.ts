/**
 * The generic browser-extraction orchestrator — the piece that actually
 * opens a grocery website, performs a normal-looking search, and turns
 * whatever the browser observes into ranked, normalized products.
 *
 * Pipeline: Browser session -> perform a normal search -> capture network
 * responses -> detect product-shaped JSON -> normalize -> rank against the
 * query. No per-store scraping logic beyond the small BrowserStoreConfig
 * each site supplies (where to search, and — optionally — how to set a
 * delivery zip or find its search box, when the generic heuristics below
 * can't).
 *
 * Explicitly out of scope, by design, not by oversight: no CAPTCHA
 * solving, no defeating bot-detection challenges, no automated login. If a
 * site's search page doesn't render normally for a plain, realistic
 * browser session, this returns an honest empty result — the same
 * "unavailable, not broken" philosophy this app's own Albertsons
 * integration already uses (see albertsonsLiveScraper.ts) — rather than
 * escalating into something more aggressive. This framework only ever
 * operates through the same normal page interactions any visitor's browser
 * would perform (load a page, type into a visible search box, wait for it
 * to respond); it doesn't attempt to access anything a real anonymous
 * visitor to the site couldn't.
 *
 * Also deliberately NOT included yet (kept experimental and simple, per
 * the current design direction): persisting a discovered endpoint for
 * direct HTTP replay on later searches. `discoveredEndpoints` on the
 * result is informational only — a real "learn once, replay directly next
 * time" pipeline is a reasonable future step once this extraction layer
 * has proven reliable, not something to bolt on before that.
 */
import type { Browser, Page } from 'playwright';
import { withTimeout } from '../../utils/withTimeout.ts';
import { launchBrowser, createSessionContext, stealthPage, saveSession, closeBrowser } from './BrowserSession.ts';
import { NetworkCapture } from './NetworkCapture.ts';
import { findProductCandidates } from './ProductExtractor.ts';
import { normalizeCandidate } from './ProductNormalizer.ts';
import { rankProducts } from './SearchRanker.ts';
import type { BrowserStoreConfig, BrowserSearchResult } from './types.ts';

const OVERALL_TIMEOUT_MS = 90_000;

const SEARCH_INPUT_SELECTORS = [
  'input[type="search"]',
  'input[role="searchbox"]',
  '[role="searchbox"] input',
  'input[aria-label*="search" i]',
  'input[placeholder*="search" i]',
  'input[name*="search" i]',
  'input[id*="search" i]',
];

export const ZIP_INPUT_SELECTORS = [
  'input[aria-label*="zip" i]',
  'input[placeholder*="zip" i]',
  'input[aria-label*="postal" i]',
  'input[placeholder*="postal" i]',
  'input[name*="zip" i]',
];

async function tryFillAndSubmit(page: Page, selectors: string[], value: string): Promise<boolean> {
  for (const selector of selectors) {
    const input = page.locator(selector).first();
    if ((await input.count().catch(() => 0)) === 0) continue;
    if (!(await input.isVisible().catch(() => false))) continue;
    await input.click().catch(() => {});
    // Real character-by-character keystrokes, not `.fill()` — plenty of
    // storefronts drive an autosuggest/search state machine off actual
    // keydown/input events per character, which a single programmatic
    // value-set can silently fail to trigger even though the DOM value
    // looks correct afterward.
    await input.pressSequentially(value, { delay: 50 }).catch(() => {});
    await page.waitForTimeout(300);
    await input.press('Enter').catch(() => {});
    return true;
  }
  return false;
}

/** Best-effort only: most storefronts either aren't location-scoped by a
 * plain text input, or gate it behind a custom modal this generic
 * heuristic isn't expected to solve — a per-store `setLocation` override
 * is the intended fix for those, not a bigger heuristic here. Exported so
 * the store-onboarding tooling (see `stores/StoreCompatibilityTester.ts`)
 * can reuse the exact same heuristic across a multi-query session instead
 * of duplicating it. */
export async function bestEffortSetZip(page: Page, zipcode: string): Promise<void> {
  await tryFillAndSubmit(page, ZIP_INPUT_SELECTORS, zipcode);
}

/** No search input found isn't necessarily a failure — `buildSearchUrl` may
 * already encode the query as a URL param (many storefronts' search-results
 * pages work this way). Whether real results actually loaded is determined
 * by what NetworkCapture observed, not by whether this function found a
 * box to type into. Exported for the same reason as `bestEffortSetZip`
 * above. */
export async function performSearch(page: Page, config: BrowserStoreConfig, query: string): Promise<void> {
  const selectors = config.searchInputSelector
    ? [config.searchInputSelector, ...SEARCH_INPUT_SELECTORS]
    : SEARCH_INPUT_SELECTORS;
  await tryFillAndSubmit(page, selectors, query);
}

async function runOnce(config: BrowserStoreConfig, query: string, zipcode?: string): Promise<BrowserSearchResult> {
  const start = Date.now();
  let browser: Browser | null = null;
  try {
    browser = await launchBrowser();
    const context = await createSessionContext(browser, config.storeName);
    const page = await context.newPage();
    await stealthPage(page);

    const capture = new NetworkCapture();
    capture.attach(page);

    const url = config.buildSearchUrl(query, zipcode);
    // `domcontentloaded`, not `networkidle`, for the *hard* navigation
    // condition — `networkidle` never fires on plenty of real storefronts
    // (background polling/analytics/chat widgets keep at least one request
    // in flight indefinitely), which would make this framework fail
    // outright on sites that are working perfectly well, not actually
    // blocked. Instead: wait for DOM content (always resolves), then make
    // a *bounded, best-effort* attempt at network-idle so client-side
    // hydration gets a real chance to finish before search-input detection
    // runs, falling back to a fixed settle delay either way.
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
    await page.waitForTimeout(2000);

    if (zipcode) {
      if (config.setLocation) {
        await config.setLocation(page, zipcode).catch(() => {});
      } else {
        await bestEffortSetZip(page, zipcode);
      }
    }

    await performSearch(page, config, query);

    // Give in-flight XHR/fetch requests a chance to land before harvesting
    // — best-effort; a page with background polling may never go fully
    // idle, so this is capped and non-fatal rather than awaited forever.
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    capture.stop();

    await saveSession(context, config.storeName);

    const candidates = capture.responses.flatMap(r => findProductCandidates(r.json, r.url));
    const normalized = candidates
      .map(c => normalizeCandidate(c, config.storeName, config.location))
      .filter((p): p is NonNullable<typeof p> => p !== null);
    const ranked = rankProducts(query, normalized);

    return {
      products: ranked,
      discoveredEndpoints: [...new Set(capture.responses.map(r => r.url))],
      durationMs: Date.now() - start,
      attempts: 1,
    };
  } finally {
    await closeBrowser(browser);
  }
}

/** Runs the full browser-extraction flow once, retries exactly once on
 * failure (a transient navigation/timeout hiccup, not a systemic block —
 * this framework doesn't attempt to distinguish those, it just tries
 * again), and enforces an overall time budget so a hung page can never
 * block a search indefinitely. A failed retry returns an honest empty
 * result rather than throwing, matching how every other store adapter in
 * this app behaves under `Promise.allSettled` fan-out. */
export async function searchViaBrowser(
  config: BrowserStoreConfig,
  query: string,
  zipcode?: string,
): Promise<BrowserSearchResult> {
  const run = () =>
    withTimeout(runOnce(config, query, zipcode), OVERALL_TIMEOUT_MS, `${config.storeName} browser search`);

  try {
    return await run();
  } catch (firstError) {
    console.warn(
      `[BrowserAdapter] ${config.storeName} first attempt failed, retrying once:`,
      firstError instanceof Error ? firstError.message : firstError,
    );
    try {
      const result = await run();
      return { ...result, attempts: 2 };
    } catch (secondError) {
      console.warn(
        `[BrowserAdapter] ${config.storeName} retry also failed:`,
        secondError instanceof Error ? secondError.message : secondError,
      );
      return { products: [], discoveredEndpoints: [], durationMs: 0, attempts: 2 };
    }
  }
}

/**
 * The integration point with the existing per-store adapter system: try a
 * store's own direct API adapter first, fall back to the generic browser
 * adapter only if the direct call throws or comes back empty. Nothing
 * calls this automatically — a specific store adapter opts into it once
 * its BrowserStoreConfig has been validated for that store (see this
 * module's own test/validation notes). Existing production stores
 * (Kroger, Harris Teeter, Aldi, Sprouts, Trader Joe's, Albertsons) are
 * untouched — none of them call this.
 */
export async function searchWithFallback<T>(
  directSearch: () => Promise<T[]>,
  browserConfig: BrowserStoreConfig,
  query: string,
  zipcode?: string,
): Promise<{ products: T[] | import('./types.ts').BrowserProduct[]; usedFallback: boolean }> {
  try {
    const direct = await directSearch();
    if (direct.length > 0) return { products: direct, usedFallback: false };
  } catch (err) {
    console.warn(
      `[BrowserAdapter] ${browserConfig.storeName} direct adapter failed, falling back to browser extraction:`,
      err instanceof Error ? err.message : err,
    );
  }
  const result = await searchViaBrowser(browserConfig, query, zipcode);
  return { products: result.products.map(r => r.product), usedFallback: true };
}

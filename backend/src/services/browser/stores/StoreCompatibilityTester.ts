/**
 * Turns "is this store compatible with the generic browser framework?"
 * from a manual, ad hoc investigation into a repeatable, structured
 * report. One browser session per store (not one per test query — a real
 * shopper doesn't get a fresh browser for every search, and relaunching
 * Chromium four times per store is wasted time this doesn't need):
 *
 *   1. Open browser, load the store's homepage
 *   2. Resolve location, once, if the config supports it
 *   3. For each test query (apples, milk, bananas, chicken breast):
 *        perform the search -> capture network responses since the last
 *        query -> run them through ProductExtractor/ProductNormalizer/
 *        SearchRanker
 *   4. Aggregate into one CompatibilityReport
 *
 * Every step reuses the already-validated pieces of this framework
 * directly (BrowserSession, NetworkCapture, ProductExtractor,
 * ProductNormalizer, SearchRanker, and BrowserAdapter's own DOM-
 * interaction helpers) — this file adds no new detection heuristics of
 * its own, only the multi-query session orchestration and reporting.
 *
 * A low/zero score is exactly as valid and useful an outcome as a high
 * one — see storeConfigs/foodLion.ts, wegmans.ts, wincoFoods.ts for
 * candidates this was deliberately *not* run against, and why.
 */
import type { Browser, Page } from 'playwright';
import { withTimeout } from '../../../utils/withTimeout.ts';
import {
  launchBrowser,
  createSessionContext,
  stealthPage,
  saveSession,
  closeBrowser,
} from '../BrowserSession.ts';
import { NetworkCapture } from '../NetworkCapture.ts';
import { findProductCandidates } from '../ProductExtractor.ts';
import { normalizeCandidate } from '../ProductNormalizer.ts';
import { rankProducts } from '../SearchRanker.ts';
import { performSearch, bestEffortSetZip } from '../BrowserAdapter.ts';
import type { RankedProduct } from '../types.ts';
import { toBrowserStoreConfig } from './StoreRegistry.ts';
import type { StoreOnboardingConfig } from './storeConfigs/types.ts';

const TEST_QUERIES = ['apples', 'milk', 'bananas', 'chicken breast'];
const OVERALL_TIMEOUT_MS = 4 * 60_000; // a one-time onboarding survey, not a live per-shopper search — a generous budget is fine here

export interface FieldsDetected {
  price: boolean;
  image: boolean;
  category: boolean;
  upc: boolean;
}

export interface PerQueryResult {
  query: string;
  /** Product-shaped JSON objects ProductExtractor found, before relevance
   * ranking against this specific query — a store that returns 0 here
   * genuinely returned nothing product-like; a store that returns >0 here
   * but 0 `productsFound` found products, just not ones relevant to this
   * query (a distinct, useful failure mode to be able to tell apart). */
  candidatesFound: number;
  productsFound: number;
  durationMs: number;
}

export interface CompatibilityReport {
  store: string;
  websiteLoaded: boolean;
  searchWorked: boolean;
  productResponsesCaptured: boolean;
  productsFound: number;
  fieldsDetected: FieldsDetected;
  /** 0-1 — see computeConfidence's own comment for exactly how this is
   * derived; never a black-box number. */
  confidence: number;
  /** The aggregate numbers above can hide a store that works for "milk"
   * but not "chicken breast" — this is the detail behind them. */
  perQuery: PerQueryResult[];
  /** Human-readable, e.g. "no visible search input found; used
   * buildSearchUrl fallback" — so a low-scoring store isn't a guessing
   * game about what to fix next. */
  notes: string[];
}

function computeConfidence(input: {
  websiteLoaded: boolean;
  queriesWithResults: number;
  totalQueries: number;
  fieldsDetected: FieldsDetected;
  productsFound: number;
}): number {
  if (!input.websiteLoaded) return 0;
  const searchScore = input.queriesWithResults / input.totalQueries;
  const fieldScore = Object.values(input.fieldsDetected).filter(Boolean).length / 4;
  const volumeScore = Math.min(1, input.productsFound / 20);
  // Weighted so that "does search actually work at all" dominates, field
  // richness matters second, and raw product volume matters least — a
  // store that returns a handful of fully-normalized products across all
  // 4 queries is a better onboarding candidate than one that returns 50
  // products with no price detected on any of them.
  const score = 0.5 * searchScore + 0.3 * fieldScore + 0.2 * volumeScore;
  return Math.round(score * 100) / 100;
}

export async function testStoreCompatibility(
  config: StoreOnboardingConfig,
  zipcode?: string,
): Promise<CompatibilityReport> {
  return withTimeout(runCompatibilityTest(config, zipcode), OVERALL_TIMEOUT_MS, `${config.storeName} compatibility test`);
}

async function runCompatibilityTest(config: StoreOnboardingConfig, zipcode?: string): Promise<CompatibilityReport> {
  const browserConfig = toBrowserStoreConfig(config);
  const notes: string[] = [];
  const perQuery: PerQueryResult[] = [];
  const uniqueProducts = new Map<string, RankedProduct>();
  const fieldsDetected: FieldsDetected = { price: false, image: false, category: false, upc: false };
  let websiteLoaded = false;

  let browser: Browser | null = null;
  try {
    browser = await launchBrowser();
    const context = await createSessionContext(browser, config.storeName);
    const page: Page = await context.newPage();
    await stealthPage(page);

    const capture = new NetworkCapture();
    capture.attach(page);

    // Step 1: load the homepage.
    try {
      const response = await page.goto(config.homepage, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      websiteLoaded = response !== null && response.status() < 400;
      if (!websiteLoaded) {
        notes.push(`Homepage responded with HTTP ${response?.status() ?? 'no response'} instead of loading normally.`);
      }
    } catch (err) {
      notes.push(`Homepage failed to load: ${err instanceof Error ? err.message : String(err)}`);
    }
    await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
    await page.waitForTimeout(2000);

    // Step 2: resolve location, once, for the whole session.
    if (websiteLoaded && zipcode) {
      if (browserConfig.setLocation) {
        await browserConfig.setLocation(page, zipcode).catch(() => {});
      } else {
        await bestEffortSetZip(page, zipcode);
      }
    }

    // Steps 3-5: each test query, reusing the same page/session.
    if (websiteLoaded) {
      for (const query of TEST_QUERIES) {
        const start = Date.now();
        const beforeCount = capture.responses.length;

        await performSearch(page, browserConfig, query);
        await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
        await page.waitForTimeout(1500);

        const newResponses = capture.responses.slice(beforeCount);
        const candidates = newResponses.flatMap(r => findProductCandidates(r.json, r.url));
        const normalized = candidates
          .map(c => normalizeCandidate(c, config.storeName))
          .filter((p): p is NonNullable<typeof p> => p !== null);
        const ranked = rankProducts(query, normalized);

        for (const r of ranked) {
          uniqueProducts.set(r.product.id, r);
          if (r.product.price > 0) fieldsDetected.price = true;
          if (r.product.image_url) fieldsDetected.image = true;
          if (r.product.category) fieldsDetected.category = true;
          if (r.product.upc) fieldsDetected.upc = true;
        }

        perQuery.push({
          query,
          candidatesFound: candidates.length,
          productsFound: ranked.length,
          durationMs: Date.now() - start,
        });
      }
      await saveSession(context, config.storeName);
    }
  } finally {
    await closeBrowser(browser);
  }

  const queriesWithResults = perQuery.filter(q => q.productsFound > 0).length;
  const productResponsesCaptured = perQuery.some(q => q.candidatesFound > 0);
  const searchWorked = queriesWithResults > 0;
  const productsFound = uniqueProducts.size;

  if (websiteLoaded && !productResponsesCaptured) {
    notes.push('Homepage loaded, but no captured network response contained anything product-shaped for any test query.');
  } else if (websiteLoaded && productResponsesCaptured && !searchWorked) {
    notes.push('Product-shaped responses were captured, but none ranked as relevant to any test query — check whether the right search box was actually found (consider a searchInputSelector override).');
  }

  const confidence = computeConfidence({
    websiteLoaded,
    queriesWithResults,
    totalQueries: TEST_QUERIES.length,
    fieldsDetected,
    productsFound,
  });

  return {
    store: config.storeName,
    websiteLoaded,
    searchWorked,
    productResponsesCaptured,
    productsFound,
    fieldsDetected,
    confidence,
    perQuery,
    notes,
  };
}

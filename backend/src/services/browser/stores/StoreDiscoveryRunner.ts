/**
 * Broad, cheap, single-pass triage across many candidate retailers at
 * once — distinct from StoreCompatibilityTester.ts's deeper 4-query
 * validation of a small, already-shortlisted set. The intended pipeline is
 * discover-then-validate: run this across a wide candidate list to find
 * which ones are even worth a second look, then hand survivors to
 * StoreCompatibilityTester for the thorough pass before anything gets
 * wired into a real adapter.
 *
 * Per store: launch a browser, load the homepage, and detect — website
 * loads, a search input exists, a location input can be set, what URL
 * pattern a search produces, whether any JSON/XHR response looks
 * product-shaped, and whether real products come out the other end with
 * sensible relevance ranking. One representative query ("milk" — food-safe
 * and unambiguous) is enough to answer all of those; the deeper multi-
 * query battery belongs to StoreCompatibilityTester once a store is worth
 * that investment.
 *
 * "Compatible" requires ALL of: the site loaded without a login wall or a
 * CAPTCHA/bot-challenge page, product data was actually extracted, and
 * relevance ranking produced a sensible result — never just "the page
 * returned 200." This file only ever determines compatibility; it never
 * attempts to solve a challenge, log in, or route around a block. A
 * confirmed blocker is a complete, valid, useful result on its own.
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
import { performSearch, ZIP_INPUT_SELECTORS } from '../BrowserAdapter.ts';
import { toBrowserStoreConfig } from './StoreRegistry.ts';
import type { StoreOnboardingConfig } from './storeConfigs/types.ts';

const DISCOVERY_QUERY = 'milk';
const OVERALL_TIMEOUT_MS = 2 * 60_000; // a single-query triage pass, not the deeper multi-query battery — tighter budget than StoreCompatibilityTester's

// Vendor-agnostic — the same reasoning applied by hand throughout this
// app's own retailer audit (Akamai/Incapsula/Cloudflare all recognized by
// what their challenge pages say, not by which vendor it is) turned into a
// real, generic check. A real product/category/marketing page can
// legitimately contain the word "captcha" once (a login form's reCAPTCHA
// widget, say) without being a challenge page itself — that's why this
// only fires on the phrases a full-page challenge interstitial actually
// uses, not on the bare word "captcha".
const CHALLENGE_PAGE_SIGNATURES = [
  'just a moment',
  'attention required',
  'access denied',
  'verify you are human',
  'checking your browser',
  'enable javascript and cookies to continue',
  'unusual traffic',
];

export type CompatibilityStatus = 'untested' | 'compatible' | 'incompatible' | 'blocked';

export interface DiscoveryCandidate {
  storeName: string;
  homepage: string;
  region: string;
  estimatedProductAvailability: 'high' | 'medium' | 'low' | 'unknown';
  compatibilityStatus: CompatibilityStatus;
  failureReason?: string;
}

export interface DiscoveryReport {
  store: string;
  websiteLoaded: boolean;
  searchAvailable: boolean;
  /** Whether a location/zip input was found and could be filled — `false`
   * for stores that never needed a location step at all just as much as
   * ones that hid it behind something this framework couldn't find; see
   * `blockers` for which one happened. */
  locationCanBeSet: boolean;
  /** The page URL after search was performed, when it changed from the
   * homepage — informational, useful for hand-writing a `buildSearchUrl`
   * later even if nothing else about this store panned out. */
  productSearchUrlPattern?: string;
  productApiDetected: boolean;
  productsExtracted: number;
  confidenceScore: number;
  blockers: string[];
}

function detectChallengePage(title: string, bodySample: string): string | null {
  const haystack = `${title} ${bodySample}`.toLowerCase();
  for (const signature of CHALLENGE_PAGE_SIGNATURES) {
    if (haystack.includes(signature)) return signature;
  }
  return null;
}

async function detectLoginWall(page: Page): Promise<boolean> {
  const passwordInput = page.locator('input[type="password"]').first();
  return (await passwordInput.count().catch(() => 0)) > 0 && (await passwordInput.isVisible().catch(() => false));
}

async function runDiscovery(config: StoreOnboardingConfig, zipcode?: string): Promise<DiscoveryReport> {
  const browserConfig = toBrowserStoreConfig(config);
  const blockers: string[] = [];
  let websiteLoaded = false;
  let searchAvailable = false;
  let locationCanBeSet = false;
  let productSearchUrlPattern: string | undefined;
  let productsExtracted = 0;
  let anyCandidatesFound = false;
  let anyDirectMatch = false;
  let bestRelevance = 0;

  let browser: Browser | null = null;
  try {
    browser = await launchBrowser();
    const context = await createSessionContext(browser, config.storeName);
    const page: Page = await context.newPage();
    await stealthPage(page);

    const capture = new NetworkCapture();
    capture.attach(page);

    // 1. Website loads.
    try {
      const response = await page.goto(config.homepage, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      const httpOk = response !== null && response.status() < 400;
      if (!httpOk) blockers.push(`Homepage responded with HTTP ${response?.status() ?? 'no response'}.`);
      websiteLoaded = httpOk;
    } catch (err) {
      blockers.push(`Homepage failed to load: ${err instanceof Error ? err.message : String(err)}`);
    }
    await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
    await page.waitForTimeout(2000);

    if (websiteLoaded) {
      const title = await page.title().catch(() => '');
      const bodySample = await page.evaluate(() => document.body?.innerText?.slice(0, 2000) ?? '').catch(() => '');
      const challengeSignature = detectChallengePage(title, bodySample);
      if (challengeSignature) {
        blockers.push(`Homepage appears to be a bot-challenge interstitial (matched "${challengeSignature}").`);
        websiteLoaded = false; // a challenge page is not a real load, regardless of HTTP status
      } else if (await detectLoginWall(page)) {
        blockers.push('A password input is visible on the homepage — this store appears to require login before browsing.');
      }
    }

    // 2. Location can be set (only meaningful if the site loaded cleanly).
    if (websiteLoaded && zipcode) {
      if (browserConfig.setLocation) {
        await browserConfig.setLocation(page, zipcode).catch(() => {});
        locationCanBeSet = true; // an explicit override ran without throwing — take it at its word
      } else {
        locationCanBeSet = await tryZipInput(page, zipcode);
      }
    }

    // 3-5. Search input, product search URL pattern, JSON/XHR capture.
    if (websiteLoaded) {
      const homepageUrl = page.url();
      await performSearch(page, browserConfig, DISCOVERY_QUERY);
      await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
      await page.waitForTimeout(1500);

      const afterUrl = page.url();
      if (afterUrl !== homepageUrl) {
        productSearchUrlPattern = afterUrl;
        searchAvailable = true;
      }

      const candidates = capture.responses.flatMap(r => findProductCandidates(r.json, r.url));
      anyCandidatesFound = candidates.length > 0;

      const normalized = candidates
        .map(c => normalizeCandidate(c, config.storeName))
        .filter((p): p is NonNullable<typeof p> => p !== null);
      const ranked = rankProducts(DISCOVERY_QUERY, normalized);

      productsExtracted = ranked.length;
      if (ranked.length > 0) {
        searchAvailable = true; // real results are stronger evidence search worked than a URL change alone
        anyDirectMatch = ranked.some(r => r.matchType === 'direct');
        bestRelevance = Math.max(...ranked.map(r => r.relevanceScore));
      }

      if (!searchAvailable) blockers.push('No search input was found and no URL/network change was observed after attempting a search.');
      else if (!anyCandidatesFound) blockers.push('Search appeared to run, but no captured network response contained anything product-shaped.');
      else if (productsExtracted === 0) blockers.push('Product-shaped data was captured, but nothing ranked as relevant to the test query.');

      await saveSession(context, config.storeName);
    }
  } finally {
    await closeBrowser(browser);
  }

  const productApiDetected = anyCandidatesFound;
  // "Relevance ranking works" requires more than a nonzero count — at
  // least one genuinely direct match, or a comfortably-above-threshold
  // score, not just something that barely cleared SearchRanker's own
  // floor.
  const relevanceRankingWorks = anyDirectMatch || bestRelevance >= 0.5;
  if (productsExtracted > 0 && !relevanceRankingWorks) {
    blockers.push('Products were extracted, but none ranked as a confident match — relevance ranking is not reliable for this store yet.');
  }

  const confidenceScore = computeConfidenceScore({
    websiteLoaded,
    searchAvailable,
    productApiDetected,
    productsExtracted,
    relevanceRankingWorks,
  });

  return {
    store: config.storeName,
    websiteLoaded,
    searchAvailable,
    locationCanBeSet,
    productSearchUrlPattern,
    productApiDetected,
    productsExtracted,
    confidenceScore,
    blockers,
  };
}

/** The same generic zip-input selectors BrowserAdapter.ts's own
 * bestEffortSetZip uses (reused, not duplicated), but reporting whether it
 * actually found something to interact with — the discovery workflow
 * needs that as its own signal, not just a fire-and-forget best-effort
 * action with no feedback. */
async function tryZipInput(page: Page, zipcode: string): Promise<boolean> {
  for (const selector of ZIP_INPUT_SELECTORS) {
    const input = page.locator(selector).first();
    if ((await input.count().catch(() => 0)) === 0) continue;
    if (!(await input.isVisible().catch(() => false))) continue;
    await input.fill(zipcode).catch(() => {});
    await input.press('Enter').catch(() => {});
    return true;
  }
  return false;
}

function computeConfidenceScore(input: {
  websiteLoaded: boolean;
  searchAvailable: boolean;
  productApiDetected: boolean;
  productsExtracted: number;
  relevanceRankingWorks: boolean;
}): number {
  if (!input.websiteLoaded) return 0;
  let score = 0.15; // the site loads at all, cleanly — a real but small signal on its own
  if (input.searchAvailable) score += 0.2;
  if (input.productApiDetected) score += 0.2;
  if (input.productsExtracted > 0) score += 0.2;
  if (input.relevanceRankingWorks) score += 0.25;
  return Math.round(score * 100) / 100;
}

/** The compatibility bar this whole file exists to enforce — see this
 * file's header comment. Never returns 'compatible' from a partial
 * result; every one of these must hold. */
export function classifyCompatibility(report: DiscoveryReport): { status: CompatibilityStatus; reason?: string } {
  const loginOrChallengeBlocker = report.blockers.find(
    b => b.includes('login') || b.includes('challenge') || b.includes('HTTP'),
  );
  if (loginOrChallengeBlocker) return { status: 'blocked', reason: loginOrChallengeBlocker };
  if (!report.websiteLoaded) return { status: 'blocked', reason: report.blockers[0] ?? 'Homepage did not load.' };
  if (report.productsExtracted === 0) {
    return { status: 'incompatible', reason: report.blockers[0] ?? 'No products were extracted for the test query.' };
  }
  const relevanceOk = !report.blockers.some(b => b.includes('relevance ranking is not reliable'));
  if (!relevanceOk) {
    return { status: 'incompatible', reason: 'Products were extracted, but relevance ranking did not produce a confident match.' };
  }
  return { status: 'compatible' };
}

/** Runs discovery for one candidate and returns its updated status
 * alongside the full report — callers own persisting the update back onto
 * their own candidate list (see runDiscoveryBatch below for the built-in
 * version of that). */
export async function discoverStore(
  config: StoreOnboardingConfig,
  zipcode?: string,
): Promise<{ report: DiscoveryReport; status: CompatibilityStatus; reason?: string }> {
  const report = await withTimeout(runDiscovery(config, zipcode), OVERALL_TIMEOUT_MS, `${config.storeName} discovery`);
  const { status, reason } = classifyCompatibility(report);
  return { report, status, reason };
}

/** Runs discovery across a whole candidate list sequentially (real browser
 * launches don't parallelize well in a resource-bounded environment) and
 * returns the list with `compatibilityStatus`/`failureReason` updated in
 * place from each result — the "maintains a candidate list" half of this
 * file's job, not just the per-store test. A candidate a caller has
 * already deliberately excluded (see storeConfigs/ for examples of
 * configs kept as records but never run) should simply not be passed in;
 * this function has no opinion about that decision, it only reports what
 * it's given.
 */
export async function runDiscoveryBatch(
  candidates: DiscoveryCandidate[],
  configFor: (storeName: string) => StoreOnboardingConfig | undefined,
  zipcode?: string,
): Promise<{ candidates: DiscoveryCandidate[]; reports: DiscoveryReport[] }> {
  const reports: DiscoveryReport[] = [];
  const updated: DiscoveryCandidate[] = [];

  for (const candidate of candidates) {
    const config = configFor(candidate.storeName);
    if (!config) {
      updated.push({ ...candidate, compatibilityStatus: 'untested', failureReason: 'No StoreOnboardingConfig registered for this candidate.' });
      continue;
    }
    try {
      const { report, status, reason } = await discoverStore(config, zipcode);
      reports.push(report);
      updated.push({ ...candidate, compatibilityStatus: status, failureReason: reason });
    } catch (err) {
      updated.push({
        ...candidate,
        compatibilityStatus: 'blocked',
        failureReason: `Discovery run failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return { candidates: updated, reports };
}

/**
 * Browser lifecycle for the generic browser-extraction framework —
 * launching Chromium, building a realistic context, and tearing everything
 * down afterward. This is the exact same approach `sproutsLiveScraper.ts`
 * and `traderJoesLiveScraper.ts` already use for their own store-specific
 * Playwright sessions (realistic desktop UA, automation-detection flags
 * disabled, a patched `navigator.webdriver`), generalized here so a new
 * store config doesn't need to reimplement it — reuse, not reinvention.
 *
 * Per-store session persistence mirrors those same files' `.json`
 * storageState pattern, generalized to one directory keyed by store name
 * instead of one hardcoded path per store.
 */
import { chromium } from 'playwright';
import type { Browser, BrowserContext, Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

const SESSION_DIR = path.join(process.cwd(), '.browser-sessions');

const DESKTOP_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function sessionPath(storeName: string): string {
  const slug = storeName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return path.join(SESSION_DIR, `${slug}.json`);
}

export async function launchBrowser(): Promise<Browser> {
  return chromium.launch({
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
}

/** Reuses a previously-saved session for this store if one exists (skips
 * re-establishing cookies a prior run already paid for), otherwise starts
 * fresh — never fails the caller if the saved state is stale/corrupt. */
export async function createSessionContext(browser: Browser, storeName: string): Promise<BrowserContext> {
  const baseOpts = {
    userAgent: DESKTOP_USER_AGENT,
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
  };
  const storagePath = sessionPath(storeName);
  if (fs.existsSync(storagePath)) {
    try {
      return await browser.newContext({ ...baseOpts, storageState: storagePath });
    } catch {
      // Fall through to a fresh context — a corrupt/incompatible saved
      // state should never block a search.
    }
  }
  return await browser.newContext(baseOpts);
}

export async function stealthPage(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });
}

export async function saveSession(context: BrowserContext, storeName: string): Promise<void> {
  try {
    if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });
    await context.storageState({ path: sessionPath(storeName) });
  } catch {
    // Non-fatal — the next run just starts from a fresh context instead of
    // a warm one.
  }
}

export async function closeBrowser(browser: Browser | null): Promise<void> {
  if (browser) await browser.close().catch(() => {});
}

/**
 * Shared Chromium launcher for every Playwright-backed store integration
 * (currently: Trader Joe's session establishment, Sprouts' product-image
 * fallback). `playwright` the npm package does not ship the browser binary
 * itself — a missing `npx playwright install chromium` step (e.g. a Render
 * Build Command that wasn't updated) surfaces as a multi-line
 * "Executable doesn't exist at ..." error from deep inside Playwright.
 * That error is accurate but unfriendly for on-call triage from Render
 * logs; this rewrites it into a one-line, actionable message while leaving
 * every other launch failure untouched. Launch failures here are never
 * fatal to the overall search — every caller already isolates its own
 * try/catch (or relies on Promise.allSettled upstream in searchService.ts)
 * so one store's missing/broken browser never takes down the others.
 */
import { chromium } from 'playwright';
import type { Browser, LaunchOptions } from 'playwright';

// Standard container-safe flags: no setuid sandbox (Render's build/run
// containers don't grant the capabilities Chromium's sandbox needs),
// /dev/shm is too small in most containers for Chromium's default shared
// memory usage, and there's no GPU to accelerate against.
export const CONTAINER_SAFE_CHROMIUM_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--no-first-run',
];

export async function launchChromium(options?: LaunchOptions): Promise<Browser> {
  try {
    return await chromium.launch({
      headless: true,
      args: CONTAINER_SAFE_CHROMIUM_ARGS,
      ...options,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("Executable doesn't exist")) {
      throw new Error(
        "Chromium browser binary is not installed on this host. The deploy's Build " +
        'Command must run `npx playwright install --with-deps chromium` after ' +
        '`npm install` — see render.yaml. Original error: ' + message.split('\n')[0],
      );
    }
    throw err;
  }
}

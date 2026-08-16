/**
 * Shared Chromium launcher for every Playwright-backed store integration
 * (currently: Trader Joe's session establishment, Sprouts' product-image
 * fallback). `playwright` the npm package does not ship the browser binary
 * itself — package.json's own "postinstall" script (`playwright install
 * chromium`) is what installs it, so it happens on any `npm install`
 * regardless of what Build Command a given host has configured (this
 * matters on Render specifically: render.yaml is only auto-applied to
 * Blueprint-created services — a service created by hand in the dashboard
 * before render.yaml existed keeps whatever Build Command was typed in
 * manually, which is exactly what caused a real, observed "Executable
 * doesn't exist" failure in production). Deliberately `playwright install
 * chromium`, not `--with-deps`: `--with-deps` shells out to `apt-get`,
 * which needs root and isn't reliably available in every Render build
 * environment — Render's Node base image already ships the shared
 * libraries the headless Chromium build needs, so the plain install is
 * both simpler and less likely to fail the whole build step.
 *
 * `src/services/startupDiagnostics.ts` runs a `chromium.executablePath()`
 * existence check once at server boot (before this is ever needed) so a
 * missing install shows up immediately in Render logs instead of only
 * surfacing later as a confusing per-store search error.
 *
 * If that postinstall step is ever skipped anyway (e.g. `npm install
 * --ignore-scripts`), the failure surfaces as a multi-line "Executable
 * doesn't exist at ..." error from deep inside Playwright — accurate but
 * unfriendly for on-call triage from Render logs; this rewrites it into a
 * one-line, actionable message while leaving every other launch failure
 * untouched. Launch failures here are never fatal to the overall search —
 * every caller already isolates its own try/catch (or relies on
 * Promise.allSettled upstream in searchService.ts) so one store's
 * missing/broken browser never takes down the others.
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
        'Chromium browser binary is not installed on this host — package.json\'s ' +
        '"postinstall" script (`playwright install chromium`) did not run or did not ' +
        'complete. If this is Render: confirm the service actually ran `npm install` ' +
        'during its build (not `npm ci --ignore-scripts` or a cached/skipped install), ' +
        'and that the build logs show Chromium being downloaded. ' +
        'Original error: ' + message.split('\n')[0],
      );
    }
    throw err;
  }
}

/**
 * Orchestrates app-startup warm-up: moves the one-time initialization costs
 * that used to be paid by whichever request happened to arrive first
 * (Kroger's OAuth2 token, Aldi/Sprouts' anonymous session cookies, Trader
 * Joe's browser session + store directory, and — once a zip is known —
 * each store's nearest-location lookup) out of the search path entirely.
 *
 * Two call sites use this:
 *   - index.ts calls `runWarmup()` with no zip at server boot, fire-and-
 *     forget, to pre-warm everything that doesn't depend on a shopper's
 *     location before any request arrives.
 *   - routes/warmup.ts calls `ensureWarmupStarted(zipcode)` per app-open,
 *     once the app knows (or the shopper has previously saved) a zip, to
 *     also warm the per-store nearest-location caches for that specific
 *     area — fire-and-forget, exactly like the boot-time call, never
 *     awaited by the HTTP response (see that route's own header comment
 *     for the real, live bug this fixed: the route used to `await
 *     runWarmup()` directly, so /api/warmup itself paid the full ~8s
 *     worst-case warm-up cost before ever responding, which is what a
 *     shopper's client-side warmup fetch was actually timing out on).
 *
 * `backendStatus` (below) is what makes that fix honest rather than just
 * "respond early and hope" — routes/warmup.ts reports the REAL current
 * state instead of a fabricated "sure, we're ready."
 */
import { warmKroger, warmHarrisTeeter } from './krogerLiveScraper.ts';
import { warmAldi } from './aldiLiveScraper.ts';
import { warmSprouts } from './sproutsLiveScraper.ts';
import { warmTraderJoes } from './traderJoesLiveScraper.ts';
import { warmAlbertsonsDirectory } from './locators/albertsonsLocator.ts';
import { perfLog } from '../utils/perfLog.ts';

// ─── Backend readiness state ────────────────────────────────────────────
//
// A tiny, explicit state machine — not just a boolean — because "not
// ready yet" and "actively working on it" are different, useful signals
// for a client deciding whether to keep waiting a moment longer or give
// up and search un-warmed:
//   'starting' — process is up, no warm-up has been kicked off yet.
//   'warming'  — a warm-up cycle is currently in flight (server-boot's
//                own call, or the first /api/warmup call to reach the
//                server, whichever happens first).
//   'ready'    — at least one warm-up cycle has completed. Best-effort,
//                same as everywhere else in this file: "ready" means "we
//                tried every store," not "every store necessarily
//                succeeded" — a store that failed to warm just pays its
//                normal lazy-init cost on its own first real search,
//                same as always.
export type BackendStatus = 'starting' | 'warming' | 'ready';

interface KeyState {
  status: BackendStatus;
  lastResult: WarmupResult | null;
}

// Tracked PER WARM-UP KEY (zipcode ?? '', same convention as `inFlight`
// below) rather than as a single global flag. This backend serves every
// concurrent shopper from one shared process — a global flag meant one
// shopper's in-progress zip-specific cycle could make a DIFFERENT
// shopper's /api/warmup poll (for their own, already-warm zip) either
// falsely report 'warming' (harmless — just an extra poll), or, more
// seriously, falsely report 'ready' the instant some OTHER shopper's
// unrelated cycle happened to be the last one to finish — even though
// THIS shopper's own zip-specific locator warm-up was still genuinely in
// flight. `pollUntilReady` (warmupStore.ts) trusts `status === 'ready'`
// alone to stop waiting, so that false-ready silently defeated warm-up
// for concurrent multi-shopper traffic. Scoping by key makes each
// shopper's readiness reflect only their own cycle, exactly like
// `inFlight`'s dedup already does for the work itself.
const stateByKey = new Map<string, KeyState>();
// Same reference point perfLog's own `+Nms` uses — module load time is,
// for all practical purposes, process start.
const processStartedAt = Date.now();

function keyFor(zipcode?: string): string {
  return zipcode ?? '';
}

function getKeyState(key: string): KeyState {
  let state = stateByKey.get(key);
  if (!state) {
    state = { status: 'starting', lastResult: null };
    stateByKey.set(key, state);
  }
  return state;
}

export interface BackendReadiness {
  status: BackendStatus;
  /** `status === 'ready'` restated as a plain boolean — the one field a
   * client genuinely needs to make a "wait or proceed" decision, without
   * having to know this module's specific status strings. */
  searchReady: boolean;
  uptimeMs: number;
  /** The most recently *completed* warm-up cycle's own result, when one
   * exists — omitted while `status` is 'starting'/'warming' and no prior
   * cycle has ever finished (e.g. the very first request after boot). */
  lastResult: WarmupResult | null;
}

/** A synchronous, instant snapshot — never awaits anything, never
 * triggers work. This is what makes /api/warmup safe to respond from
 * immediately (see that route). Scoped to `zipcode` (defaulting to the
 * zip-less key) — see `stateByKey`'s own comment for why this must never
 * be a single global flag shared across every concurrent shopper. */
export function getBackendReadiness(zipcode?: string): BackendReadiness {
  const state = getKeyState(keyFor(zipcode));
  return {
    status: state.status,
    searchReady: state.status === 'ready',
    uptimeMs: Date.now() - processStartedAt,
    lastResult: state.lastResult,
  };
}

export interface WarmupStoreResult {
  store: string;
  ok: boolean;
  ms: number;
  error?: string;
}

export interface WarmupResult {
  startedAt: number;
  completedAt: number;
  totalMs: number;
  zipcode?: string;
  stores: WarmupStoreResult[];
}

interface WarmupTask {
  store: string;
  run: () => Promise<void>;
}

/**
 * Mobile perf pass — a single slow store (in practice, Trader Joe's own
 * browser-session warm-up: a real headless-Chromium page load, the long
 * pole of this whole list) used to let `/api/warmup`'s response — and so
 * the client's `warmupStatus` — hang for 30+ real seconds, long past the
 * point a shopper has already typed a query and pressed search, which
 * defeats the entire point of warming up. `warmAll` now caps how long it
 * waits on any ONE task; a task that blows through the budget is reported
 * the same way a real failure already is (`ok: false`, best-effort only —
 * see this function's own header comment) rather than being allowed to
 * hold up every other store's already-real result. The underlying
 * request is never aborted — a slow store's own warm function still runs
 * to completion in the background and populates its module-level cache
 * whenever it does finish, so a shopper searching that store moments
 * later can still benefit from it; this only stops /api/warmup itself
 * from waiting on it.
 */
const PER_STORE_TIMEOUT_MS = 8000;

function withTimeout(promise: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Runs every task in parallel, times each one individually, and never lets
 * one task's failure (or now, its timeout — see PER_STORE_TIMEOUT_MS above)
 * affect another's — a warm-up is pure optimization, so a store whose
 * session/token fetch fails or is still slow here just means that store
 * pays its normal lazy-init cost on its own first real search instead,
 * exactly like before this feature existed. Pulled out of `runWarmup`
 * (which also owns the real store list + dedup singleton) so this
 * aggregation/timing logic is unit-testable against fake tasks, without
 * hitting real network.
 */
export async function warmAll(tasks: WarmupTask[], timeoutMs: number = PER_STORE_TIMEOUT_MS): Promise<WarmupStoreResult[]> {
  return Promise.all(
    tasks.map(async ({ store, run }) => {
      const start = Date.now();
      try {
        await withTimeout(run(), timeoutMs);
        const ms = Date.now() - start;
        perfLog('warmup:store-complete', { store, ok: true, ms });
        return { store, ok: true, ms };
      } catch (err) {
        const ms = Date.now() - start;
        const error = err instanceof Error ? err.message : String(err);
        perfLog('warmup:store-complete', { store, ok: false, ms, error });
        return { store, ok: false, ms, error };
      }
    }),
  );
}

function buildTasks(zipcode?: string): WarmupTask[] {
  return [
    { store: "Trader Joe's", run: () => warmTraderJoes(zipcode) },
    { store: 'Sprouts', run: () => warmSprouts(zipcode) },
    { store: 'Kroger', run: () => warmKroger(zipcode) },
    { store: 'Aldi', run: () => warmAldi(zipcode) },
    // No product session to warm (see albertsonsLiveScraper.ts) — this only
    // pre-fetches the real store-location directory so the first search
    // that touches Albertsons isn't slowed by it.
    { store: 'Albertsons', run: () => warmAlbertsonsDirectory() },
    // Same OAuth token as Kroger (already warmed above) — this only pays
    // the Harris Teeter-specific nearest-location lookup.
    { store: 'Harris Teeter', run: () => warmHarrisTeeter(zipcode) },
  ];
}

// A warm-up already in flight is shared rather than duplicated — guards
// against the server-boot self-warm and an app-open /api/warmup call
// overlapping, and against duplicate app-open calls (app reload, component
// remount, a shopper backgrounding/reopening quickly). Keyed by zipcode so
// a *different* zip still triggers its own (zip-specific) locator warm-up
// rather than silently reusing another zip's in-flight result; the
// zip-independent pieces (token/session/directory) are already deduped one
// level down by each store's own module-level cache regardless.
const inFlight = new Map<string, Promise<WarmupResult>>();

// Below this age, a key that already reached 'ready' is treated as still
// good rather than re-running the full 6-store pass again — observed
// live: a shopper's app backgrounding/reopening quickly, a component
// remount, or the client's own poll loop calling back in after this
// cycle already finished (see warmupStore.ts's per-attempt poll loop and
// its retry scheduling) were all re-triggering a real, if mostly cheap,
// second orchestration pass — and, for the couple of stores whose own
// warm function isn't a pure cache-hit (observed: Kroger/Harris Teeter,
// ~300-500ms even when "already warm"), that redundant pass flashed this
// key's status back to 'warming' for real work that had already just
// been done, needlessly making a shopper's very next poll wait again.
// Short and purely a debounce against back-to-back re-triggers, NOT a
// substitute for each store's own freshness handling (Aldi/Sprouts'
// session-cookie reuse window, Kroger's token expiry, ...) — those are
// unconditionally re-checked on every real search regardless of this
// flag, so this cooldown expiring (or not existing at all) was never
// what kept stale sessions from being used; it only ever gated how long
// a shopper's FIRST search waits before proceeding.
const READY_COOLDOWN_MS = 30_000;

export function runWarmup(zipcode?: string): Promise<WarmupResult> {
  const key = keyFor(zipcode);
  const existing = inFlight.get(key);
  if (existing) {
    perfLog('warmup:reused-in-flight', { zipcode, status: getKeyState(key).status });
    return existing;
  }

  const state = getKeyState(key);

  if (state.status === 'ready' && state.lastResult && Date.now() - state.lastResult.completedAt < READY_COOLDOWN_MS) {
    perfLog('warmup:already-ready', { zipcode, ageMs: Date.now() - state.lastResult.completedAt });
    return Promise.resolve(state.lastResult);
  }

  const startedAt = Date.now();
  // 'ready' -> 'warming' too, not just 'starting' -> 'warming': a second,
  // later warm-up cycle for this SAME key (e.g. a shopper re-opening the
  // app after their session cookie's reuse window lapsed) genuinely means
  // "not completely settled right now" again for however long IT takes,
  // even though the earlier cycle's results are still the best data
  // `lastResult` has until this one finishes too. Scoped to this key only
  // — see `stateByKey`'s own comment for why a different key's status must
  // never be affected by this.
  state.status = 'warming';
  perfLog('warmup:start', { zipcode, phase: zipcode ? 'full' : 'session-only', uptimeMs: Date.now() - processStartedAt });

  const promise = warmAll(buildTasks(zipcode)).then((stores) => {
    const completedAt = Date.now();
    const result: WarmupResult = {
      startedAt,
      completedAt,
      totalMs: completedAt - startedAt,
      zipcode,
      stores,
    };
    state.lastResult = result;
    state.status = 'ready';
    const okCount = stores.filter((s) => s.ok).length;
    perfLog('warmup:complete', { zipcode, totalMs: result.totalMs, ok: `${okCount}/${stores.length}` });
    return result;
  });

  inFlight.set(key, promise);
  // Once settled, let a later call retry (e.g. after a transient network
  // failure) instead of permanently caching a failed attempt's promise.
  promise.finally(() => inFlight.delete(key));
  return promise;
}

/** The one thing /api/warmup itself should ever call — starts (or
 * reuses, via `runWarmup`'s own `inFlight` dedup) a real warm-up cycle
 * entirely in the background and returns immediately, `void`. The
 * critical difference from calling `runWarmup` directly: nothing here
 * can ever be awaited by an HTTP handler, which is what makes it
 * structurally impossible to reintroduce the original bug (the route
 * blocking its own response on this). `runWarmup` itself never actually
 * rejects in practice (`warmAll` catches every task's own failure), but
 * the `.catch` stays as a defensive backstop against a genuinely
 * unexpected throw turning into an unhandled rejection. */
export function ensureWarmupStarted(zipcode?: string): void {
  runWarmup(zipcode).catch((err) => {
    console.error('[Warmup] Unexpected error starting warm-up:', err);
  });
}

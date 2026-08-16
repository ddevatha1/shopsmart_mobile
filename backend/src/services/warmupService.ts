/**
 * Orchestrates app-startup warm-up: moves the one-time initialization costs
 * that used to be paid by whichever request happened to arrive first
 * (Kroger's OAuth2 token, Aldi/Sprouts' anonymous session cookies, Trader
 * Joe's browser session + store directory, and — once a zip is known —
 * each store's nearest-location lookup) out of the search path entirely.
 *
 * Two call sites use this:
 *   - index.ts calls `ensureWarmupStarted()` with no zip at server boot,
 *     fire-and-forget, to pre-warm everything that doesn't depend on a
 *     shopper's location before any request arrives.
 *   - routes/warmup.ts calls `ensureWarmupStarted(zipcode)` per app-open,
 *     once the app knows (or the shopper has previously saved) a zip, to
 *     also warm the per-store nearest-location caches for that specific
 *     area — fire-and-forget, exactly like the boot-time call.
 *
 * Root cause of a real, confirmed bug: `/api/warmup`'s handler used to
 * `await runWarmup(zipcode)` directly, so the HTTP response itself was
 * blocked on the full warm-up cycle completing (every store's session/
 * token/location bootstrap, with no per-store bound) — observed live as
 * the client's own request timeout firing before the backend ever
 * responded. The fix: never await the actual warm-up work from the route.
 * `ensureWarmupStarted` kicks it off (or, via `runWarmup`'s own `inFlight`
 * dedup, reuses an already-running cycle) fully in the background;
 * `getBackendReadiness` reports the CURRENT real readiness state,
 * synchronously, so the route always has something honest to respond with
 * immediately regardless of how far along the real warm-up is.
 */
import { warmKroger } from './krogerLiveScraper.ts';
import { warmAldi } from './aldiLiveScraper.ts';
import { warmSprouts } from './sproutsLiveScraper.ts';
import { warmTraderJoes } from './traderJoesLiveScraper.ts';
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
//   'ready'    — at least one warm-up cycle has completed. Best-effort:
//                "ready" means "we tried every store," not "every store
//                necessarily succeeded" — a store that failed to warm just
//                pays its normal lazy-init cost on its own first real
//                search, same as always.
export type BackendStatus = 'starting' | 'warming' | 'ready';

interface KeyState {
  status: BackendStatus;
  lastResult: WarmupResult | null;
}

// Tracked PER WARM-UP KEY (zipcode ?? '', same convention as `inFlight`
// below) rather than as a single global flag. This backend serves every
// concurrent shopper from one shared process — a global flag would mean
// one shopper's in-progress zip-specific cycle could make a DIFFERENT
// shopper's /api/warmup poll (for their own, already-warm zip) falsely
// report 'warming' (harmless — just an extra poll) or, worse, falsely
// report 'ready' the instant some OTHER shopper's unrelated cycle
// happened to finish last, even though THIS shopper's own zip-specific
// warm-up was still genuinely in flight. Scoping by key makes each
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
   * client genuinely needs to make a "wait or proceed" decision. */
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

export interface WarmupTask {
  store: string;
  run: () => Promise<void>;
}

/**
 * Runs every task in parallel, times each one individually, and never lets
 * one task's failure affect another's — a warm-up is pure optimization, so
 * a store whose session/token fetch fails here just means that store pays
 * its normal lazy-init cost on its own first real search instead, exactly
 * like before this feature existed. Pulled out of `runWarmup` (which also
 * owns the real store list + dedup singleton) so this aggregation/timing
 * logic is unit-testable against fake tasks, without hitting real network.
 */
export async function warmAll(tasks: WarmupTask[]): Promise<WarmupStoreResult[]> {
  return Promise.all(
    tasks.map(async ({ store, run }) => {
      const start = Date.now();
      try {
        await run();
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
// good rather than re-running the full warm-up pass again. Root cause of
// a real, confirmed production bug this fixes: `inFlight`'s dedup above
// only covers a cycle that's still genuinely running — the instant a
// completed cycle's promise settles, it's removed from `inFlight` (see
// the `.finally()` below), so the very next call to this function (the
// client's own next /api/warmup poll, at whatever interval it polls on)
// had nothing left to dedup against and unconditionally restarted a
// brand new cycle, synchronously resetting `state.status` back to
// 'warming' before that new cycle's own `.then()` could possibly run.
// Because `getBackendReadiness` is read synchronously, in the same tick,
// by the route that calls this (see routes/warmup.ts — never awaited),
// every single poll observed the freshly-reset 'warming' state it had
// itself just caused, no matter how many times a shopper's client polled
// or how long the backend had genuinely been warm. Confirmed live: 10
// consecutive polls against production, several seconds apart, each one
// reporting `status: "warming"` — even though every store's own warm
// function reported `ok: true` in single-digit milliseconds each time,
// meaning there was no real warm-up work left to do at all. This cache
// window is short and purely a debounce against back-to-back re-triggers
// (a shopper's app backgrounding/reopening quickly, a component remount,
// the client's own poll loop calling back in) — NOT a substitute for each
// store's own freshness handling (Aldi/Sprouts' session-cookie reuse
// window, Kroger's token expiry, ...), which is unconditionally
// re-checked on every real search regardless of this flag. It only ever
// gates how long a shopper's first search waits before proceeding.
const READY_COOLDOWN_MS = 30_000;

/** `tasksOverride` exists purely for testability (see this file's own
 * warmAll doc comment on why runWarmup itself is otherwise untested here
 * — it wires in the real Kroger/Aldi/Sprouts/Trader Joe's warm functions,
 * which genuinely hit live network/credentials) — both real call sites
 * (index.ts at boot, routes/warmup.ts per request) call this with a
 * single `zipcode` argument, unchanged. */
export function runWarmup(zipcode?: string, tasksOverride?: WarmupTask[]): Promise<WarmupResult> {
  const key = keyFor(zipcode);
  const existing = inFlight.get(key);
  if (existing) return existing;

  const state = getKeyState(key);

  if (state.status === 'ready' && state.lastResult && Date.now() - state.lastResult.completedAt < READY_COOLDOWN_MS) {
    perfLog('warmup:already-ready', { zipcode, ageMs: Date.now() - state.lastResult.completedAt });
    return Promise.resolve(state.lastResult);
  }

  state.status = 'warming';

  const startedAt = Date.now();
  perfLog('warmup:start', { zipcode });

  const promise = warmAll(tasksOverride ?? buildTasks(zipcode)).then((stores) => {
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

/** The one thing /api/warmup itself (and server boot) should ever call —
 * starts (or reuses, via `runWarmup`'s own `inFlight` dedup) a real
 * warm-up cycle entirely in the background and returns immediately,
 * `void`. The critical difference from calling `runWarmup` directly:
 * nothing here can ever be awaited by an HTTP handler, which is what
 * makes it structurally impossible to reintroduce the original blocking
 * bug (the route awaiting this). `runWarmup` itself never actually
 * rejects in practice (`warmAll` catches every task's own failure), but
 * the `.catch` stays as a defensive backstop against a genuinely
 * unexpected throw turning into an unhandled rejection. */
export function ensureWarmupStarted(zipcode?: string): void {
  runWarmup(zipcode).catch((err) => {
    console.error('[Warmup] Unexpected error starting warm-up:', err);
  });
}

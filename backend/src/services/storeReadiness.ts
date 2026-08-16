/**
 * Per-store readiness registry — separate from warmupService.ts's
 * `BackendStatus`, which tracks whether a whole warm-up *cycle* (all
 * stores, for one zip key) has run. This tracks each store's own
 * session/token bootstrap independently, so the search path can ask "is
 * THIS store's session already warm?" without caring whether the other
 * five are, and without waiting on warm-up as a whole.
 *
 * Root cause this exists to fix: search never awaited warm-up (good), but
 * Trader Joe's own scraper still called its session-bootstrap function
 * (a real headless-Chromium launch + storefront visit, ~3-30s) directly
 * inside the search path whenever no session was cached yet — so an
 * unlucky search that raced a cold server (or a session that had never
 * been warmed at all) paid that cost inline, blocking that store's whole
 * `Promise.allSettled` branch, and so the overall search response, for as
 * long as the browser launch took. This registry lets a store's search
 * function check readiness first and skip (or use a cheap path) instead
 * of ever creating an expensive session inline. See traderJoesLiveScraper.ts
 * for the store that actually needed this; the API-only stores (Kroger,
 * Aldi, Sprouts) register too, purely for the `storeStatus` snapshot and
 * `[SearchUsedColdPath]` observability, since their own session bootstrap
 * is already cheap enough to never need skipping.
 */
// Same "elapsed since this module loaded, i.e. since process boot" convention
// as perfLog.ts/warmupService.ts's own independent clocks — close enough in
// practice since all three load within the same process startup.
const processStartedAt = Date.now();

export type StoreKey = 'kroger' | 'aldi' | 'sprouts' | 'traderjoes' | 'albertsons' | 'harristeeter' | 'tomthumb' | 'wholefoods' | 'publix';

export type StoreReadyState = 'warming' | 'ready';

const ALL_STORE_KEYS: StoreKey[] = ['kroger', 'aldi', 'sprouts', 'traderjoes', 'albertsons', 'harristeeter', 'tomthumb', 'wholefoods', 'publix'];

const state = new Map<StoreKey, StoreReadyState>();

/** A store not yet observed at all defaults to 'warming' — true for every
 * store until its first session/token bootstrap (warm-up or a real
 * search) actually completes. */
export function getStoreStatus(): Record<StoreKey, StoreReadyState> {
  const status = {} as Record<StoreKey, StoreReadyState>;
  for (const key of ALL_STORE_KEYS) {
    status[key] = state.get(key) ?? 'warming';
  }
  return status;
}

export function isStoreReady(store: StoreKey): boolean {
  return state.get(store) === 'ready';
}

export function markStoreWarming(store: StoreKey): void {
  if (state.get(store) === 'warming') return;
  state.set(store, 'warming');
}

export function markStoreReady(store: StoreKey): void {
  const wasReady = state.get(store) === 'ready';
  state.set(store, 'ready');
  if (!wasReady) {
    console.log(`[StoreReady] ${store} +${Date.now() - processStartedAt}ms`);
  }
}

/** Logged from a store's search function when it skips that store for
 * this search rather than blocking on an expensive session bootstrap —
 * session establishment continues in the background so the NEXT search
 * benefits. */
export function logSearchSkippedStore(store: StoreKey, reason: string): void {
  console.log(`[SearchSkippedStore] ${store} — ${reason}`);
}

/** Logged from a store's search function when it pays a (cheap) inline
 * session/token bootstrap because warm-up hadn't already done it — as
 * opposed to the common case of reusing an already-warm session. Only
 * ever emitted for stores whose bootstrap is cheap enough to do inline at
 * all (see this file's own header comment) — Trader Joe's uses
 * `logSearchSkippedStore` instead. */
export function logSearchUsedColdPath(store: StoreKey, ms: number): void {
  console.log(`[SearchUsedColdPath] ${store} +${ms}ms`);
}

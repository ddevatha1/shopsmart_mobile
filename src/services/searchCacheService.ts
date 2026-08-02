import type { SearchResponse } from '../models/types';
import { searchRepository } from '../repositories/searchRepository';
import { perfLog } from '../utils/perfLog';

/**
 * Session-level search cache — "every future search in the same session
 * remains fast," not just the first one. Two things this buys, on top of
 * the app-startup backend warm-up (see warmupStore.ts/backend's
 * warmupService.ts, which pays each store's one-time session/token cost
 * before a shopper ever searches):
 *
 *  1. A repeated identical search (re-opening a product from a "Recent
 *     searches" chip, backing out of Compare and re-entering the same
 *     query, pull-to-refresh on an unchanged query) resolves from memory
 *     instead of re-hitting every store live.
 *  2. Concurrent identical in-flight requests (e.g. a fast double-tap on
 *     the same suggested-search chip) share one real network call rather
 *     than firing two.
 *
 * Deliberately in-memory only (cleared on app restart, never persisted) —
 * grocery prices/availability are real, live data that must never go
 * stale across sessions; a short TTL bounds how stale a *within-session*
 * cache hit can be even then.
 */

interface CacheEntry {
  response: SearchResponse;
  cachedAt: number;
}

// Long enough that re-tapping a just-searched term (or a chip that maps
// to the same query) feels instant; short enough that a shopper who
// lingers in the app for a while still sees fresh prices, not a stale
// snapshot from early in the session.
const CACHE_TTL_MS = 5 * 60 * 1000;

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<SearchResponse>>();

// Bounds memory over a long-lived app session: a query nobody ever
// searches again after its entry expires (the common case — most
// searches are one-off, not repeats) would otherwise sit in `cache`
// forever, since the only other read path (getCachedOrFetchSearch below)
// only evicts a stale entry when THAT exact key is looked up again. A
// shopper who leaves the app open/backgrounded for hours across many
// distinct searches is exactly the case this exists for — a fresh app
// launch clears everything anyway (module-scoped, never persisted), so
// this only ever matters within one long session. Lazily started on the
// first cache write (an app session with no searches yet runs no timer).
let sweepTimer: ReturnType<typeof setInterval> | null = null;
function scheduleSweep(): void {
  if (sweepTimer) return;
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of cache) {
      if (now - entry.cachedAt >= CACHE_TTL_MS) cache.delete(key);
    }
  }, CACHE_TTL_MS);
  // React Native's timer handle is a plain number with no `unref` — this
  // only ever does something under Jest/Node (where a pending interval
  // would otherwise keep the test process alive after the test itself is
  // done); a no-op, not a crash, everywhere else. Cast rather than typed
  // as NodeJS.Timeout throughout, since RN's own lib types have
  // `setInterval` return a number, not that type.
  (timer as unknown as { unref?: () => void }).unref?.();
  sweepTimer = timer;
}

// Coordinates are rounded to ~3 decimal places (~100m) so ordinary GPS
// jitter between two taps of the *same* query doesn't fragment the cache
// key into always-distinct, always-missing entries.
function cacheKey(query: string, zipcode: string, noCorrect?: boolean, latitude?: number, longitude?: number): string {
  const lat = latitude != null ? latitude.toFixed(3) : '';
  const lng = longitude != null ? longitude.toFixed(3) : '';
  return `${query.trim().toLowerCase()}|${zipcode}|${noCorrect ? 1 : 0}|${lat}|${lng}`;
}

export interface CachedSearchResult {
  response: SearchResponse;
  /** True when this resolved from the in-memory cache without a network
   * call — the one thing the "before/after" perf logging below can't see
   * on its own (a cache hit and a genuinely fast network response both
   * just look like "fast"). */
  cacheHit: boolean;
}

/** Search through the session cache — a cache hit resolves synchronously-
 * fast with no network call; a miss (or expired entry) falls through to
 * `searchRepository.search` and caches the real result for next time.
 * Never caches a failed request — a thrown error propagates as-is, and
 * the next attempt (whether identical or not) always gets a fresh try. */
export async function getCachedOrFetchSearch(
  query: string,
  zipcode: string,
  options?: { noCorrect?: boolean; latitude?: number; longitude?: number },
): Promise<CachedSearchResult> {
  const key = cacheKey(query, zipcode, options?.noCorrect, options?.latitude, options?.longitude);

  const cached = cache.get(key);
  if (cached) {
    if (Date.now() - cached.cachedAt < CACHE_TTL_MS) {
      perfLog('search:cache-hit', { query, ageMs: Date.now() - cached.cachedAt });
      return { response: cached.response, cacheHit: true };
    }
    // Expired — evict now rather than leaving it for the periodic sweep,
    // same reasoning as backend/src/utils/ttlCache.ts's own `get()`.
    cache.delete(key);
  }

  const existingRequest = inFlight.get(key);
  if (existingRequest) {
    perfLog('search:cache-join-inflight', { query });
    return { response: await existingRequest, cacheHit: false };
  }

  perfLog('search:cache-miss', { query });
  const request = searchRepository.search(query, zipcode, options).then((response) => {
    cache.set(key, { response, cachedAt: Date.now() });
    scheduleSweep();
    return response;
  });
  inFlight.set(key, request);
  try {
    return { response: await request, cacheHit: false };
  } finally {
    inFlight.delete(key);
  }
}

/** Test-only escape hatch — production code never needs to clear this
 * (a fresh app launch already starts with an empty, module-scoped cache). */
export function clearSearchCacheForTests(): void {
  cache.clear();
  inFlight.clear();
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

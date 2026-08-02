import { create, type StoreApi } from 'zustand';
import { apiClient, type WarmupResult } from '../services/apiClient';
import { getCachedOrFetchSearch } from '../services/searchCacheService';
import { perfLog } from '../utils/perfLog';

export type WarmupStatus = 'idle' | 'warming' | 'ready' | 'error';

/** A common, cheap query used to pay the backend's per-store "first query"
 * cost (parsing/matching/etc.) in the background, so a shopper's actual
 * first search never has to. */
const BACKGROUND_WARMUP_QUERY = 'milk';

// The backend's /api/warmup now answers "are you ready yet?" from an
// in-memory snapshot in single-digit ms (see apiClient.ts's own comment) —
// cheap enough to ask repeatedly instead of firing one request and either
// getting a final answer or nothing. Each foreground warm-up attempt polls
// up to POLL_MAX_ATTEMPTS times, POLL_INTERVAL_MS apart, genuinely
// checking real backend state each time rather than guessing from a
// fixed delay. Independent of (and typically much shorter than)
// searchStore.ts's own FIRST_SEARCH_WARMUP_WAIT_CAP_MS, which races
// whatever this loop is doing against its own separate ceiling — a first
// search is never held up by this loop continuing past that cap.
const POLL_INTERVAL_MS = 1500;
const POLL_MAX_ATTEMPTS = 4;

/** Scheduled when a poll cycle ends without reaching 'ready' — either the
 * backend was genuinely unreachable (dead connection, DNS failure) or it
 * answered every poll with 'starting'/'warming' but never finished within
 * this attempt's budget (a real, still-in-progress Render cold start
 * outlasting it). Either way, fully decoupled from whatever caller
 * triggered the original attempt, so nothing user-facing ever waits on
 * these. One retry at +3s, one more at +8s; after that we stop and just
 * let the shopper's real first search pay the normal lazy-init cost, same
 * as if warm-up didn't exist. */
const RETRY_DELAYS_MS = [3000, 8000];

interface WarmupState {
  status: WarmupStatus;
  result: WarmupResult | null;
  /** Guards the throwaway background search below so it fires at most once
   * per app session no matter how many times `warmup()` itself is called
   * (once at cold launch with no zip yet, again after sign-up/hydration
   * once a real zip exists). */
  backgroundSearchDone: boolean;
  /** Guards markFirstSearchStart/markFirstSearchComplete so only the very
   * first search of this app session gets the extra `[Perf] first-search:*`
   * logging — every later search is expected (and unremarkable) to be
   * fast, warm-up or not. */
  firstSearchStarted: boolean;
  firstSearchLogged: boolean;
  /** Fire-and-forget background warm-up — called twice per session by
   * design (see App.tsx): once immediately at launch with no zip (warms
   * the zip-independent pieces — Kroger OAuth, Aldi/Sprouts sessions,
   * Trader Joe's browser session — as early as physically possible,
   * before even the on-device user-hydration read completes), and again
   * once a real zip is known (warms the zip-specific nearest-store
   * lookups and runs the background dummy search). Never throws: a
   * failed warm-up just means search pays its normal lazy-init cost on
   * the first request, exactly like before this feature existed.
   * Deduped PER ZIP KEY (not globally) — a zip-specific call while the
   * zip-less one is still in flight runs as its own real, independent
   * attempt instead of silently reusing (and so never actually warming
   * the zip-specific lookups for) the earlier one. */
  warmup: (zipcode?: string) => Promise<void>;
  /** Resolves once the most recently *started* warm-up attempt has fully
   * settled (backend warm-up AND, when a zip is known, the background
   * dummy search) — awaited by the search flow's very first real search
   * so it never races an in-flight warm-up (see searchStore.ts). A no-op
   * (resolves immediately) if no warm-up has been kicked off yet, or the
   * latest one already finished. Bounded indirectly by
   * ApiClient.warmup's own request timeout, so this can never hang the
   * search flow indefinitely even if the backend never responds.
   *
   * `maxWaitMs`, when given, adds a SECOND, shorter ceiling on top of
   * that — "do not block the UI" means a shopper's first search
   * shouldn't necessarily sit through the full worst-case warm-up
   * duration just because one happens to still be in flight. When the
   * cap is hit first, this resolves anyway (with warm-up left running in
   * the background) and the search proceeds un-warmed, exactly as if no
   * warm-up had been requested at all. */
  waitForWarmup: (maxWaitMs?: number) => Promise<void>;
  /** Called once by the search flow, right before the very first search of
   * the app session fires — logs a `[Perf] first-search:start` line and,
   * if warm-up is still in progress, notes that the search is racing it. */
  markFirstSearchStart: () => void;
  markFirstSearchComplete: () => void;
}

// Keyed exactly like the backend's own runWarmup dedup (zipcode ?? '') —
// see warmup()'s own comment for why a single global in-flight slot (the
// previous implementation) was a real bug, not just a simplification.
const inFlightByKey = new Map<string, Promise<void>>();
// The most recently *started* attempt, regardless of key — what
// waitForWarmup() actually awaits, since "whichever attempt is currently
// most relevant" is always the newest one.
let latestAttempt: Promise<void> | null = null;

type SetWarmupState = StoreApi<WarmupState>['setState'];
type GetWarmupState = StoreApi<WarmupState>['getState'];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type PollOutcome =
  | { kind: 'ready'; result: WarmupResult }
  | { kind: 'still-warming' }
  | { kind: 'unreachable' };

/** Polls /api/warmup up to POLL_MAX_ATTEMPTS times, genuinely checking
 * real backend state each time, until it reports 'ready' or the budget
 * runs out. Every poll is logged individually (attempt start, response
 * time, real backend status) so a slow warm-up is diagnosable from these
 * logs alone — see this module's own success criteria. */
async function pollUntilReady(
  zipcode: string | undefined,
  phase: 'session-only' | 'full',
  attempt: number,
): Promise<PollOutcome> {
  for (let poll = 1; poll <= POLL_MAX_ATTEMPTS; poll++) {
    const pollStart = Date.now();
    const result = await apiClient.warmup(zipcode);
    const pollMs = Date.now() - pollStart;

    if (!result) {
      perfLog('warmup:poll-unreachable', { zipcode, phase, attempt, poll, pollMs });
      return { kind: 'unreachable' };
    }
    perfLog('warmup:poll-status', { zipcode, phase, attempt, poll, pollMs, status: result.status });
    if (result.status === 'ready') {
      return { kind: 'ready', result };
    }
    if (poll < POLL_MAX_ATTEMPTS) await delay(POLL_INTERVAL_MS);
  }
  return { kind: 'still-warming' };
}

/** Runs one warm-up attempt (poll-until-ready against `/api/warmup`, then
 * the background dummy search once a zip is known) and, when it doesn't
 * reach 'ready' within this attempt's poll budget, schedules up to
 * `RETRY_DELAYS_MS.length` more attempts entirely in the background —
 * decoupled from this promise, which always settles after THIS attempt
 * so callers (App.tsx, waitForWarmup()) are never held up waiting on
 * retries they didn't ask for. Extracted out of the store definition so
 * retries can re-invoke it directly instead of going through the public
 * `warmup()` action (which would otherwise treat a retry as "already in
 * flight" and no-op if called too eagerly, or fight the dedup key if
 * called after `inFlightByKey` already cleared it). */
function runWarmupAttempt(
  zipcode: string | undefined,
  attempt: number,
  set: SetWarmupState,
  get: GetWarmupState,
): Promise<void> {
  const key = zipcode ?? '';
  // Zip-less calls only ever pay for session/token setup (cheap, shared
  // across every store via dedupeInFlight on the backend); only a
  // zip-specific call additionally resolves nearest-store locations. Two
  // `warmup:start` lines with different `phase`s is the expected,
  // intentional shape of a healthy session — not duplicated work.
  const phase = zipcode ? 'full' : 'session-only';

  set({ status: 'warming' });
  const launchedAt = Date.now();
  perfLog('warmup:start', { zipcode, phase, attempt, endpoint: '/api/warmup' });

  return (async () => {
    const outcome = await pollUntilReady(zipcode, phase, attempt);
    const totalMs = Date.now() - launchedAt;

    if (outcome.kind === 'unreachable') {
      // Best-effort only — search still works, it just won't have had
      // the benefit of warm-up. Never surfaced as a user-facing error.
      // The actual failure reason (timeout vs. HTTP error vs. network
      // error) was already logged inside apiClient.warmup, right at the
      // network boundary where it's actually known.
      perfLog('warmup:backend-failed', { zipcode, phase, attempt, totalMs });
      set({ status: 'error' });
      scheduleRetryIfWarranted(zipcode, phase, attempt, key, set, get);
      return;
    }

    if (outcome.kind === 'still-warming') {
      // The backend answered every poll and is genuinely, confirmedly
      // still working — never reported as 'error' (that would be
      // dishonest; the backend IS alive and making progress, it just
      // didn't finish within this attempt's own poll budget, most likely
      // a real Render cold start). Status stays 'warming' and a further
      // background attempt keeps checking.
      perfLog('warmup:still-warming-after-poll-budget', { zipcode, phase, attempt, totalMs });
      set({ status: 'warming' });
      scheduleRetryIfWarranted(zipcode, phase, attempt, key, set, get);
      return;
    }

    // outcome.kind === 'ready'
    const result = outcome.result;
    set({ result });
    const okCount = result.stores?.filter((s) => s.ok).length ?? 0;
    const storeTotal = result.stores?.length ?? 0;
    perfLog('warmup:backend-ready', { zipcode, phase, attempt, totalMs, ok: `${okCount}/${storeTotal}` });

    // Immediately follow the backend warm-up with one throwaway search —
    // the backend's remaining per-store lazy-init cost (query parsing,
    // catalog matching, etc.) is paid on THIS request instead of the
    // shopper's real first search. Fully discarded as far as UI state
    // goes: never touches useSearchStore, so there's no `hasSearched`/
    // `loading`/`products` state anywhere for it to leak into and no
    // loading UI can show for it. Routed through the same session search
    // cache (searchCacheService.ts) a real search uses, though — not
    // fully discarded there: if a shopper's actual first search happens
    // to BE this exact query (a very common one — "milk"), it now
    // resolves from cache instead of paying for a second live fetch.
    // Only fires once a real zip is known — a query against no zip
    // wouldn't exercise the same per-store code path a real search does.
    if (zipcode && zipcode.length === 5 && !get().backgroundSearchDone) {
      set({ backgroundSearchDone: true });
      perfLog('warmup:dummy-search:start', { zipcode });
      try {
        await getCachedOrFetchSearch(BACKGROUND_WARMUP_QUERY, zipcode, { noCorrect: true });
        perfLog('warmup:dummy-search:complete', { zipcode, ms: Date.now() - launchedAt });
      } catch {
        perfLog('warmup:dummy-search:failed', { zipcode });
      }
    }

    // "Search service ready" — the one status transition the search
    // flow's waitForWarmup() actually cares about, deliberately set only
    // now (after the dummy search settles too, not right after the
    // backend warm-up response) so a shopper's first real search that
    // waits on this genuinely lands on an as-warm-as-this-session-gets
    // backend, not just "the /api/warmup poll loop itself finished."
    set({ status: 'ready' });
    perfLog('warmup:search-service-ready', {
      zipcode, phase, attempt, status: 'ready', totalMs: Date.now() - launchedAt,
    });
  })();
}

/** Retry entirely in the background: never awaited by runWarmupAttempt's
 * own promise, so it can never make waitForWarmup() (or anything chained
 * off warmup()) wait on it. Skipped once this exact key already has a
 * fresher attempt in flight (e.g. a real zip-specific warm-up superseded
 * this one) so a stale retry can't clobber newer, better state. */
function scheduleRetryIfWarranted(
  zipcode: string | undefined,
  phase: 'session-only' | 'full',
  attempt: number,
  key: string,
  set: SetWarmupState,
  get: GetWarmupState,
): void {
  if (attempt > RETRY_DELAYS_MS.length) return;
  const delayMs = RETRY_DELAYS_MS[attempt - 1];
  perfLog('warmup:retry-scheduled', { zipcode, phase, nextAttempt: attempt + 1, delayMs });
  setTimeout(() => {
    if (inFlightByKey.has(key)) return;
    if (get().status === 'ready' && get().result?.zipcode === zipcode) return;
    const retry = runWarmupAttempt(zipcode, attempt + 1, set, get);
    inFlightByKey.set(key, retry);
    latestAttempt = retry;
    retry.finally(() => inFlightByKey.delete(key));
  }, delayMs);
}

export const useWarmupStore = create<WarmupState>((set, get) => ({
  status: 'idle',
  result: null,
  backgroundSearchDone: false,
  firstSearchStarted: false,
  firstSearchLogged: false,

  warmup: async (zipcode) => {
    const key = zipcode ?? '';
    const existing = inFlightByKey.get(key);
    if (existing) {
      latestAttempt = existing;
      return existing;
    }
    if (get().status === 'ready' && get().result?.zipcode === zipcode) return;

    const run = runWarmupAttempt(zipcode, 1, set, get);
    inFlightByKey.set(key, run);
    latestAttempt = run;
    try {
      await run;
    } finally {
      inFlightByKey.delete(key);
    }
  },

  waitForWarmup: async (maxWaitMs) => {
    if (!latestAttempt) return;
    const attempt = latestAttempt;
    try {
      if (maxWaitMs == null) {
        await attempt;
        return;
      }
      let timedOut = false;
      await Promise.race([
        attempt,
        new Promise<void>((resolve) => {
          setTimeout(() => {
            timedOut = true;
            resolve();
          }, maxWaitMs);
        }),
      ]);
      if (timedOut) {
        perfLog('warmup:wait-cap-hit', { maxWaitMs, statusAtCap: get().status });
      }
    } catch {
      // warmup() never actually throws (every internal step is its own
      // try/catch) — this guard is defensive only, so a future change
      // there can never turn into an unhandled rejection here.
    }
  },

  markFirstSearchStart: () => {
    if (get().firstSearchStarted) return;
    set({ firstSearchStarted: true });
    perfLog('first-search:start', { warmupStatus: get().status });
  },

  markFirstSearchComplete: () => {
    if (get().firstSearchLogged) return;
    perfLog('first-search:complete', { warmupStatus: get().status });
    set({ firstSearchLogged: true });
  },
}));

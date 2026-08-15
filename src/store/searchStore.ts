import { create } from 'zustand';
import { STORE_NAMES, type ApiProduct, type QueryCorrectionInfo, type StoreStatus } from '../models/types';
import { searchRepository } from '../repositories/searchRepository';
import { useUserStore } from './userStore';
import { useWarmupStore } from './warmupStore';
import { recordObservations } from '../services/priceHistoryService';
import { perfLog } from '../utils/perfLog';

interface SearchState {
  hasSearched: boolean;
  loading: boolean;
  error: string | null;
  products: ApiProduct[];
  storeStatuses: StoreStatus[];
  activeQuery: string;
  activeZip: string;
  /** Set only when the backend's query-correction pipeline (see
   * backend/src/services/queryCorrection.ts) found a typo worth surfacing —
   * the "Did you mean" banner reads this directly. */
  correction: QueryCorrectionInfo | null;
  search: (query: string, options?: { noCorrect?: boolean }) => Promise<void>;
}

// A new call to search() bumps this — any in-flight response OR poll loop
// from an earlier call checks its own captured value against the CURRENT
// one before ever touching state, and simply stops (does nothing) the
// moment they no longer match. This is what makes "search 'chicken', then
// immediately search 'milk'" safe: 'chicken's late Trader Joe's result
// (arriving seconds later via the poll loop below) can never overwrite
// 'milk's already-on-screen results, because by then its own captured
// generation is stale. Module-level rather than in SearchState itself —
// nothing outside this file needs to read it, it exists purely to let
// `search()`'s own async continuations (including the poll loop, a plain
// function below rather than a store action) tell "am I still the current
// search?" apart from "a newer one has already started."
let searchGeneration = 0;

// Short enough that a fast store's arrival (see backend's
// startProgressiveSearch — it already returns as soon as the FIRST store
// settles) is picked up again quickly, without polling so aggressively it
// meaningfully adds load for what's normally only 1-3 more stores to
// resolve. Bounded duration matches the backend's own worst-case shape:
// Trader Joe's own per-store timeout is 45s (see searchService.ts) and the
// backend keeps a progressive search's session around for 60s — this stays
// comfortably inside both, so a poll loop never outlives the data it's
// polling for, and never runs meaningfully longer than the slowest store
// could ever legitimately take.
const POLL_INTERVAL_MS = 1000;
const POLL_MAX_DURATION_MS = 50_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs entirely in the background after search()'s own initial response has
 * already been applied — never awaited by search() itself, never blocks
 * anything user-facing. Polls GET /api/search/:searchId (see
 * apiClient.getSearchStatus) until either every store has a terminal
 * status, a newer search has superseded this one (see `searchGeneration`
 * above), the backend stops answering for this searchId, or
 * POLL_MAX_DURATION_MS elapses — whichever comes first. Every successful
 * poll REPLACES `products`/`storeStatuses` wholesale with the backend's own
 * current, already-deduped-and-ranked snapshot (see
 * searchService.ts#buildSnapshotResponse) rather than attempting any
 * client-side merge — the backend is the single source of truth for
 * "what's the full, correctly-sorted result set right now," so there's no
 * separate dedup/merge logic here to keep in sync with the server's own.
 */
async function pollForLateResults(searchId: string, myGeneration: number, searchStart: number): Promise<void> {
  perfLog('search:poll-start', { searchId });
  const deadline = Date.now() + POLL_MAX_DURATION_MS;

  while (Date.now() < deadline) {
    await delay(POLL_INTERVAL_MS);
    if (myGeneration !== searchGeneration) {
      perfLog('search:poll-stopped', { searchId, reason: 'superseded' });
      return;
    }

    const response = await searchRepository.status(searchId);
    if (myGeneration !== searchGeneration) {
      perfLog('search:poll-stopped', { searchId, reason: 'superseded' });
      return;
    }
    if (!response) {
      // Unknown/expired searchId, or the request itself failed — stop
      // rather than polling forever. Whatever's already on screen (from
      // the initial response or an earlier successful poll) stays exactly
      // as it is; this is never surfaced as a user-facing error.
      perfLog('search:poll-stopped', { searchId, reason: 'unreachable' });
      return;
    }

    useSearchStore.setState({
      products: response.products,
      storeStatuses: response.storeStatuses,
      correction: response.correction ?? null,
    });

    const stillPending = response.storeStatuses.some((s) => s.status === 'pending');
    if (!stillPending) {
      perfLog('search:poll-complete', { searchId, ms: Date.now() - searchStart });
      return;
    }
  }

  perfLog('search:poll-stopped', { searchId, reason: 'max-duration' });
}

export const useSearchStore = create<SearchState>((set, get) => ({
  hasSearched: false,
  loading: false,
  error: null,
  products: [],
  storeStatuses: [],
  activeQuery: '',
  activeZip: '',
  correction: null,

  // Mirrors runSearch() in page.tsx. ZIP code is never passed in — it's
  // collected once at sign-up and read from the signed-in user here, the
  // single source of truth for it everywhere in the app.
  search: async (query, options) => {
    const zipcode = useUserStore.getState().user?.zipcode ?? '';
    const isFirstSearch = !get().hasSearched;
    if (isFirstSearch) useWarmupStore.getState().markFirstSearchStart();
    const searchStart = Date.now();

    searchGeneration += 1;
    const myGeneration = searchGeneration;

    set({
      hasSearched: true,
      loading: true,
      error: null,
      products: [],
      storeStatuses: STORE_NAMES.map((store) => ({ store, status: 'loading' as const })),
      activeQuery: query,
      activeZip: zipcode,
      correction: null,
    });

    useUserStore.getState().trackSearch(query);

    try {
      // The backend's own response here already arrives as soon as the
      // FIRST store has a real result (see startProgressiveSearch) rather
      // than waiting for every store — this is genuinely the moment
      // useful results exist, not merely "the request settled," so
      // `loading` comes down right here rather than waiting on the poll
      // loop below too.
      const response = await searchRepository.search(query, zipcode, options);

      // A newer search (the shopper typed something else and hit search
      // again before this one came back) already owns `loading`/
      // `products`/etc. now — applying a stale response here would roll
      // the UI backward to an older query's results.
      if (myGeneration !== searchGeneration) {
        perfLog('search:stale-discarded', { query, ms: Date.now() - searchStart });
        return;
      }

      set({
        products: response.products,
        storeStatuses: response.storeStatuses,
        correction: response.correction ?? null,
        loading: false,
      });
      // Every search result is a real, timestamped price observation — the
      // only source of truth priceHistoryService/advisorService ever read
      // from. Fire-and-forget: never worth delaying results for.
      recordObservations(response.products);
      perfLog(isFirstSearch ? 'first-search:client-complete' : 'search:client-complete', {
        query,
        ms: Date.now() - searchStart,
        pendingCount: response.storeStatuses.filter((s) => s.status === 'pending').length,
      });
      if (isFirstSearch) useWarmupStore.getState().markFirstSearchComplete();

      // Whatever stores weren't ready yet get picked up here, fully in the
      // background — the shopper is already looking at (and can already
      // act on) whichever stores DID make it into `response`. No
      // `searchId` means the backend didn't produce a progressive/partial
      // response at all (e.g. every store was already ready), so there's
      // nothing to poll for.
      const hasPending = response.storeStatuses.some((s) => s.status === 'pending');
      if (hasPending && response.searchId) {
        void pollForLateResults(response.searchId, myGeneration, searchStart);
      }
    } catch (err) {
      if (myGeneration !== searchGeneration) {
        perfLog('search:stale-error-discarded', { query, ms: Date.now() - searchStart });
        return;
      }
      set({ error: err instanceof Error ? err.message : String(err), loading: false });
      perfLog(isFirstSearch ? 'first-search:client-error' : 'search:client-error', {
        query,
        ms: Date.now() - searchStart,
      });
      if (isFirstSearch) useWarmupStore.getState().markFirstSearchComplete();
    }
  },
}));

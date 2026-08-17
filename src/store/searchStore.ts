import { create } from 'zustand';
import { STORE_NAMES, type ApiProduct, type QueryCorrectionInfo, type StoreStatus } from '../models/types';
import { searchRepository } from '../repositories/searchRepository';
import { useGuestZipStore } from './guestZipStore';
import { useGuestSearchHistoryStore } from './guestSearchHistoryStore';
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
  /** Set only when a search couldn't determine a ZIP to search near at
   * all (location permission denied/unavailable and none was ever set) —
   * SearchScreen reads this to show "we need your location or ZIP" copy
   * instead of the generic empty-results state, which would otherwise be
   * misleading (this isn't "no products found," it's "never searched"). */
  needsLocation: boolean;
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

  // Genuinely timed out — some store(s) never reached a final state within
  // POLL_MAX_DURATION_MS (sized off the backend's own worst-case shape; see
  // this constant's header comment). Root cause of a real, confirmed UX
  // bug this fixes: leaving those stores' status as 'pending' forever once
  // polling itself stops meant the UI had no way to tell "genuinely still
  // searching" apart from "gave up but never said so" — a shopper could be
  // staring at a "still searching…" state that would in fact never update
  // again. Marking them 'error' here (only for THIS still-current search;
  // see the generation check above) gives the screen a real terminal state
  // to render instead: either the products that DID come in, or an honest
  // "no results" — never an indefinite spinner.
  if (myGeneration === searchGeneration) {
    const current = useSearchStore.getState();
    const settledStatuses = current.storeStatuses.map((s) =>
      s.status === 'pending'
        ? { ...s, status: 'error' as const, error: 'This store is taking longer than expected.' }
        : s,
    );
    useSearchStore.setState({ storeStatuses: settledStatuses });
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
  needsLocation: false,
  correction: null,

  // No account, no sign-up-collected ZIP anymore — see guestZipStore.ts.
  // A ZIP already known (a previous search, or one set by hand in
  // Settings) resolves instantly with no prompt; the very first search
  // of a session that doesn't have one yet is what triggers the real
  // native iOS location-permission dialog (via getCurrentCoordinates,
  // inside resolveZipcode) — never on app launch, only right here, right
  // when a ZIP is actually needed.
  search: async (query, options) => {
    const isFirstSearch = !get().hasSearched;
    if (isFirstSearch) useWarmupStore.getState().markFirstSearchStart();
    const searchStart = Date.now();

    searchGeneration += 1;
    const myGeneration = searchGeneration;

    // Shown immediately — resolving a ZIP (location permission prompt +
    // reverse geocode, the first time) can itself take a moment, and the
    // shopper should see "searching," not a frozen search button, for
    // every bit of that wait, not just the network request after it.
    set({
      hasSearched: true,
      loading: true,
      error: null,
      needsLocation: false,
      products: [],
      storeStatuses: STORE_NAMES.map((store) => ({ store, status: 'loading' as const })),
      activeQuery: query,
      correction: null,
    });

    const zipcode = await useGuestZipStore.getState().resolveZipcode();
    if (myGeneration !== searchGeneration) return; // superseded while resolving location

    if (!zipcode) {
      // Never a login-style barrier and never a fake permission dialog of
      // our own (see locationService.ts / guestZipStore.ts) — this is the
      // one honest thing left to tell the shopper: we genuinely don't
      // know where to search yet, and why (denied/unavailable location,
      // no ZIP ever set). SearchScreen reads `needsLocation` to show that
      // distinctly from "searched and found nothing."
      set({ loading: false, needsLocation: true, activeZip: '' });
      if (isFirstSearch) useWarmupStore.getState().markFirstSearchComplete();
      return;
    }

    set({ activeZip: zipcode });
    useGuestSearchHistoryStore.getState().track(query);

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

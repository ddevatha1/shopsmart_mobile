import { create } from 'zustand';
import { STORE_NAMES, type ApiProduct, type QueryCorrectionInfo, type StoreStatus } from '../models/types';
import { getCachedOrFetchSearch } from '../services/searchCacheService';
import { useUserStore } from './userStore';
import { useWarmupStore } from './warmupStore';
import { recordObservations } from '../services/priceHistoryService';
import { dedupeProducts } from '../utils/dedupeProducts';
import { perfLog } from '../utils/perfLog';
import { getCurrentCoordinates } from '../services/locationService';

/** Upper bound on how long the session's first search will wait for an
 * in-flight warm-up before giving up and searching un-warmed anyway — see
 * warmupStore.ts's waitForWarmup() for why this is shorter than warm-up's
 * own worst-case duration. */
const FIRST_SEARCH_WARMUP_WAIT_CAP_MS = 6000;

interface SearchState {
  hasSearched: boolean;
  loading: boolean;
  /** True only while the session's very first search is waiting on an
   * in-flight warm-up (see FIRST_SEARCH_WARMUP_WAIT_CAP_MS below) —
   * `loading` covers the whole search including this, but a UI that wants
   * to say "Preparing search…" instead of "Searching…" for just this
   * brief window (ticket: "show loading UI: Preparing search...") reads
   * this instead of trying to infer it from warmupStore's own status. */
  preparing: boolean;
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

export const useSearchStore = create<SearchState>((set, get) => ({
  hasSearched: false,
  loading: false,
  preparing: false,
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

    set({
      hasSearched: true,
      loading: true,
      preparing: false,
      error: null,
      products: [],
      storeStatuses: STORE_NAMES.map((store) => ({ store, status: 'loading' as const })),
      activeQuery: query,
      activeZip: zipcode,
      correction: null,
    });

    useUserStore.getState().trackSearch(query);

    try {
      // The one place this app deliberately waits on warm-up — only for
      // the session's very first real search, and only up to however long
      // the already-in-flight attempt takes (bounded by ApiClient.warmup's
      // own request timeout, so this can never hang forever). Every later
      // search skips this entirely: warmup() has long since settled by
      // then, so waitForWarmup() would just resolve immediately anyway.
      // This is what makes the first search actually land on
      // warmupStatus="ready" instead of racing an in-progress warm-up.
      if (isFirstSearch) {
        // "Preparing search…" instead of "Searching…" for this window
        // only — see `preparing`'s own doc comment. Only set at all when
        // warm-up is genuinely still in flight (the common case — most
        // real searches happen after warm-up already settled, in which
        // case this is skipped and there's nothing to show a distinct
        // state for).
        if (useWarmupStore.getState().status === 'warming') set({ preparing: true });
        // Capped well short of warm-up's own worst case on purpose — "do
        // not block the UI" means a cold-starting backend shouldn't force
        // a shopper's first search to sit through however long a real
        // Render cold start takes just because that attempt happened to
        // still be in flight. If the cap wins, the search proceeds
        // un-warmed (exactly like every search before this feature
        // existed) while warm-up keeps polling — and retrying — in the
        // background for whatever the shopper searches next.
        await useWarmupStore.getState().waitForWarmup(FIRST_SEARCH_WARMUP_WAIT_CAP_MS);
        if (get().preparing) set({ preparing: false });
        perfLog('first-search:warmup-awaited', {
          warmupStatus: useWarmupStore.getState().status,
          ms: Date.now() - searchStart,
        });
      }

      // Real GPS, when permission's already granted and a fix is cached/
      // cheaply available, lets store selection rank by the shopper's
      // actual position instead of only their ZIP's geocoded centroid —
      // see krogerLocator.ts. Never blocks on a fresh permission prompt for
      // this: `getCurrentCoordinates` already treats "not yet granted" as
      // null and search falls back to zip-centroid resolution exactly like
      // it always has.
      const coords = await getCurrentCoordinates();
      const { response, cacheHit } = await getCachedOrFetchSearch(query, zipcode, {
        ...options,
        latitude: coords?.latitude,
        longitude: coords?.longitude,
      });
      // Deduped once, centrally, right where a fresh product list first
      // enters app state — see dedupeProducts.ts for why (a real backend
      // duplicate produced a React "two children with the same key" on a
      // `aldi-...` product; the actual bug is fixed server-side, this is
      // the defense-in-depth every downstream list inherits for free).
      const products = dedupeProducts(response.products);
      set({
        products,
        storeStatuses: response.storeStatuses,
        correction: response.correction ?? null,
      });
      // Every search result is a real, timestamped price observation — the
      // only source of truth priceHistoryService/advisorService ever read
      // from. Fire-and-forget: never worth delaying results for.
      recordObservations(products);
      perfLog(isFirstSearch ? 'first-search:client-complete' : 'search:client-complete', {
        query,
        ms: Date.now() - searchStart,
        cacheHit,
        warmupStatus: useWarmupStore.getState().status,
      });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      perfLog(isFirstSearch ? 'first-search:client-error' : 'search:client-error', {
        query,
        ms: Date.now() - searchStart,
        warmupStatus: useWarmupStore.getState().status,
      });
    } finally {
      set({ loading: false, preparing: false });
      if (isFirstSearch) useWarmupStore.getState().markFirstSearchComplete();
    }
  },
}));

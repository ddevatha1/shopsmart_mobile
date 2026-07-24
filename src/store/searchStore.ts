import { create } from 'zustand';
import { STORE_NAMES, type ApiProduct, type QueryCorrectionInfo, type StoreStatus } from '../models/types';
import { searchRepository } from '../repositories/searchRepository';
import { useUserStore } from './userStore';
import { useWarmupStore } from './warmupStore';
import { recordObservations } from '../services/priceHistoryService';
import { perfLog } from '../utils/perfLog';
import { getCurrentCoordinates } from '../services/locationService';

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
      // Real GPS, when permission's already granted and a fix is cached/
      // cheaply available, lets store selection rank by the shopper's
      // actual position instead of only their ZIP's geocoded centroid —
      // see krogerLocator.ts. Never blocks on a fresh permission prompt for
      // this: `getCurrentCoordinates` already treats "not yet granted" as
      // null and search falls back to zip-centroid resolution exactly like
      // it always has.
      const coords = await getCurrentCoordinates();
      const response = await searchRepository.search(query, zipcode, {
        ...options,
        latitude: coords?.latitude,
        longitude: coords?.longitude,
      });
      set({
        products: response.products,
        storeStatuses: response.storeStatuses,
        correction: response.correction ?? null,
      });
      // Every search result is a real, timestamped price observation — the
      // only source of truth priceHistoryService/advisorService ever read
      // from. Fire-and-forget: never worth delaying results for.
      recordObservations(response.products);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      set({ loading: false });
      perfLog(isFirstSearch ? 'first-search:client-complete' : 'search:client-complete', {
        query,
        ms: Date.now() - searchStart,
      });
      if (isFirstSearch) useWarmupStore.getState().markFirstSearchComplete();
    }
  },
}));

import { create } from 'zustand';
import { STORE_NAMES, type ApiProduct, type StoreStatus } from '../models/types';
import { searchRepository } from '../repositories/searchRepository';
import { useUserStore } from './userStore';
import { recordObservations } from '../services/priceHistoryService';

interface SearchState {
  hasSearched: boolean;
  loading: boolean;
  error: string | null;
  products: ApiProduct[];
  storeStatuses: StoreStatus[];
  activeQuery: string;
  activeZip: string;
  search: (query: string) => Promise<void>;
}

export const useSearchStore = create<SearchState>((set) => ({
  hasSearched: false,
  loading: false,
  error: null,
  products: [],
  storeStatuses: [],
  activeQuery: '',
  activeZip: '',

  // Mirrors runSearch() in page.tsx. ZIP code is never passed in — it's
  // collected once at sign-up and read from the signed-in user here, the
  // single source of truth for it everywhere in the app.
  search: async (query) => {
    const zipcode = useUserStore.getState().user?.zipcode ?? '';
    set({
      hasSearched: true,
      loading: true,
      error: null,
      products: [],
      storeStatuses: STORE_NAMES.map((store) => ({ store, status: 'loading' as const })),
      activeQuery: query,
      activeZip: zipcode,
    });

    useUserStore.getState().trackSearch(query);

    try {
      const response = await searchRepository.search(query, zipcode);
      set({ products: response.products, storeStatuses: response.storeStatuses });
      // Every search result is a real, timestamped price observation — the
      // only source of truth priceHistoryService/advisorService ever read
      // from. Fire-and-forget: never worth delaying results for.
      recordObservations(response.products);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      set({ loading: false });
    }
  },
}));

import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Recent-search terms — device-local, no account. Mirrors the old
 * userStore.ts's `trackSearch` (same "append if new, keep the most recent
 * 20" logic) but as its own tiny AsyncStorage-backed store rather than a
 * field on a signed-in User record, since there is no account to hang it
 * off of anymore.
 */
const STORAGE_KEY = 'ShopAI_guest_search_history';
const MAX_TERMS = 20;

interface GuestSearchHistoryState {
  hydrated: boolean;
  history: string[];
  hydrate: () => Promise<void>;
  track: (query: string) => Promise<void>;
}

export const useGuestSearchHistoryStore = create<GuestSearchHistoryState>((set, get) => ({
  hydrated: false,
  history: [],

  hydrate: async () => {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    let history: string[] = [];
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) history = parsed.filter((v): v is string => typeof v === 'string');
      } catch {
        history = [];
      }
    }
    set({ hydrated: true, history });
  },

  track: async (query) => {
    const history = [...get().history];
    if (!history.includes(query)) history.push(query);
    const trimmed = history.length > MAX_TERMS ? history.slice(history.length - MAX_TERMS) : history;
    set({ history: trimmed });
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  },
}));

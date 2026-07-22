import { create } from 'zustand';
import type { StoreName } from '../models/types';

interface StoreModeState {
  /** null = default comparison-first mode (the whole app's normal
   * behavior). Set only when a shopper explicitly opts into "Search
   * Within One Store" — see StorePickerSheet/StoreModeBar. Deliberately
   * in-memory only (no persistence): "remember the user's choice during
   * the current search session" means this session, not forever — the
   * default on every fresh app launch is always comparison mode. */
  selectedStore: StoreName | null;
  setSelectedStore: (store: StoreName | null) => void;
}

export const useStoreModeStore = create<StoreModeState>((set) => ({
  selectedStore: null,
  setSelectedStore: (store) => set({ selectedStore: store }),
}));

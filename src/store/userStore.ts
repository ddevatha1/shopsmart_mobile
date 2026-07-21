import { create } from 'zustand';
import type { User } from '../models/types';
import { userRepository } from '../repositories/userRepository';
import { authRepository } from '../repositories/authRepository';

/** Mirrors the `user` state + its localStorage hydration/persistence
 * effects in page.tsx. */
interface UserState {
  user: User | null;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  signIn: (user: User) => Promise<void>;
  signOut: () => Promise<void>;
  /** Mirrors runSearch()'s inline search-history tracking in page.tsx:
   * append the term if not already present, keep only the most recent 20. */
  trackSearch: (query: string) => Promise<void>;
  /** The only way a ZIP code changes post-signup — writes through to both
   * the current session and the permanent account record. */
  updateZipcode: (zipcode: string) => Promise<void>;
  /** Sets or clears the shopper's optional weekly grocery budget — same
   * write-through pattern as updateZipcode. `null` clears it entirely. */
  updateBudget: (weeklyBudget: number | null) => Promise<void>;
}

export const useUserStore = create<UserState>((set, get) => ({
  user: null,
  hydrated: false,

  hydrate: async () => {
    const user = await userRepository.loadCurrentUser();
    set({ user, hydrated: true });
  },

  signIn: async (user) => {
    set({ user });
    await userRepository.saveCurrentUser(user);
  },

  signOut: async () => {
    set({ user: null });
    await userRepository.saveCurrentUser(null);
  },

  trackSearch: async (query) => {
    const current = get().user;
    if (!current) return;
    const history = [...current.searchHistory];
    if (!history.includes(query)) history.push(query);
    const trimmed = history.length > 20 ? history.slice(history.length - 20) : history;
    const updated = { ...current, searchHistory: trimmed };
    set({ user: updated });
    await userRepository.saveCurrentUser(updated);
  },

  updateZipcode: async (zipcode) => {
    const current = get().user;
    if (!current) return;
    const updated = { ...current, zipcode };
    set({ user: updated });
    await userRepository.saveCurrentUser(updated);
    await authRepository.updateZipcode(updated.email, zipcode);
  },

  updateBudget: async (weeklyBudget) => {
    const current = get().user;
    if (!current) return;
    const updated = { ...current, weeklyBudget: weeklyBudget ?? undefined };
    set({ user: updated });
    await userRepository.saveCurrentUser(updated);
    await authRepository.updateBudget(updated.email, weeklyBudget);
  },
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { User } from '../models/types';

/**
 * Mirrors the `LS_USER_KEY` ('shopsmart_user') persistence effect in
 * page.tsx — the *current session's* live user object (including
 * in-session search history updates), kept separate from the accounts
 * database in authRepository, exactly as on the web.
 */
const USER_KEY = 'shopsmart_user';

export const userRepository = {
  async loadCurrentUser(): Promise<User | null> {
    const raw = await AsyncStorage.getItem(USER_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as User;
    } catch {
      return null;
    }
  },

  async saveCurrentUser(user: User | null): Promise<void> {
    if (user === null) {
      await AsyncStorage.removeItem(USER_KEY);
    } else {
      await AsyncStorage.setItem(USER_KEY, JSON.stringify(user));
    }
  },
};

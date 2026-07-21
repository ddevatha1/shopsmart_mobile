import AsyncStorage from '@react-native-async-storage/async-storage';
import type { AccountRecord, User } from '../models/types';

/**
 * Mirrors AuthModal.tsx exactly: there is no real backend auth endpoint on
 * the web app either — accounts are a JSON map persisted client-side
 * (localStorage there, AsyncStorage here), keyed by lowercased email,
 * storing everything except `id` (a fresh id is minted per sign-in there
 * via `u_${Date.now()}`, replicated here the same way). This is a direct
 * port of that business logic, not a new auth flow.
 */
export class AuthError extends Error {}

const ACCOUNTS_KEY = 'shopsmart_accounts';
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ZIP_PATTERN = /^\d{5}$/;

async function loadAccounts(): Promise<Record<string, AccountRecord>> {
  const raw = await AsyncStorage.getItem(ACCOUNTS_KEY);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function saveAccounts(accounts: Record<string, AccountRecord>): Promise<void> {
  await AsyncStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts));
}

function newUserId(): string {
  return `u_${Date.now()}`;
}

export const authRepository = {
  async signUp(params: { name: string; email: string; zipcode: string }): Promise<User> {
    const trimmedEmail = params.email.trim().toLowerCase();
    if (!trimmedEmail || !EMAIL_PATTERN.test(trimmedEmail)) {
      throw new AuthError('Please enter a valid email address.');
    }
    if (!params.name.trim()) {
      throw new AuthError('Please enter your name.');
    }
    if (!ZIP_PATTERN.test(params.zipcode)) {
      throw new AuthError('Please enter a valid 5-digit ZIP code.');
    }

    const accounts = await loadAccounts();
    if (accounts[trimmedEmail]) {
      throw new AuthError('An account with this email already exists. Sign in instead.');
    }

    const user: User = {
      id: newUserId(),
      name: params.name.trim(),
      email: trimmedEmail,
      zipcode: params.zipcode.trim(),
      searchHistory: [],
    };

    accounts[trimmedEmail] = { name: user.name, email: user.email, zipcode: user.zipcode, searchHistory: user.searchHistory };
    await saveAccounts(accounts);
    return user;
  },

  async signIn(params: { email: string }): Promise<User> {
    const trimmedEmail = params.email.trim().toLowerCase();
    if (!trimmedEmail || !EMAIL_PATTERN.test(trimmedEmail)) {
      throw new AuthError('Please enter a valid email address.');
    }

    const accounts = await loadAccounts();
    const record = accounts[trimmedEmail];
    if (!record) {
      throw new AuthError('No account found with that email. Create one instead.');
    }

    // Note: intentionally NOT the live, possibly-updated search history —
    // the web app never writes search history back into the accounts map
    // either (only into the separate "current session" key), so signing
    // out and back in resets it there too. Matched here on purpose.
    return {
      id: newUserId(),
      name: record.name,
      email: record.email,
      zipcode: record.zipcode ?? '',
      searchHistory: record.searchHistory ?? [],
      weeklyBudget: record.weeklyBudget,
    };
  },

  // Writes through to the permanent account record (unlike search history,
  // a ZIP code change should survive sign-out/sign-in) so the next sign-in
  // picks up the updated ZIP.
  async updateZipcode(email: string, zipcode: string): Promise<void> {
    if (!ZIP_PATTERN.test(zipcode)) {
      throw new AuthError('Please enter a valid 5-digit ZIP code.');
    }
    const trimmedEmail = email.trim().toLowerCase();
    const accounts = await loadAccounts();
    if (accounts[trimmedEmail]) {
      accounts[trimmedEmail] = { ...accounts[trimmedEmail], zipcode };
      await saveAccounts(accounts);
    }
  },

  // Same write-through pattern as updateZipcode — `weeklyBudget: null`
  // clears the preference entirely (an unset budget, not a zero budget).
  async updateBudget(email: string, weeklyBudget: number | null): Promise<void> {
    const trimmedEmail = email.trim().toLowerCase();
    const accounts = await loadAccounts();
    if (accounts[trimmedEmail]) {
      accounts[trimmedEmail] = { ...accounts[trimmedEmail], weeklyBudget: weeklyBudget ?? undefined };
      await saveAccounts(accounts);
    }
  },
};

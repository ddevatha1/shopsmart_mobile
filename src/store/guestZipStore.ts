import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';
import { getCurrentCoordinates } from '../services/locationService';

/**
 * The one place this app stores "where should we search near," now that
 * there's no signed-in account to hang a ZIP code off of. Device-local,
 * no server round trip, no account.
 *
 * `resolveZipcode()` is the only way anything should ever get a ZIP to
 * search with:
 *   1. Already known (a previous search resolved and cached one, or the
 *      shopper set one by hand in Settings) — returned immediately, no
 *      permission prompt, no network.
 *   2. Not known yet — asks for the device's location via
 *      `getCurrentCoordinates()`, which is the exact same call this app
 *      already uses for "how far is this store"/route planning, so it
 *      triggers the real native iOS "Allow ShopSmart to access your
 *      location?" system dialog the first time, and silently reuses the
 *      existing grant on every call after that (expo-location's own
 *      `requestForegroundPermissionsAsync` never re-prompts once the
 *      shopper has already answered — see locationService.ts). Denied/
 *      unavailable location resolves to `null` here too, exactly like
 *      that function's own contract — never a thrown error, never a
 *      blocked search.
 *   3. A resolved coordinate is reverse-geocoded to a postal code via
 *      `Location.reverseGeocodeAsync` (on-device, no extra permission,
 *      no API key) and cached for every future search this session (and
 *      across app restarts, via AsyncStorage) — this prompt/lookup only
 *      ever needs to happen once per device.
 */
const STORAGE_KEY = 'ShopAI_guest_settings';
const ZIP_PATTERN = /^\d{5}$/;

interface StoredSettings {
  zipcode?: string;
  weeklyBudget?: number;
}

async function loadStored(): Promise<StoredSettings> {
  const raw = await AsyncStorage.getItem(STORAGE_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

async function saveStored(next: StoredSettings): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
}

interface GuestZipState {
  hydrated: boolean;
  zipcode: string;
  weeklyBudget: number | null;
  hydrate: () => Promise<void>;
  setZipcode: (zipcode: string) => Promise<void>;
  setWeeklyBudget: (weeklyBudget: number | null) => Promise<void>;
  /** Returns the known ZIP immediately if there is one; otherwise
   * resolves it from the device's location (prompting for permission
   * only if it hasn't been granted or denied yet — see this file's own
   * header comment) and caches the result. Returns `''` — never throws,
   * never blocks indefinitely — when location is denied/unavailable or
   * reverse geocoding can't produce a postal code, exactly like the rest
   * of this app treats optional location data: the caller (searchStore)
   * is responsible for what to do with an empty result. */
  resolveZipcode: () => Promise<string>;
}

export const useGuestZipStore = create<GuestZipState>((set, get) => ({
  hydrated: false,
  zipcode: '',
  weeklyBudget: null,

  hydrate: async () => {
    const stored = await loadStored();
    set({
      hydrated: true,
      zipcode: stored.zipcode && ZIP_PATTERN.test(stored.zipcode) ? stored.zipcode : '',
      weeklyBudget: stored.weeklyBudget ?? null,
    });
  },

  setZipcode: async (zipcode) => {
    if (!ZIP_PATTERN.test(zipcode)) return;
    set({ zipcode });
    await saveStored({ zipcode, weeklyBudget: get().weeklyBudget ?? undefined });
  },

  setWeeklyBudget: async (weeklyBudget) => {
    set({ weeklyBudget });
    await saveStored({ zipcode: get().zipcode || undefined, weeklyBudget: weeklyBudget ?? undefined });
  },

  resolveZipcode: async () => {
    const known = get().zipcode;
    if (known) return known;

    const coords = await getCurrentCoordinates();
    if (!coords) return '';

    let resolved = '';
    try {
      const results = await Location.reverseGeocodeAsync(coords);
      const postalCode = results.find((r) => r.postalCode)?.postalCode ?? null;
      if (postalCode && ZIP_PATTERN.test(postalCode)) resolved = postalCode;
    } catch {
      resolved = '';
    }

    if (resolved) {
      set({ zipcode: resolved });
      await saveStored({ zipcode: resolved, weeklyBudget: get().weeklyBudget ?? undefined });
    }
    return resolved;
  },
}));

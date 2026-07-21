import AsyncStorage from '@react-native-async-storage/async-storage';
import type { TripChecklist } from '../services/navigationController';

/**
 * Persists which items have been checked off during the *currently active*
 * trip, keyed by the trip's signature (see
 * `navigationController.computeTripSignature`) so re-opening the Route
 * screen for the same set of stops resumes exactly where the shopper left
 * off (app backgrounded, phone locked, accidental back-navigation), while a
 * genuinely different trip (different cart) always starts unchecked.
 *
 * Mirrors `cartRepository.ts`'s AsyncStorage pattern exactly. Not scoped
 * per-account like the cart is — a trip in progress belongs to whoever's
 * device it's on, and there's only ever one active trip at a time.
 */
const ACTIVE_TRIP_KEY = 'shopsmart_route_active_trip';

interface StoredChecklist {
  tripSignature: string;
  checklist: TripChecklist;
}

export const routeChecklistRepository = {
  async load(tripSignature: string): Promise<TripChecklist> {
    const raw = await AsyncStorage.getItem(ACTIVE_TRIP_KEY);
    if (!raw) return {};
    try {
      const stored = JSON.parse(raw) as StoredChecklist;
      return stored.tripSignature === tripSignature ? stored.checklist : {};
    } catch {
      return {};
    }
  },

  async save(tripSignature: string, checklist: TripChecklist): Promise<void> {
    const stored: StoredChecklist = { tripSignature, checklist };
    await AsyncStorage.setItem(ACTIVE_TRIP_KEY, JSON.stringify(stored));
  },

  async clear(): Promise<void> {
    await AsyncStorage.removeItem(ACTIVE_TRIP_KEY);
  },
};

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ShopperPreferences } from '../models/types';

/** Local, on-device shopper preference memory (Phase 5.2) — mirrors
 * plannerPreferenceRepository.ts's exact AsyncStorage pattern: scoped per
 * signed-in account, JSON-serialized, a silent no-op for a signed-out
 * shopper. No database, no cloud sync, no cross-device memory — this is
 * deliberately the same "local storage only" foundation
 * assistantShoppingSessionStore.ts already established in Phase 5.1. */
const keyFor = (ownerEmail: string) => `CartIQ_shopper_preferences_${ownerEmail}`;

export const shopperPreferenceRepository = {
  async load(ownerEmail: string): Promise<ShopperPreferences> {
    if (!ownerEmail) return {};
    const raw = await AsyncStorage.getItem(keyFor(ownerEmail));
    if (!raw) return {};
    try {
      return JSON.parse(raw) as ShopperPreferences;
    } catch {
      return {};
    }
  },

  async save(ownerEmail: string, preferences: ShopperPreferences): Promise<void> {
    if (!ownerEmail) return;
    await AsyncStorage.setItem(keyFor(ownerEmail), JSON.stringify(preferences));
  },
};

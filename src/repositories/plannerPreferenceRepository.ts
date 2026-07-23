import AsyncStorage from '@react-native-async-storage/async-storage';

/** Remembered grocery-list subtype preferences — "this shopper always means
 * 2% milk" — scoped per signed-in account, same pattern as cartRepository.
 * Maps taxonomyEntryId (e.g. "milk") to either a chosen subtypeId (e.g.
 * "two-percent") or the literal string 'no-preference', which is itself a
 * remembered, sticky choice. Mirrors shopsmart_web's
 * plannerPreferenceRepository.ts (AsyncStorage instead of localStorage). */
const keyFor = (ownerEmail: string) => `shopsmart_planner_prefs_${ownerEmail}`;

export type PlannerPreferences = Record<string, string>;

export const plannerPreferenceRepository = {
  async load(ownerEmail: string): Promise<PlannerPreferences> {
    if (!ownerEmail) return {};
    const raw = await AsyncStorage.getItem(keyFor(ownerEmail));
    if (!raw) return {};
    try {
      return JSON.parse(raw) as PlannerPreferences;
    } catch {
      return {};
    }
  },

  async save(ownerEmail: string, prefs: PlannerPreferences): Promise<void> {
    if (!ownerEmail) return;
    await AsyncStorage.setItem(keyFor(ownerEmail), JSON.stringify(prefs));
  },
};

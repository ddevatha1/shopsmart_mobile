import { shopperPreferenceRepository } from '../repositories/shopperPreferenceRepository';
import type { OptimizationPreference, ShopperPreferences } from '../models/types';

/**
 * Shopper Preference Memory (Phase 5.2 Part 1) — the one place a
 * `ShopperPreferences` record is ever read or written. Every setter here
 * takes a real, already-decided value; nothing in this file ever derives
 * a preference from behavior (purchases, cart contents, search history)
 * — see `applyPreferenceUpdate`'s own doc comment for the closed set of
 * fields a caller (assistantDispatcher.ts's `dispatchUpdatePreferences`/
 * `dispatchSetBudgetTarget`) may update, and why that set is
 * re-validated here independently of the router's own extraction.
 */

export async function getPreferences(ownerEmail: string): Promise<ShopperPreferences> {
  return shopperPreferenceRepository.load(ownerEmail);
}

function addUnique(list: string[] | undefined, value: string): string[] {
  const trimmed = value.trim();
  const existing = list ?? [];
  if (existing.some((v) => v.toLowerCase() === trimmed.toLowerCase())) return existing;
  return [...existing, trimmed];
}

function removeValue(list: string[] | undefined, value: string): string[] | undefined {
  if (!list) return undefined;
  const next = list.filter((v) => v.toLowerCase() !== value.trim().toLowerCase());
  return next.length > 0 ? next : undefined;
}

async function mutate(ownerEmail: string, patch: (prefs: ShopperPreferences) => ShopperPreferences): Promise<ShopperPreferences> {
  const current = await getPreferences(ownerEmail);
  const next = patch(current);
  await shopperPreferenceRepository.save(ownerEmail, next);
  return next;
}

export async function addPreferredStore(ownerEmail: string, store: string): Promise<ShopperPreferences> {
  return mutate(ownerEmail, (p) => ({ ...p, preferredStores: addUnique(p.preferredStores, store) }));
}

export async function removePreferredStore(ownerEmail: string, store: string): Promise<ShopperPreferences> {
  return mutate(ownerEmail, (p) => ({ ...p, preferredStores: removeValue(p.preferredStores, store) }));
}

/**
 * Phase 6 Part 2 — the ONE gate for OnboardingScreen's optional
 * preferred-store picker ever reaching storage (see AuthScreen.tsx, this
 * function's only caller). Only saves on a real sign-UP (a brand-new
 * account) with a real, explicitly-selected store — never on sign-in
 * (an existing account's preferences aren't rewritten from a Welcome-
 * screen tap), and never when the picker was skipped (`undefined`).
 * Returns whether it actually saved, so a caller never has to duplicate
 * this gate to know what happened.
 */
export async function applyOnboardingPreferredStore(
  ownerEmail: string,
  isSignUp: boolean,
  preferredStoreToSave: string | undefined,
): Promise<boolean> {
  if (!isSignUp || !preferredStoreToSave) return false;
  await addPreferredStore(ownerEmail, preferredStoreToSave);
  return true;
}

export async function addAvoidedStore(ownerEmail: string, store: string): Promise<ShopperPreferences> {
  return mutate(ownerEmail, (p) => ({ ...p, avoidedStores: addUnique(p.avoidedStores, store) }));
}

export async function removeAvoidedStore(ownerEmail: string, store: string): Promise<ShopperPreferences> {
  return mutate(ownerEmail, (p) => ({ ...p, avoidedStores: removeValue(p.avoidedStores, store) }));
}

export async function addDietaryPreference(ownerEmail: string, preference: string): Promise<ShopperPreferences> {
  return mutate(ownerEmail, (p) => ({ ...p, dietaryPreferences: addUnique(p.dietaryPreferences, preference) }));
}

export async function removeDietaryPreference(ownerEmail: string, preference: string): Promise<ShopperPreferences> {
  return mutate(ownerEmail, (p) => ({ ...p, dietaryPreferences: removeValue(p.dietaryPreferences, preference) }));
}

/** `null` clears the field — never a fabricated household size. */
export async function setHouseholdSize(ownerEmail: string, size: number | null): Promise<ShopperPreferences> {
  return mutate(ownerEmail, (p) => {
    const next = { ...p };
    if (size == null) delete next.householdSize;
    else next.householdSize = size;
    return next;
  });
}

export async function setDefaultBudgetTarget(ownerEmail: string, amount: number | null): Promise<ShopperPreferences> {
  return mutate(ownerEmail, (p) => {
    const next = { ...p };
    if (amount == null) delete next.defaultBudgetTarget;
    else next.defaultBudgetTarget = amount;
    return next;
  });
}

export async function setOptimizationPreference(ownerEmail: string, preference: OptimizationPreference | null): Promise<ShopperPreferences> {
  return mutate(ownerEmail, (p) => {
    const next = { ...p };
    if (preference == null) delete next.optimizationPreference;
    else next.optimizationPreference = preference;
    return next;
  });
}

export async function clearAllPreferences(ownerEmail: string): Promise<void> {
  if (!ownerEmail) return;
  await shopperPreferenceRepository.save(ownerEmail, {});
}

// ─── The dispatcher's single entry point ────────────────────────────────

export type PreferenceField = 'preferredStores' | 'avoidedStores' | 'optimizationPreference' | 'defaultBudgetTarget';

const VALID_FIELDS: ReadonlySet<string> = new Set<PreferenceField>([
  'preferredStores', 'avoidedStores', 'optimizationPreference', 'defaultBudgetTarget',
]);
const VALID_OPTIMIZATION_PREFERENCES: ReadonlySet<string> = new Set<OptimizationPreference>([
  'cheapest', 'healthiest', 'fastest', 'balanced',
]);

export type ApplyPreferenceUpdateResult =
  | { ok: true; preferences: ShopperPreferences }
  | { ok: false; error: string };

/**
 * The ONLY function assistantDispatcher.ts calls to apply a preference
 * update — re-validates `field` against the SAME closed set the router's
 * own extraction is scoped to (defense in depth: even if a future caller
 * bypassed the router entirely, an unknown/unsupported field can never
 * reach storage). `value`'s shape is checked per-field too — a string
 * where a number was expected (or vice versa) is rejected, never coerced.
 */
export async function applyPreferenceUpdate(
  ownerEmail: string,
  field: string,
  value: string | number,
): Promise<ApplyPreferenceUpdateResult> {
  if (!VALID_FIELDS.has(field)) {
    return { ok: false, error: `"${field}" is not a preference this app can remember.` };
  }

  switch (field as PreferenceField) {
    case 'preferredStores': {
      if (typeof value !== 'string' || !value.trim()) return { ok: false, error: 'Expected a real store name.' };
      return { ok: true, preferences: await addPreferredStore(ownerEmail, value) };
    }
    case 'avoidedStores': {
      if (typeof value !== 'string' || !value.trim()) return { ok: false, error: 'Expected a real store name.' };
      return { ok: true, preferences: await addAvoidedStore(ownerEmail, value) };
    }
    case 'optimizationPreference': {
      if (typeof value !== 'string' || !VALID_OPTIMIZATION_PREFERENCES.has(value)) {
        return { ok: false, error: 'Expected cheapest, healthiest, fastest, or balanced.' };
      }
      return { ok: true, preferences: await setOptimizationPreference(ownerEmail, value as OptimizationPreference) };
    }
    case 'defaultBudgetTarget': {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        return { ok: false, error: 'Expected a real, positive budget amount.' };
      }
      return { ok: true, preferences: await setDefaultBudgetTarget(ownerEmail, value) };
    }
  }
}

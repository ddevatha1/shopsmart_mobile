import { plannerPreferenceRepository, type PlannerPreferences } from '../repositories/plannerPreferenceRepository';

/** Thin wrapper around plannerPreferenceRepository — mirrors
 * shopsmart_web's plannerPreferenceService.ts. */
export async function getAllPreferences(ownerEmail: string): Promise<PlannerPreferences> {
  return plannerPreferenceRepository.load(ownerEmail);
}

export async function setPreference(
  ownerEmail: string,
  taxonomyEntryId: string,
  value: string | null,
): Promise<void> {
  if (!ownerEmail) return;
  const prefs = await plannerPreferenceRepository.load(ownerEmail);
  const next = { ...prefs, [taxonomyEntryId]: value === null ? 'no-preference' : value };
  await plannerPreferenceRepository.save(ownerEmail, next);
}

export async function clearPreference(ownerEmail: string, taxonomyEntryId: string): Promise<void> {
  if (!ownerEmail) return;
  const prefs = await plannerPreferenceRepository.load(ownerEmail);
  if (!(taxonomyEntryId in prefs)) return;
  const next = { ...prefs };
  delete next[taxonomyEntryId];
  await plannerPreferenceRepository.save(ownerEmail, next);
}

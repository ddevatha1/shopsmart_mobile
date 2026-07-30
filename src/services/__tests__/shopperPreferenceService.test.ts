import {
  getPreferences, addPreferredStore, removePreferredStore, addAvoidedStore, removeAvoidedStore,
  setOptimizationPreference, setDefaultBudgetTarget, setHouseholdSize, clearAllPreferences, applyPreferenceUpdate,
  applyOnboardingPreferredStore,
} from '../shopperPreferenceService';

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));

const OWNER = 'shopper@example.com';

afterEach(async () => {
  await clearAllPreferences(OWNER);
});

describe('shopperPreferenceService — create/update/remove/persistence', () => {
  test('a new preferred store is created and persists across reads', async () => {
    await addPreferredStore(OWNER, 'Aldi');
    expect((await getPreferences(OWNER)).preferredStores).toEqual(['Aldi']);
  });

  test('adding the same store twice does not duplicate it', async () => {
    await addPreferredStore(OWNER, 'Aldi');
    await addPreferredStore(OWNER, 'aldi'); // case-insensitive dedupe
    expect((await getPreferences(OWNER)).preferredStores).toEqual(['Aldi']);
  });

  test('a preferred store can be removed, and removal persists', async () => {
    await addPreferredStore(OWNER, 'Aldi');
    await addPreferredStore(OWNER, 'Kroger');
    await removePreferredStore(OWNER, 'Aldi');
    expect((await getPreferences(OWNER)).preferredStores).toEqual(['Kroger']);
  });

  test('removing the last item of a list clears the field entirely, never an empty array left behind', async () => {
    await addPreferredStore(OWNER, 'Aldi');
    await removePreferredStore(OWNER, 'Aldi');
    expect((await getPreferences(OWNER)).preferredStores).toBeUndefined();
  });

  test('avoided stores are tracked independently of preferred stores', async () => {
    await addPreferredStore(OWNER, 'Aldi');
    await addAvoidedStore(OWNER, 'Kroger');
    const prefs = await getPreferences(OWNER);
    expect(prefs.preferredStores).toEqual(['Aldi']);
    expect(prefs.avoidedStores).toEqual(['Kroger']);
    await removeAvoidedStore(OWNER, 'Kroger');
    expect((await getPreferences(OWNER)).avoidedStores).toBeUndefined();
  });

  test('optimizationPreference can be set, updated, and cleared', async () => {
    await setOptimizationPreference(OWNER, 'cheapest');
    expect((await getPreferences(OWNER)).optimizationPreference).toBe('cheapest');
    await setOptimizationPreference(OWNER, 'healthiest');
    expect((await getPreferences(OWNER)).optimizationPreference).toBe('healthiest');
    await setOptimizationPreference(OWNER, null);
    expect((await getPreferences(OWNER)).optimizationPreference).toBeUndefined();
  });

  test('defaultBudgetTarget can be set, updated, and cleared', async () => {
    await setDefaultBudgetTarget(OWNER, 150);
    expect((await getPreferences(OWNER)).defaultBudgetTarget).toBe(150);
    await setDefaultBudgetTarget(OWNER, null);
    expect((await getPreferences(OWNER)).defaultBudgetTarget).toBeUndefined();
  });

  test('householdSize can be set and cleared — but nothing in this phase infers it (see safety tests below)', async () => {
    await setHouseholdSize(OWNER, 4);
    expect((await getPreferences(OWNER)).householdSize).toBe(4);
    await setHouseholdSize(OWNER, null);
    expect((await getPreferences(OWNER)).householdSize).toBeUndefined();
  });

  test('clearAllPreferences wipes the whole record', async () => {
    await addPreferredStore(OWNER, 'Aldi');
    await setDefaultBudgetTarget(OWNER, 100);
    await clearAllPreferences(OWNER);
    expect(await getPreferences(OWNER)).toEqual({});
  });

  test('preferences are scoped per owner — one shopper never sees another\'s', async () => {
    await addPreferredStore(OWNER, 'Aldi');
    expect(await getPreferences('someone-else@example.com')).toEqual({});
  });
});

describe('applyPreferenceUpdate — the dispatcher\'s single, re-validated entry point', () => {
  test('a real preferredStores update succeeds', async () => {
    const result = await applyPreferenceUpdate(OWNER, 'preferredStores', 'Aldi');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.preferences.preferredStores).toEqual(['Aldi']);
  });

  test('an unknown field is rejected — never written, even if it superficially resembles a real one', async () => {
    const result = await applyPreferenceUpdate(OWNER, 'weeklyBudget', 100); // real ACCOUNT field name, not a preference field
    expect(result.ok).toBe(false);
    expect(await getPreferences(OWNER)).toEqual({});
  });

  test('a wrong-typed value for a field is rejected, never coerced', async () => {
    const result = await applyPreferenceUpdate(OWNER, 'defaultBudgetTarget', 'a lot' as unknown as number);
    expect(result.ok).toBe(false);
    expect((await getPreferences(OWNER)).defaultBudgetTarget).toBeUndefined();
  });

  test('an invalid optimizationPreference value is rejected — only the 4 real values are accepted', async () => {
    const result = await applyPreferenceUpdate(OWNER, 'optimizationPreference', 'yolo');
    expect(result.ok).toBe(false);
  });

  test('a non-positive budget amount is rejected, never a guessed positive default', async () => {
    const result = await applyPreferenceUpdate(OWNER, 'defaultBudgetTarget', -5);
    expect(result.ok).toBe(false);
  });
});

describe('safety — this service never infers a preference on its own', () => {
  test('getPreferences over an account with no explicit statements ever made returns an empty record, never a guessed one', async () => {
    expect(await getPreferences(OWNER)).toEqual({});
  });

  test('setting unrelated fields (stores, budget, optimization preference) never causes dietaryPreferences/householdSize to appear on their own', async () => {
    await addPreferredStore(OWNER, 'Aldi');
    await addAvoidedStore(OWNER, 'Kroger');
    await setOptimizationPreference(OWNER, 'cheapest');
    await setDefaultBudgetTarget(OWNER, 100);

    const prefs = await getPreferences(OWNER);
    expect(prefs.dietaryPreferences).toBeUndefined();
    expect(prefs.householdSize).toBeUndefined();
  });
});

// ─── Phase 6 Part 2 — OnboardingScreen's optional preferred-store picker ────

describe('applyOnboardingPreferredStore', () => {
  test('a skipped picker (undefined) never saves anything, even on a real sign-up', async () => {
    const saved = await applyOnboardingPreferredStore(OWNER, true, undefined);
    expect(saved).toBe(false);
    expect((await getPreferences(OWNER)).preferredStores).toBeUndefined();
  });

  test('an explicit selection on a real sign-up saves it', async () => {
    const saved = await applyOnboardingPreferredStore(OWNER, true, 'Aldi');
    expect(saved).toBe(true);
    expect((await getPreferences(OWNER)).preferredStores).toEqual(['Aldi']);
  });

  test('an explicit selection is never saved on sign-IN, even to a brand-new-looking record — an existing account is not rewritten from a Welcome-screen tap', async () => {
    const saved = await applyOnboardingPreferredStore(OWNER, false, 'Aldi');
    expect(saved).toBe(false);
    expect((await getPreferences(OWNER)).preferredStores).toBeUndefined();
  });

  test('sign-in with no selection also saves nothing', async () => {
    const saved = await applyOnboardingPreferredStore(OWNER, false, undefined);
    expect(saved).toBe(false);
    expect((await getPreferences(OWNER)).preferredStores).toBeUndefined();
  });
});

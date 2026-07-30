import AsyncStorage from '@react-native-async-storage/async-storage';
import { getIntelligenceSignals, hasAnyIntelligenceSignal } from '../intelligenceStatusService';
import { addPreferredStore } from '../shopperPreferenceService';
import { createSession } from '../assistantShoppingSessionStore';

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));

const OWNER = 'shopper@example.com';

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe('getIntelligenceSignals', () => {
  test('a signed-out shopper (empty ownerEmail) gets every signal false, never a lookup attempt', async () => {
    expect(await getIntelligenceSignals('')).toEqual({
      preferredStores: false, shoppingHistory: false, savingsPatterns: false,
    });
  });

  test('a brand-new account with no real data gets every signal false — no empty claims', async () => {
    expect(await getIntelligenceSignals(OWNER)).toEqual({
      preferredStores: false, shoppingHistory: false, savingsPatterns: false,
    });
  });

  test('a real, explicit preferred store makes preferredStores true and nothing else', async () => {
    await addPreferredStore(OWNER, 'Aldi');
    expect(await getIntelligenceSignals(OWNER)).toEqual({
      preferredStores: true, shoppingHistory: false, savingsPatterns: false,
    });
  });

  test('a completed session with no real estimatedSavings makes shoppingHistory true but savingsPatterns stays false', async () => {
    await createSession(OWNER, { goal: 'save_money', items: [{ id: 'i1', rawText: 'milk' }], constraints: {} });
    expect(await getIntelligenceSignals(OWNER)).toEqual({
      preferredStores: false, shoppingHistory: true, savingsPatterns: false,
    });
  });

  test('a completed session with a real estimatedSavings makes both shoppingHistory and savingsPatterns true', async () => {
    await createSession(OWNER, {
      goal: 'save_money', items: [{ id: 'i1', rawText: 'milk' }], constraints: {}, estimatedSavings: 12.4,
    });
    expect(await getIntelligenceSignals(OWNER)).toEqual({
      preferredStores: false, shoppingHistory: true, savingsPatterns: true,
    });
  });

  test('all three signals can be real and true at once', async () => {
    await addPreferredStore(OWNER, 'Kroger');
    await createSession(OWNER, {
      goal: 'save_money', items: [{ id: 'i1', rawText: 'eggs' }], constraints: {}, estimatedSavings: 8,
    });
    expect(await getIntelligenceSignals(OWNER)).toEqual({
      preferredStores: true, shoppingHistory: true, savingsPatterns: true,
    });
  });
});

describe('hasAnyIntelligenceSignal', () => {
  test('false when every signal is false', () => {
    expect(hasAnyIntelligenceSignal({ preferredStores: false, shoppingHistory: false, savingsPatterns: false })).toBe(false);
  });

  test('true when at least one signal is true', () => {
    expect(hasAnyIntelligenceSignal({ preferredStores: true, shoppingHistory: false, savingsPatterns: false })).toBe(true);
  });
});

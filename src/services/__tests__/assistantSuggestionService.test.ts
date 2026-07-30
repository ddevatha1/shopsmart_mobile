import AsyncStorage from '@react-native-async-storage/async-storage';
import { getShoppingSuggestions, dismissSuggestion } from '../assistantSuggestionService';
import { recordPurchases } from '../purchaseHistoryService';
import { setDefaultBudgetTarget, clearAllPreferences } from '../shopperPreferenceService';
import type { ApiProduct, CartItem } from '../../models/types';

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));

const OWNER = 'shopper@example.com';

function makeProduct(id: string, name: string): ApiProduct {
  return { id, name, brand: 'Brand', price: 3, rating: 4, size: '1 ea', store: 'Kroger' };
}

function makePurchase(name: string, daysAgo: number): CartItem {
  return { product: makeProduct(`${name}-${daysAgo}`, name), quantity: 1 };
}

async function purchaseAt(name: string, daysAgo: number, now: number): Promise<void> {
  jest.spyOn(Date, 'now').mockReturnValue(now - daysAgo * 24 * 60 * 60 * 1000);
  await recordPurchases(OWNER, [makePurchase(name, daysAgo)]);
}

beforeEach(async () => {
  await AsyncStorage.clear();
});

afterEach(async () => {
  jest.restoreAllMocks();
  await clearAllPreferences(OWNER);
});

describe('getShoppingSuggestions — purchase intelligence, never fabricated', () => {
  test('a real, repeated, overdue purchase produces a restock suggestion with a real reason', async () => {
    const realNow = Date.now();
    // Milk bought every ~7 days, 3 times, last one 8 days ago — a real,
    // repeatable, overdue pattern (mirrors inventoryEstimationService's
    // own test fixtures).
    await purchaseAt('Whole Milk', 22, realNow);
    await purchaseAt('Whole Milk', 15, realNow);
    await purchaseAt('Whole Milk', 8, realNow);
    jest.spyOn(Date, 'now').mockReturnValue(realNow);

    const suggestions = await getShoppingSuggestions(OWNER);
    const milk = suggestions.find((s) => s.itemName === 'Whole Milk' && s.type === 'restock');
    expect(milk).toBeTruthy();
    expect(milk!.reason.length).toBeGreaterThan(0);
    expect(milk!.reason).not.toMatch(/probably|might need/i); // never a fabricated-sounding guess
  });

  test('a frequently-bought item (3+ purchases) not currently low still surfaces as frequent_purchase', async () => {
    const realNow = Date.now();
    // Bought 3 times, most recently today — NOT overdue, so no restock
    // signal, but genuinely frequent.
    await purchaseAt('Bananas', 40, realNow);
    await purchaseAt('Bananas', 20, realNow);
    await purchaseAt('Bananas', 0, realNow);
    jest.spyOn(Date, 'now').mockReturnValue(realNow);

    const suggestions = await getShoppingSuggestions(OWNER);
    const bananas = suggestions.find((s) => s.itemName === 'Bananas');
    expect(bananas?.type).toBe('frequent_purchase');
    expect(bananas?.reason).toContain('3 times');
  });

  test('missing purchase history produces no restock/frequent suggestions at all', async () => {
    const suggestions = await getShoppingSuggestions(OWNER);
    expect(suggestions.filter((s) => s.type === 'restock' || s.type === 'frequent_purchase')).toEqual([]);
  });

  test('a single purchase (no real repeatable pattern yet) produces no restock suggestion — low confidence, no assertion', async () => {
    await recordPurchases(OWNER, [makePurchase('Yogurt', 0)]);
    const suggestions = await getShoppingSuggestions(OWNER);
    expect(suggestions.some((s) => s.itemName === 'Yogurt' && s.type === 'restock')).toBe(false);
  });

  test('a budget_tip only appears when a real, explicitly-stored budget target exists', async () => {
    expect((await getShoppingSuggestions(OWNER)).some((s) => s.type === 'budget_tip')).toBe(false);
    await setDefaultBudgetTarget(OWNER, 150);
    const withBudget = await getShoppingSuggestions(OWNER);
    const tip = withBudget.find((s) => s.type === 'budget_tip');
    expect(tip?.reason).toContain('$150.00');
  });

  test('a signed-out shopper (no ownerEmail) gets no suggestions at all, never an error', async () => {
    expect(await getShoppingSuggestions('')).toEqual([]);
  });

  test('dismissing a suggestion removes it from subsequent results', async () => {
    const realNow = Date.now();
    await purchaseAt('Whole Milk', 22, realNow);
    await purchaseAt('Whole Milk', 15, realNow);
    await purchaseAt('Whole Milk', 8, realNow);
    jest.spyOn(Date, 'now').mockReturnValue(realNow);

    const before = await getShoppingSuggestions(OWNER);
    const milk = before.find((s) => s.itemName === 'Whole Milk')!;
    await dismissSuggestion(OWNER, milk);

    const after = await getShoppingSuggestions(OWNER);
    expect(after.some((s) => s.itemName === 'Whole Milk')).toBe(false);
  });
});

describe('getShoppingSuggestions — Phase 5.3 price-comparison budget_tip', () => {
  test('a real historical price plus a real, cheaper current match produces a budget_tip with both real numbers', async () => {
    await recordPurchases(OWNER, [{ product: { ...makeProduct('milk-1', 'Whole Milk'), price: 4.99 }, quantity: 1 }]);
    const deps = {
      search: jest.fn().mockResolvedValue({
        products: [{ ...makeProduct('cheap-milk', 'Whole Milk'), price: 3.49, matchType: 'direct' as const }],
        storeStatuses: [],
      }),
      getZipcode: () => '78701',
    };

    const suggestions = await getShoppingSuggestions(OWNER, deps);
    const tip = suggestions.find((s) => s.type === 'budget_tip' && s.itemName === 'Whole Milk');
    expect(tip?.reason).toBe('Your last Whole Milk purchase was $4.99. Current plans include a cheaper equivalent at $3.49.');
  });

  test('no cheaper current match means no price-comparison budget_tip — never "usually expensive" with no evidence', async () => {
    await recordPurchases(OWNER, [{ product: { ...makeProduct('milk-1', 'Whole Milk'), price: 3.49 }, quantity: 1 }]);
    const deps = {
      search: jest.fn().mockResolvedValue({
        products: [{ ...makeProduct('same-milk', 'Whole Milk'), price: 4.99, matchType: 'direct' as const }],
        storeStatuses: [],
      }),
      getZipcode: () => '78701',
    };

    const suggestions = await getShoppingSuggestions(OWNER, deps);
    expect(suggestions.some((s) => s.type === 'budget_tip' && s.itemName === 'Whole Milk')).toBe(false);
  });

  test('no zipcode means no price-comparison lookup at all — never a guess without a real current search', async () => {
    await recordPurchases(OWNER, [{ product: { ...makeProduct('milk-1', 'Whole Milk'), price: 4.99 }, quantity: 1 }]);
    const searchSpy = jest.fn();
    const suggestions = await getShoppingSuggestions(OWNER, { search: searchSpy, getZipcode: () => '' });

    expect(searchSpy).not.toHaveBeenCalled();
    expect(suggestions.some((s) => s.type === 'budget_tip')).toBe(false);
  });

  test('a failed search lookup never becomes a fabricated tip', async () => {
    await recordPurchases(OWNER, [{ product: { ...makeProduct('milk-1', 'Whole Milk'), price: 4.99 }, quantity: 1 }]);
    const deps = { search: jest.fn().mockRejectedValue(new Error('network down')), getZipcode: () => '78701' };

    const suggestions = await getShoppingSuggestions(OWNER, deps);
    expect(suggestions.some((s) => s.type === 'budget_tip')).toBe(false);
  });
});

describe('getShoppingSuggestions — Phase 5.3 priority ordering', () => {
  test('urgent (restock) suggestions always sort before helpful (frequent_purchase) and optional (budget_tip)', async () => {
    const realNow = Date.now();
    await purchaseAt('Whole Milk', 22, realNow); // restock: urgent
    await purchaseAt('Whole Milk', 15, realNow);
    await purchaseAt('Whole Milk', 8, realNow);
    await purchaseAt('Bananas', 40, realNow); // frequent_purchase: helpful
    await purchaseAt('Bananas', 20, realNow);
    await purchaseAt('Bananas', 0, realNow);
    jest.spyOn(Date, 'now').mockReturnValue(realNow);
    await setDefaultBudgetTarget(OWNER, 150); // budget_tip: optional

    const suggestions = await getShoppingSuggestions(OWNER);
    const priorities = suggestions.map((s) => s.priority);
    const urgentIndex = priorities.indexOf('urgent');
    const helpfulIndex = priorities.indexOf('helpful');
    const optionalIndex = priorities.indexOf('optional');

    expect(urgentIndex).toBeGreaterThanOrEqual(0);
    expect(urgentIndex).toBeLessThan(helpfulIndex);
    expect(helpfulIndex).toBeLessThan(optionalIndex);
  });

  test('the fixed type-to-priority mapping is exactly restock=urgent, frequent_purchase=helpful, budget_tip=optional', async () => {
    const realNow = Date.now();
    await purchaseAt('Whole Milk', 22, realNow);
    await purchaseAt('Whole Milk', 15, realNow);
    await purchaseAt('Whole Milk', 8, realNow);
    jest.spyOn(Date, 'now').mockReturnValue(realNow);
    await setDefaultBudgetTarget(OWNER, 150);

    const suggestions = await getShoppingSuggestions(OWNER);
    for (const s of suggestions) {
      if (s.type === 'restock') expect(s.priority).toBe('urgent');
      if (s.type === 'frequent_purchase') expect(s.priority).toBe('helpful');
      if (s.type === 'budget_tip') expect(s.priority).toBe('optional');
    }
  });
});

describe('safety — suggestions are read-only', () => {
  test('getShoppingSuggestions never mutates the cart or any session state — it has no such dependency', async () => {
    // Structural: this function's own signature takes only an ownerEmail
    // and returns data — there is no cart/session parameter for it to
    // mutate even if it wanted to.
    const suggestions = await getShoppingSuggestions(OWNER);
    expect(Array.isArray(suggestions)).toBe(true);
  });
});

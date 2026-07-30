import AsyncStorage from '@react-native-async-storage/async-storage';
import { estimateInventoryStatus, estimateAllInventory, getLikelyLowStockDisplayNames } from '../inventoryEstimationService';
import { recordPurchases } from '../purchaseHistoryService';
import type { PurchaseRecord } from '../purchaseHistoryService';
import type { ApiProduct, CartItem } from '../../models/types';

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));

const OWNER = 'shopper@example.com';
const DAY_MS = 24 * 60 * 60 * 1000;

function record(overrides: Partial<PurchaseRecord> & { timestamp: number }): PurchaseRecord {
  return {
    normalizedName: 'milk', displayName: 'Whole Milk', store: 'Kroger', brand: 'Kroger',
    isOrganic: false, price: 3.5, quantity: 1,
    ...overrides,
  };
}

describe('estimateInventoryStatus — pure core', () => {
  test('no history at all returns unknown, never a fabricated status', () => {
    const result = estimateInventoryStatus([]);
    expect(result.estimatedStatus).toBe('unknown');
    expect(result.confidence).toBe('low');
  });

  test('a recently-repurchased product (well within its typical cycle) is likely_available', () => {
    const now = new Date(2024, 5, 20);
    // ~6.5-day average cycle (14→7 is 7 days, 7→1 is 6 days), last bought
    // just 1 day ago — comfortably within the cycle, not overdue.
    const records = [
      record({ timestamp: now.getTime() - 14 * DAY_MS }),
      record({ timestamp: now.getTime() - 7 * DAY_MS }),
      record({ timestamp: now.getTime() - 1 * DAY_MS }),
    ];
    const result = estimateInventoryStatus(records, now);
    expect(result.estimatedStatus).toBe('likely_available');
    expect(result.confidence).toBe('high'); // 3 real purchases
  });

  test('a product well overdue against its typical cycle is likely_low', () => {
    const now = new Date(2024, 5, 20);
    // Two purchases 7 days apart (a ~7-day cycle), last one 20 days ago — way overdue.
    const overdueRecords = [
      record({ timestamp: now.getTime() - 27 * DAY_MS }),
      record({ timestamp: now.getTime() - 20 * DAY_MS }),
    ];
    const result = estimateInventoryStatus(overdueRecords, now);
    expect(result.estimatedStatus).toBe('likely_low');
    expect(result.confidence).toBe('medium'); // exactly 2 real purchases
  });

  test('quantity affects status: buying 3 at once keeps the same-timing purchase likely_available instead of likely_low', () => {
    const now = new Date(2024, 5, 20);
    const baseRecords = [
      record({ timestamp: now.getTime() - 14 * DAY_MS, quantity: 1 }),
      record({ timestamp: now.getTime() - 7 * DAY_MS, quantity: 1 }), // ~7-day cycle, last bought 7 days ago
    ];
    const singleQuantity = estimateInventoryStatus(baseRecords, now);
    expect(singleQuantity.estimatedStatus).toBe('likely_low'); // 7 days / 7-day cycle = right at the ratio bar

    const bulkRecords = [
      record({ timestamp: now.getTime() - 14 * DAY_MS, quantity: 1 }),
      record({ timestamp: now.getTime() - 7 * DAY_MS, quantity: 3 }), // same timing, bought 3 at once
    ];
    const bulkQuantity = estimateInventoryStatus(bulkRecords, now);
    expect(bulkQuantity.estimatedStatus).toBe('likely_available'); // 3x the assumed depletion window
  });

  test('quantity affects confidence indirectly through the category-default path: a single bulk purchase with a known category is medium confidence, not low', () => {
    const now = new Date(2024, 5, 20);
    const oneKnownCategoryPurchase = [record({ timestamp: now.getTime() - 3 * DAY_MS, category: 'dairy' })];
    const result = estimateInventoryStatus(oneKnownCategoryPurchase, now);
    expect(result.confidence).toBe('medium');

    const oneUnknownCategoryPurchase = [record({ timestamp: now.getTime() - 3 * DAY_MS, category: undefined })];
    const unknownResult = estimateInventoryStatus(oneUnknownCategoryPurchase, now);
    expect(unknownResult.confidence).toBe('low');
    expect(unknownResult.estimatedStatus).toBe('unknown');
  });

  test('missing/invalid quantity never crashes and defaults to 1', () => {
    const now = new Date(2024, 5, 20);
    const records = [
      record({ timestamp: now.getTime() - 14 * DAY_MS, quantity: 0 }),
      record({ timestamp: now.getTime() - 7 * DAY_MS, quantity: 0 }),
    ];
    expect(() => estimateInventoryStatus(records, now)).not.toThrow();
  });
});

describe('estimateAllInventory — real purchase history + canonicalId grouping', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  function makeProduct(overrides: Partial<ApiProduct>): ApiProduct {
    return { id: 'x', name: 'Milk', brand: 'Brand', price: 3, rating: 4, size: '1 gal', store: 'Kroger', ...overrides };
  }

  test('existing user with no purchase history at all degrades gracefully to an empty list, not an error', async () => {
    const estimates = await estimateAllInventory(OWNER);
    expect(estimates).toEqual([]);
  });

  test('two purchases under different names but the same canonicalId are grouped into one estimate', async () => {
    const organicMilk: CartItem = { product: makeProduct({ name: 'Organic Whole Milk', canonicalId: 'whole-milk' }), quantity: 1 };
    const storeBrandMilk: CartItem = { product: makeProduct({ name: '365 Whole Milk', canonicalId: 'whole-milk' }), quantity: 1 };
    await recordPurchases(OWNER, [organicMilk]);
    await recordPurchases(OWNER, [storeBrandMilk]);

    const estimates = await estimateAllInventory(OWNER);
    expect(estimates).toHaveLength(1);
    expect(estimates[0].canonicalId).toBe('whole-milk');
  });

  test('purchases with no canonicalId at all fall back to normalizedName grouping, same as before this feature existed', async () => {
    const milk: CartItem = { product: makeProduct({ name: 'Whole Milk' }), quantity: 1 };
    const eggs: CartItem = { product: makeProduct({ name: 'Eggs' }), quantity: 1 };
    await recordPurchases(OWNER, [milk, eggs]);

    const estimates = await estimateAllInventory(OWNER);
    expect(estimates).toHaveLength(2);
    expect(estimates.every((e) => e.canonicalId === undefined)).toBe(true);
  });
});

// This is a thin, pure wrapper (filter/slice/map) over `estimateAllInventory`
// — the real classification logic it reads from is already exhaustively
// covered above; these tests only cover the wrapper's own contract, shared
// now by both assistantDispatcher.ts's `getLowStockItems` and
// MealPlannerScreen.tsx.
describe('getLikelyLowStockDisplayNames', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  test('a signed-out shopper (empty ownerEmail) gets an empty list, never a lookup attempt', async () => {
    expect(await getLikelyLowStockDisplayNames('')).toEqual([]);
  });

  test('an account with no purchase history at all gets an empty list, not an error', async () => {
    expect(await getLikelyLowStockDisplayNames(OWNER)).toEqual([]);
  });
});

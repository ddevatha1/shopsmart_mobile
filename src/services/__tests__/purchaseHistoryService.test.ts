import AsyncStorage from '@react-native-async-storage/async-storage';
import { getAllRecords, getMostRecentPurchase, recordPurchases } from '../purchaseHistoryService';
import type { ApiProduct, CartItem } from '../../models/types';

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));

const OWNER = 'shopper@example.com';

function makeProduct(overrides: Partial<ApiProduct> = {}): ApiProduct {
  return { id: `p-${Math.random()}`, name: 'Whole Milk', brand: 'Test Brand', price: 3.99, rating: 4.5, size: '1 gal', store: 'Aldi', ...overrides };
}

function makeCartItem(product: ApiProduct, quantity = 1): CartItem {
  return { product, quantity };
}

describe('getMostRecentPurchase', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    jest.restoreAllMocks();
  });

  test('returns undefined for a product this shopper has never bought', async () => {
    const records = await getAllRecords(OWNER);
    expect(getMostRecentPurchase(makeProduct(), records)).toBeUndefined();
  });

  test('returns the one real record for a product bought once', async () => {
    await recordPurchases(OWNER, [makeCartItem(makeProduct({ name: 'Whole Milk', price: 3.5 }))]);
    const records = await getAllRecords(OWNER);
    const match = getMostRecentPurchase({ name: 'Whole Milk' }, records);
    expect(match?.price).toBe(3.5);
  });

  test('returns the most recent of several real purchases, matched by normalized name', async () => {
    const realNow = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(realNow - 2 * 24 * 60 * 60 * 1000);
    await recordPurchases(OWNER, [makeCartItem(makeProduct({ name: 'Whole Milk', price: 4.0 }))]);
    jest.spyOn(Date, 'now').mockReturnValue(realNow);
    await recordPurchases(OWNER, [makeCartItem(makeProduct({ name: 'Whole Milk', price: 3.5 }))]);

    const records = await getAllRecords(OWNER);
    const match = getMostRecentPurchase({ name: 'Whole Milk' }, records);
    expect(match?.price).toBe(3.5);
  });

  test('never matches a differently-named product', async () => {
    await recordPurchases(OWNER, [makeCartItem(makeProduct({ name: 'Whole Milk' }))]);
    const records = await getAllRecords(OWNER);
    expect(getMostRecentPurchase({ name: 'Eggs' }, records)).toBeUndefined();
  });
});

import AsyncStorage from '@react-native-async-storage/async-storage';
import { recordObservations, getStats, getStatsForMany } from '../priceHistoryService';
import type { ApiProduct } from '../../models/types';

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));

function makeProduct(overrides: Partial<ApiProduct> & Pick<ApiProduct, 'id' | 'name' | 'price'>): ApiProduct {
  return { brand: 'Brand', rating: 4, size: '1 gal', store: 'Kroger', ...overrides };
}

describe('priceHistoryService — getStatsForMany (batched, single-log-read path)', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  test('a product with fewer than 2 observations is absent from the map, not a null entry', async () => {
    await recordObservations([makeProduct({ id: 'milk-1', name: 'Whole Milk', price: 4 })]);

    const stats = await getStatsForMany([{ id: 'milk-1', name: 'Whole Milk', price: 4, store: 'Kroger' }]);

    expect(stats.has('milk-1')).toBe(false);
  });

  test('a product with real observed history gets real stats, keyed by product id', async () => {
    await recordObservations([makeProduct({ id: 'milk-1', name: 'Whole Milk', price: 4 })]);
    await recordObservations([makeProduct({ id: 'milk-1', name: 'Whole Milk', price: 3 })]);

    const stats = await getStatsForMany([{ id: 'milk-1', name: 'Whole Milk', price: 3, store: 'Kroger' }]);

    expect(stats.get('milk-1')?.trend).toBe('down');
    expect(stats.get('milk-1')?.observationCount).toBe(2);
  });

  test('matches getStats\' own result for the same product (same underlying computation)', async () => {
    await recordObservations([makeProduct({ id: 'bread-1', name: 'Sourdough Bread', price: 5 })]);
    await recordObservations([makeProduct({ id: 'bread-1', name: 'Sourdough Bread', price: 6 })]);
    const product = { id: 'bread-1', name: 'Sourdough Bread', price: 6, store: 'Kroger' as const };

    const single = await getStats(product);
    const batched = await getStatsForMany([product]);

    expect(batched.get('bread-1')).toEqual(single);
  });

  test('handles a mix of products with and without enough history in one call', async () => {
    await recordObservations([makeProduct({ id: 'eggs-1', name: 'Eggs', price: 3 })]);
    await recordObservations([makeProduct({ id: 'eggs-1', name: 'Eggs', price: 3 })]);
    // 'butter-1' only ever observed once — no real stats yet.

    const stats = await getStatsForMany([
      { id: 'eggs-1', name: 'Eggs', price: 3, store: 'Kroger' },
      { id: 'butter-1', name: 'Butter', price: 4, store: 'Kroger' },
    ]);

    expect(stats.has('eggs-1')).toBe(true);
    expect(stats.has('butter-1')).toBe(false);
  });

  test('an empty product list returns an empty map without throwing', async () => {
    const stats = await getStatsForMany([]);
    expect(stats.size).toBe(0);
  });
});

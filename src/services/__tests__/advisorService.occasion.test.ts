import AsyncStorage from '@react-native-async-storage/async-storage';
import { getCartInsight } from '../advisorService';
import type { ApiProduct, CartItem, StoreGroup, StoreLocation } from '../../models/types';

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));

const LOCATION: StoreLocation = { name: 'Kroger', address: '1 Main St', city: 'Springfield', state: 'TX', zip: '78701' };

function item(name: string): CartItem {
  const product: ApiProduct = { id: name, name, brand: 'Brand', price: 3, rating: 4, size: '1 ea', store: 'Kroger' };
  return { product, quantity: 1 };
}

function groupOf(items: CartItem[]): StoreGroup[] {
  return [{ location: LOCATION, items }];
}

describe('advisorService — occasion insight', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  test('a matching pair in the cart produces an occasion insight', async () => {
    const groups = groupOf([item('Penne Pasta'), item('Marinara Pasta Sauce')]);
    const insight = await getCartInsight({ groups, trip: null, cartTotal: 6 });
    expect(insight?.kind).toBe('occasion');
    expect(insight?.title).toContain('Italian meal');
  });

  test('an unrelated cart produces no occasion insight (falls through to well-optimized)', async () => {
    const groups = groupOf([item('Whole Milk'), item('Bread')]);
    const insight = await getCartInsight({ groups, trip: null, cartTotal: 6 });
    expect(insight?.kind).not.toBe('occasion');
  });

  test('a partial match (only pasta, no sauce) does not over-trigger an occasion insight', async () => {
    const groups = groupOf([item('Spaghetti')]);
    const insight = await getCartInsight({ groups, trip: null, cartTotal: 3 });
    expect(insight?.kind).not.toBe('occasion');
  });
});

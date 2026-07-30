import AsyncStorage from '@react-native-async-storage/async-storage';
import { getCartInsight } from '../advisorService';
import type { ApiProduct, CartItem, StoreGroup, StoreLocation } from '../../models/types';

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));

const LOCATION: StoreLocation = { name: 'Kroger', address: '1 Main St', city: 'Springfield', state: 'TX', zip: '78701' };

function product(overrides: Partial<ApiProduct> & Pick<ApiProduct, 'id' | 'name' | 'price' | 'store'>): ApiProduct {
  return { brand: 'Brand', rating: 4, size: '1 gal', ...overrides };
}

function cartItemOf(p: ApiProduct): CartItem {
  return { product: p, quantity: 1 };
}

function groupOf(items: CartItem[]): StoreGroup[] {
  return [{ location: LOCATION, items }];
}

describe('advisorService — substitution insight (unavailable cart item -> real alternative)', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  test('a cart item now reporting inStock:false in the freshest search, with a real cheaper alternative, produces a substitution insight', async () => {
    const cartMilk = product({ id: 'milk-kroger', name: 'Whole Milk', price: 5, store: 'Kroger' });
    const groups = groupOf([cartItemOf(cartMilk)]);

    const searchProducts: ApiProduct[] = [
      product({ id: 'milk-kroger', name: 'Whole Milk', price: 5, store: 'Kroger', inStock: false }),
      product({ id: 'milk-aldi', name: 'Whole Milk', price: 3, store: 'Aldi' }),
    ];

    const insight = await getCartInsight({ groups, trip: null, cartTotal: 5, searchProducts });

    expect(insight?.kind).toBe('substitution');
    expect(insight?.product?.id).toBe('milk-aldi');
    expect(insight?.title).toContain('Whole Milk');
    expect(insight?.title).toContain('Kroger');
    expect(insight?.actions).toEqual(expect.arrayContaining(['see-product', 'add-to-cart']));
  });

  test('no fresher data for the cart item at all -> no substitution insight', async () => {
    const cartMilk = product({ id: 'milk-kroger', name: 'Whole Milk', price: 5, store: 'Kroger' });
    const groups = groupOf([cartItemOf(cartMilk)]);

    const insight = await getCartInsight({ groups, trip: null, cartTotal: 5, searchProducts: [] });

    expect(insight?.kind).not.toBe('substitution');
  });

  test('fresher data exists but still reports in stock -> no substitution insight', async () => {
    const cartMilk = product({ id: 'milk-kroger', name: 'Whole Milk', price: 5, store: 'Kroger' });
    const groups = groupOf([cartItemOf(cartMilk)]);
    const searchProducts: ApiProduct[] = [
      product({ id: 'milk-kroger', name: 'Whole Milk', price: 5, store: 'Kroger' }),
      product({ id: 'milk-aldi', name: 'Whole Milk', price: 3, store: 'Aldi' }),
    ];

    const insight = await getCartInsight({ groups, trip: null, cartTotal: 5, searchProducts });

    expect(insight?.kind).not.toBe('substitution');
  });

  test('reported unavailable but no real alternative exists -> no substitution insight (never a product-less trigger)', async () => {
    const cartMilk = product({ id: 'milk-kroger', name: 'Whole Milk', price: 5, store: 'Kroger' });
    const groups = groupOf([cartItemOf(cartMilk)]);
    const searchProducts: ApiProduct[] = [
      product({ id: 'milk-kroger', name: 'Whole Milk', price: 5, store: 'Kroger', inStock: false }),
    ];

    const insight = await getCartInsight({ groups, trip: null, cartTotal: 5, searchProducts });

    expect(insight?.kind).not.toBe('substitution');
  });

  test('omitting searchProducts entirely keeps prior behavior (no crash, no substitution)', async () => {
    const cartMilk = product({ id: 'milk-kroger', name: 'Whole Milk', price: 5, store: 'Kroger' });
    const groups = groupOf([cartItemOf(cartMilk)]);

    const insight = await getCartInsight({ groups, trip: null, cartTotal: 5 });

    expect(insight?.kind).not.toBe('substitution');
  });
});

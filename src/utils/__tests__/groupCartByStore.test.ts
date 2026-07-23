import { groupCartByStore, locationKey } from '../groupCartByStore';
import type { ApiProduct, CartItem, StoreLocation } from '../../models/types';

function makeLocation(overrides: Partial<StoreLocation> = {}): StoreLocation {
  return {
    name: 'Aldi - Downtown',
    storeId: '123',
    address: '100 Main St',
    city: 'Austin',
    state: 'TX',
    zip: '78701',
    ...overrides,
  };
}

function makeProduct(overrides: Partial<ApiProduct> = {}): ApiProduct {
  return {
    id: `p-${Math.random()}`,
    name: 'Whole Milk',
    brand: 'Test Brand',
    price: 3.99,
    rating: 4.5,
    size: '1 gal',
    store: 'Aldi',
    ...overrides,
  };
}

function makeItem(overrides: Partial<CartItem> = {}, productOverrides: Partial<ApiProduct> = {}): CartItem {
  return { product: makeProduct(productOverrides), quantity: 1, ...overrides };
}

describe('locationKey', () => {
  test('is case-insensitive', () => {
    const a = makeLocation({ city: 'Austin' });
    const b = makeLocation({ city: 'AUSTIN' });
    expect(locationKey(a)).toBe(locationKey(b));
  });

  test('differs when storeId differs even if address matches (two chains at the same address)', () => {
    const a = makeLocation({ storeId: '1' });
    const b = makeLocation({ storeId: '2' });
    expect(locationKey(a)).not.toBe(locationKey(b));
  });
});

describe('groupCartByStore', () => {
  test('groups items from the exact same StoreLocation together', () => {
    const location = makeLocation();
    const items: CartItem[] = [
      makeItem({}, { location, name: 'Milk' }),
      makeItem({}, { location, name: 'Eggs' }),
    ];
    const { groups, itemsWithoutLocation } = groupCartByStore(items);
    expect(groups).toHaveLength(1);
    expect(groups[0].items).toHaveLength(2);
    expect(itemsWithoutLocation).toHaveLength(0);
  });

  test('never merges two different physical stores of the same chain', () => {
    const storeA = makeLocation({ storeId: 'A', address: '1 First St' });
    const storeB = makeLocation({ storeId: 'B', address: '2 Second St' });
    const items: CartItem[] = [
      makeItem({}, { location: storeA }),
      makeItem({}, { location: storeB }),
    ];
    const { groups } = groupCartByStore(items);
    expect(groups).toHaveLength(2);
  });

  test('returns items with no location separately instead of dropping them', () => {
    const items: CartItem[] = [
      makeItem({}, { location: undefined }),
      makeItem({}, { location: makeLocation() }),
    ];
    const { groups, itemsWithoutLocation } = groupCartByStore(items);
    expect(groups).toHaveLength(1);
    expect(itemsWithoutLocation).toHaveLength(1);
  });

  test('returns empty results for an empty cart', () => {
    const { groups, itemsWithoutLocation } = groupCartByStore([]);
    expect(groups).toEqual([]);
    expect(itemsWithoutLocation).toEqual([]);
  });
});

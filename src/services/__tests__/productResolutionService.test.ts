import { resolveProductRequest, resolveCartItemForRemoval, type ProductResolutionDependencies } from '../productResolutionService';
import type { ApiProduct, CartItem } from '../../models/types';

function makeProduct(id: string, overrides: Partial<ApiProduct> = {}): ApiProduct {
  return { id, name: `Product ${id}`, brand: 'Brand', price: 3, rating: 4, size: '1 ea', store: 'Kroger', ...overrides };
}

function deps(overrides: Partial<ProductResolutionDependencies> = {}): ProductResolutionDependencies {
  return {
    search: jest.fn().mockResolvedValue({ products: [], storeStatuses: [] }),
    getZipcode: () => '78701',
    ...overrides,
  };
}

describe('resolveProductRequest', () => {
  test('1. Exactly one real direct match resolves', async () => {
    const match = makeProduct('milk-1', { matchType: 'direct' });
    const result = await resolveProductRequest('milk', deps({ search: jest.fn().mockResolvedValue({ products: [match], storeStatuses: [] }) }));

    expect(result).toEqual({ status: 'resolved', product: match });
  });

  test('2. Multiple direct matches (e.g. several milk products) require selection', async () => {
    const products = [makeProduct('a', { matchType: 'direct' }), makeProduct('b', { matchType: 'direct' })];
    const result = await resolveProductRequest('milk', deps({ search: jest.fn().mockResolvedValue({ products, storeStatuses: [] }) }));

    expect(result.status).toBe('needs_selection');
    if (result.status === 'needs_selection') {
      expect(result.candidates.map((c) => c.id).sort()).toEqual(['a', 'b']);
    }
  });

  test('3. No results returns not_found', async () => {
    const result = await resolveProductRequest('unobtainium', deps({ search: jest.fn().mockResolvedValue({ products: [], storeStatuses: [] }) }));
    expect(result).toEqual({ status: 'not_found' });
  });

  test('"related" matches are never candidates — only real direct matches count', async () => {
    const related = makeProduct('cereal', { matchType: 'related' });
    const result = await resolveProductRequest('milk', deps({ search: jest.fn().mockResolvedValue({ products: [related], storeStatuses: [] }) }));
    expect(result).toEqual({ status: 'not_found' });
  });

  test('a direct match is preferred and related matches are excluded from a mixed result set', async () => {
    const direct = makeProduct('milk-direct', { matchType: 'direct' });
    const related = makeProduct('milk-related', { matchType: 'related' });
    const result = await resolveProductRequest(
      'milk',
      deps({ search: jest.fn().mockResolvedValue({ products: [direct, related], storeStatuses: [] }) }),
    );
    expect(result).toEqual({ status: 'resolved', product: direct });
  });

  test('never selects the cheapest product automatically when multiple direct matches exist', async () => {
    const cheap = makeProduct('cheap', { matchType: 'direct', price: 1 });
    const pricey = makeProduct('pricey', { matchType: 'direct', price: 10 });
    const result = await resolveProductRequest(
      'milk',
      deps({ search: jest.fn().mockResolvedValue({ products: [pricey, cheap], storeStatuses: [] }) }),
    );
    expect(result.status).toBe('needs_selection'); // never silently resolves to the cheap one
  });

  test('never selects the first result automatically when multiple direct matches exist', async () => {
    const first = makeProduct('first', { matchType: 'direct' });
    const second = makeProduct('second', { matchType: 'direct' });
    const result = await resolveProductRequest(
      'milk',
      deps({ search: jest.fn().mockResolvedValue({ products: [first, second], storeStatuses: [] }) }),
    );
    expect(result.status).toBe('needs_selection'); // never silently resolves to `first`
  });

  test('4. resolveProductRequest never reads or trusts an externally-supplied productId — its result is search-derived only', async () => {
    // There is no productId parameter on this function's signature at
    // all — this test documents that fact structurally: the result is
    // determined ENTIRELY by what deps.search returns, nothing else.
    const match = makeProduct('real-match', { matchType: 'direct' });
    const searchSpy = jest.fn().mockResolvedValue({ products: [match], storeStatuses: [] });
    const result = await resolveProductRequest('milk', deps({ search: searchSpy }));

    expect(searchSpy).toHaveBeenCalledWith('milk', '78701');
    expect(result).toEqual({ status: 'resolved', product: match });
  });

  test('an empty query never triggers a search and returns not_found', async () => {
    const searchSpy = jest.fn().mockResolvedValue({ products: [], storeStatuses: [] });
    const result = await resolveProductRequest('   ', deps({ search: searchSpy }));
    expect(result).toEqual({ status: 'not_found' });
    expect(searchSpy).not.toHaveBeenCalled();
  });

  test('a missing zipcode returns not_found without ever calling search', async () => {
    const searchSpy = jest.fn().mockResolvedValue({ products: [], storeStatuses: [] });
    const result = await resolveProductRequest('milk', deps({ getZipcode: () => '', search: searchSpy }));
    expect(result).toEqual({ status: 'not_found' });
    expect(searchSpy).not.toHaveBeenCalled();
  });

  test('candidates are capped at a reasonable maximum, never an unbounded list', async () => {
    const products = Array.from({ length: 20 }, (_, i) => makeProduct(`p${i}`, { matchType: 'direct' }));
    const result = await resolveProductRequest('milk', deps({ search: jest.fn().mockResolvedValue({ products, storeStatuses: [] }) }));
    expect(result.status).toBe('needs_selection');
    if (result.status === 'needs_selection') {
      expect(result.candidates.length).toBeLessThanOrEqual(8);
    }
  });
});

describe('resolveCartItemForRemoval', () => {
  function cartItem(id: string, name: string): CartItem {
    return { product: makeProduct(id, { name }), quantity: 1 };
  }

  test('resolves a single matching cart item', () => {
    const cart = [cartItem('milk-1', 'Whole Milk'), cartItem('bread-1', 'Sandwich Bread')];
    const result = resolveCartItemForRemoval('milk', cart);
    expect(result).toEqual({ status: 'resolved', product: cart[0].product });
  });

  test('requires selection when multiple cart items match', () => {
    const cart = [cartItem('a', 'Whole Milk'), cartItem('b', 'Almond Milk')];
    const result = resolveCartItemForRemoval('milk', cart);
    expect(result.status).toBe('needs_selection');
  });

  test('returns not_found when nothing in the cart matches', () => {
    const cart = [cartItem('a', 'Sandwich Bread')];
    const result = resolveCartItemForRemoval('milk', cart);
    expect(result).toEqual({ status: 'not_found' });
  });

  test('returns not_found for an empty cart, never throwing', () => {
    expect(() => resolveCartItemForRemoval('milk', [])).not.toThrow();
    expect(resolveCartItemForRemoval('milk', [])).toEqual({ status: 'not_found' });
  });

  test('never calls a search service — it only ever reads the cart items it was given', () => {
    const cart = [cartItem('milk-1', 'Whole Milk')];
    // No network/search dependency exists on this function's signature at
    // all — this is a synchronous, pure function over the given array.
    const result = resolveCartItemForRemoval('milk', cart);
    expect(result.status).toBe('resolved');
  });
});

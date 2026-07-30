import {
  createPendingProductSelection, getPendingProductSelection, clearPendingProductSelection,
  createPendingCartMutationConfirmation, getPendingCartMutationConfirmation, clearPendingCartMutationConfirmation,
} from '../productSelectionStore';
import type { ApiProduct } from '../../models/types';
import type { Intent } from '../../models/intent';

function makeProduct(id: string): ApiProduct {
  return { id, name: `Product ${id}`, brand: 'Brand', price: 3, rating: 4, size: '1 ea', store: 'Kroger' };
}

function makeIntent(overrides: Partial<Intent> = {}): Intent {
  return { type: 'add_to_cart', confidence: 0.8, parameters: { item: 'milk' }, ...overrides };
}

describe('productSelectionStore — product selection', () => {
  afterEach(() => {
    clearPendingProductSelection();
    clearPendingCartMutationConfirmation();
    jest.restoreAllMocks();
  });

  test('a pending product selection can be created, retrieved, and cleared', () => {
    expect(getPendingProductSelection()).toBeUndefined();

    const candidates = [makeProduct('a'), makeProduct('b')];
    const created = createPendingProductSelection({ originalIntent: makeIntent(), query: 'milk', candidates });
    expect(created.candidates).toBe(candidates);

    expect(getPendingProductSelection()).toEqual(created);

    clearPendingProductSelection();
    expect(getPendingProductSelection()).toBeUndefined();
  });

  test('creating a new selection replaces any previous one', () => {
    createPendingProductSelection({ originalIntent: makeIntent(), query: 'milk', candidates: [makeProduct('a')] });
    const second = createPendingProductSelection({ originalIntent: makeIntent(), query: 'eggs', candidates: [makeProduct('b')] });

    expect(getPendingProductSelection()).toEqual(second);
  });

  test('8. An expired pending product selection is rejected and cleared on read', () => {
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now);
    createPendingProductSelection({ originalIntent: makeIntent(), query: 'milk', candidates: [makeProduct('a')] });

    jest.spyOn(Date, 'now').mockReturnValue(now + 10 * 60 * 1000);
    expect(getPendingProductSelection()).toBeUndefined();
    expect(getPendingProductSelection()).toBeUndefined(); // stays gone, not a one-time glitch
  });

  test('creating a confirmation clears any pending selection — the two slots are mutually exclusive', () => {
    createPendingProductSelection({ originalIntent: makeIntent(), query: 'milk', candidates: [makeProduct('a')] });
    createPendingCartMutationConfirmation({ action: 'add_to_cart', product: makeProduct('a'), originalIntent: makeIntent() });

    expect(getPendingProductSelection()).toBeUndefined();
    expect(getPendingCartMutationConfirmation()).toBeTruthy();
  });
});

describe('productSelectionStore — cart mutation confirmation', () => {
  afterEach(() => {
    clearPendingProductSelection();
    clearPendingCartMutationConfirmation();
    jest.restoreAllMocks();
  });

  test('a pending confirmation can be created, retrieved, and cleared', () => {
    expect(getPendingCartMutationConfirmation()).toBeUndefined();

    const product = makeProduct('a');
    const created = createPendingCartMutationConfirmation({ action: 'add_to_cart', product, originalIntent: makeIntent() });
    expect(created.product).toBe(product);
    expect(created.action).toBe('add_to_cart');

    expect(getPendingCartMutationConfirmation()).toEqual(created);

    clearPendingCartMutationConfirmation();
    expect(getPendingCartMutationConfirmation()).toBeUndefined();
  });

  test('an expired pending confirmation is rejected and cleared on read', () => {
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now);
    createPendingCartMutationConfirmation({ action: 'add_to_cart', product: makeProduct('a'), originalIntent: makeIntent() });

    jest.spyOn(Date, 'now').mockReturnValue(now + 10 * 60 * 1000);
    expect(getPendingCartMutationConfirmation()).toBeUndefined();
  });

  test('creating a selection clears any pending confirmation — mutually exclusive in the other direction too', () => {
    createPendingCartMutationConfirmation({ action: 'add_to_cart', product: makeProduct('a'), originalIntent: makeIntent() });
    createPendingProductSelection({ originalIntent: makeIntent(), query: 'milk', candidates: [makeProduct('b')] });

    expect(getPendingCartMutationConfirmation()).toBeUndefined();
    expect(getPendingProductSelection()).toBeTruthy();
  });

  test('clearing either store when nothing is pending is a safe no-op', () => {
    expect(() => clearPendingProductSelection()).not.toThrow();
    expect(() => clearPendingCartMutationConfirmation()).not.toThrow();
  });
});

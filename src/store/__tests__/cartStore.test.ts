import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCartStore } from '../cartStore';
import { useUserStore } from '../userStore';
import type { ApiProduct, CartItem, User } from '../../models/types';

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));

const TEST_USER: User = { id: '1', name: 'Test', email: 'shopper@example.com', zipcode: '75034', searchHistory: [] };

function makeProduct(id: string, store: ApiProduct['store'] = 'Kroger', price = 3): ApiProduct {
  return { id, name: `Product ${id}`, brand: 'Brand', price, rating: 4, size: '1 ea', store };
}

function makeItem(id: string, store: ApiProduct['store'] = 'Kroger', price = 3): CartItem {
  return { product: makeProduct(id, store, price), quantity: 1 };
}

describe('cartStore — Auto-Optimize apply/undo', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    useUserStore.setState({ user: TEST_USER });
    useCartStore.setState({ items: [], hydrated: true, lastOptimizationSnapshot: null });
  });

  test('applyOptimizedItems replaces the cart and snapshots the previous items', async () => {
    const before = [makeItem('a', 'Kroger'), makeItem('b', 'Aldi')];
    useCartStore.setState({ items: before });

    const after = [makeItem('a', 'Sprouts', 2.5)];
    await useCartStore.getState().applyOptimizedItems(after);

    expect(useCartStore.getState().items).toEqual(after);
    expect(useCartStore.getState().lastOptimizationSnapshot).toEqual(before);
  });

  test('undoLastOptimization restores the exact pre-apply cart instantly', async () => {
    const before = [makeItem('a', 'Kroger'), makeItem('b', 'Aldi')];
    useCartStore.setState({ items: before });
    await useCartStore.getState().applyOptimizedItems([makeItem('a', 'Sprouts')]);

    await useCartStore.getState().undoLastOptimization();

    expect(useCartStore.getState().items).toEqual(before);
    // Undo is single-shot — no snapshot left to undo again.
    expect(useCartStore.getState().lastOptimizationSnapshot).toBeNull();
  });

  test('undoLastOptimization persists the restored cart (survives a fresh hydrate)', async () => {
    const before = [makeItem('a', 'Kroger')];
    useCartStore.setState({ items: before });
    await useCartStore.getState().applyOptimizedItems([makeItem('a', 'Sprouts')]);
    await useCartStore.getState().undoLastOptimization();

    useCartStore.setState({ items: [], hydrated: false, lastOptimizationSnapshot: null });
    await useCartStore.getState().hydrate();

    expect(useCartStore.getState().items).toEqual(before);
  });

  test('undoLastOptimization is a no-op when nothing is pending', async () => {
    const items = [makeItem('a', 'Kroger')];
    useCartStore.setState({ items, lastOptimizationSnapshot: null });

    await useCartStore.getState().undoLastOptimization();

    expect(useCartStore.getState().items).toEqual(items);
  });

  test('a manual cart edit after applying clears the pending undo snapshot', async () => {
    useCartStore.setState({ items: [makeItem('a', 'Kroger')] });
    await useCartStore.getState().applyOptimizedItems([makeItem('b', 'Sprouts')]);
    expect(useCartStore.getState().lastOptimizationSnapshot).not.toBeNull();

    await useCartStore.getState().addToCart(makeProduct('c', 'Aldi'));

    expect(useCartStore.getState().lastOptimizationSnapshot).toBeNull();
  });

  test('setCart (e.g. the Planner\'s "Start Shopping") also clears any pending optimize-undo', async () => {
    useCartStore.setState({ items: [makeItem('a', 'Kroger')] });
    await useCartStore.getState().applyOptimizedItems([makeItem('b', 'Sprouts')]);
    expect(useCartStore.getState().lastOptimizationSnapshot).not.toBeNull();

    await useCartStore.getState().setCart([makeItem('c', 'Aldi')]);

    expect(useCartStore.getState().lastOptimizationSnapshot).toBeNull();
  });
});

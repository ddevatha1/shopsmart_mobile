import AsyncStorage from '@react-native-async-storage/async-storage';
import { dismissalKey, getHomeInsight } from '../advisorService';
import { dismissInsight } from '../dismissalStore';
import type { ApiProduct } from '../../models/types';

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));

const OWNER = 'shopper@example.com';

function makeDeal(id: string, discountPercent: number): ApiProduct {
  return {
    id, name: `Deal Product ${id}`, brand: 'Brand', price: 3, originalPrice: 5,
    discountPercent, rating: 4, size: '1 ea', store: 'Kroger',
  };
}

describe('advisorService — dismissal filtering', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  test('a dismissed insight does not immediately reappear for the same inputs', async () => {
    const deal = makeDeal('deal-1', 40);
    const first = await getHomeInsight({ ownerEmail: OWNER, recentSearchProducts: [deal] });
    expect(first?.kind).toBe('deal');

    await dismissInsight(OWNER, dismissalKey(first!));

    const second = await getHomeInsight({ ownerEmail: OWNER, recentSearchProducts: [deal] });
    expect(second).toBeNull();
  });

  test('dismissing one deal does not suppress an unrelated deal on a different product', async () => {
    const dealA = makeDeal('deal-a', 40);
    const dealB = makeDeal('deal-b', 30);

    const first = await getHomeInsight({ ownerEmail: OWNER, recentSearchProducts: [dealA] });
    await dismissInsight(OWNER, dismissalKey(first!));

    const second = await getHomeInsight({ ownerEmail: OWNER, recentSearchProducts: [dealB] });
    expect(second?.kind).toBe('deal');
    expect(second?.product?.id).toBe('deal-b');
  });
});

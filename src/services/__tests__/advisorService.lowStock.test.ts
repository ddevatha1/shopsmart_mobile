import AsyncStorage from '@react-native-async-storage/async-storage';
import { dismissalKey, getHomeInsight } from '../advisorService';
import { dismissInsight } from '../dismissalStore';
import { recordPurchases } from '../purchaseHistoryService';
import type { ApiProduct, CartItem } from '../../models/types';

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));

const OWNER = 'shopper@example.com';
const DAY_MS = 24 * 60 * 60 * 1000;

function milkPurchase(daysAgo: number, overrides: Partial<ApiProduct> = {}): CartItem {
  const product: ApiProduct = {
    id: `milk-${daysAgo}`, name: 'Whole Milk', brand: 'Kroger', price: 3.5, rating: 4, size: '1 gal', store: 'Kroger', ...overrides,
  };
  return { product, quantity: 1 };
}

/** Backdates the just-recorded purchase(s) so the "typical interval" math
 * has real historical spacing to work with — recordPurchases always
 * stamps `Date.now()`, so tests rewrite storage directly afterward,
 * same technique purchaseHistoryService.quantity.test.ts uses to seed
 * specific timestamps. */
async function backdateLastPurchase(daysAgo: number): Promise<void> {
  const key = `CartIQ_purchases_${OWNER}`;
  const raw = await AsyncStorage.getItem(key);
  const records = JSON.parse(raw ?? '[]');
  records[records.length - 1].timestamp = Date.now() - daysAgo * DAY_MS;
  await AsyncStorage.setItem(key, JSON.stringify(records));
}

describe('advisorService — low_stock insight', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  // Deliberately a SINGLE purchase with a known category default, not a
  // 2+-purchase pattern: with 2+ purchases, the pre-existing 'pantry'
  // insight (see purchaseHistoryService.getPantryReminders) fires on the
  // exact same signal at a higher priority and correctly wins pickTop —
  // that overlap is expected, not a bug (see advisorService.ts's header
  // comment on why 'pantry' and 'low_stock' are complementary, not
  // duplicates). 'low_stock' earns its own slot specifically for the
  // single-purchase/category-default case 'pantry' can never cover.
  test('low_stock appears on Home for a single purchase matched against a category default, overdue', async () => {
    await recordPurchases(OWNER, [milkPurchase(0, { category: 'dairy' })]);
    await backdateLastPurchase(8); // ~7-day dairy default, bought 8 days ago — overdue

    const insight = await getHomeInsight({ ownerEmail: OWNER, recentSearchProducts: [] });
    expect(insight?.kind).toBe('low_stock');
    expect(insight?.title).toContain('probably running low');
    expect(insight?.title).not.toContain('You need'); // never phrased as a command/fact
  });

  test('dismissing the low_stock insight suppresses it on the next call with the same inputs', async () => {
    await recordPurchases(OWNER, [milkPurchase(0, { category: 'dairy' })]);
    await backdateLastPurchase(8);

    const first = await getHomeInsight({ ownerEmail: OWNER, recentSearchProducts: [] });
    expect(first?.kind).toBe('low_stock');

    await dismissInsight(OWNER, dismissalKey(first!));
    const second = await getHomeInsight({ ownerEmail: OWNER, recentSearchProducts: [] });
    expect(second?.kind).not.toBe('low_stock');
  });

  test('a single purchase with no repeatable pattern and no category signal never produces a low_stock insight', async () => {
    await recordPurchases(OWNER, [milkPurchase(0)]);
    await backdateLastPurchase(30); // bought once, a month ago — genuinely unknown, not "low"

    const insight = await getHomeInsight({ ownerEmail: OWNER, recentSearchProducts: [] });
    expect(insight?.kind).not.toBe('low_stock');
  });

  test('an account with no purchase history at all gets no low_stock insight, and does not crash', async () => {
    const insight = await getHomeInsight({ ownerEmail: OWNER, recentSearchProducts: [] });
    expect(insight).toBeNull();
  });
});

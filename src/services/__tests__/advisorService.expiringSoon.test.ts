import AsyncStorage from '@react-native-async-storage/async-storage';
import { getHomeInsight } from '../advisorService';
import { recordExpiration } from '../expirationMemoryService';

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));

const OWNER = 'shopper@example.com';

function isoDaysFromNow(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

describe('advisorService — expiring-soon insight (Feature 2: optional expiration tracking)', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  test('a real, soon-expiring recorded item produces an expiring-soon insight', async () => {
    await recordExpiration(OWNER, 'Whole Milk', isoDaysFromNow(1));

    const insight = await getHomeInsight({ ownerEmail: OWNER, recentSearchProducts: [] });

    expect(insight?.kind).toBe('expiring-soon');
    expect(insight?.title).toContain('Whole Milk');
  });

  test('no recorded expiration at all produces no expiring-soon insight', async () => {
    const insight = await getHomeInsight({ ownerEmail: OWNER, recentSearchProducts: [] });

    expect(insight?.kind).not.toBe('expiring-soon');
  });

  test('a signed-out shopper (empty ownerEmail) never crashes and never fires the insight', async () => {
    await expect(getHomeInsight({ ownerEmail: '', recentSearchProducts: [] })).resolves.not.toThrow;
    const insight = await getHomeInsight({ ownerEmail: '', recentSearchProducts: [] });
    expect(insight?.kind).not.toBe('expiring-soon');
  });
});

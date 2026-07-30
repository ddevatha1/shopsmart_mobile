import AsyncStorage from '@react-native-async-storage/async-storage';
import { recordExpiration, getUpcomingExpirations } from '../expirationMemoryService';

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));

const OWNER = 'shopper@example.com';

function isoDaysFromNow(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

describe('expirationMemoryService', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  test('a recorded expiration within the reminder window is surfaced', async () => {
    await recordExpiration(OWNER, 'Whole Milk', isoDaysFromNow(2));

    const upcoming = await getUpcomingExpirations(OWNER);

    expect(upcoming).toHaveLength(1);
    expect(upcoming[0].displayName).toBe('Whole Milk');
    expect(upcoming[0].daysUntilExpiration).toBe(2);
  });

  test('an expiration further out than the reminder window is not surfaced', async () => {
    await recordExpiration(OWNER, 'Whole Milk', isoDaysFromNow(30));

    const upcoming = await getUpcomingExpirations(OWNER);

    expect(upcoming).toHaveLength(0);
  });

  test('a date already in the past is not surfaced as an upcoming reminder', async () => {
    await recordExpiration(OWNER, 'Whole Milk', isoDaysFromNow(-2));

    const upcoming = await getUpcomingExpirations(OWNER);

    expect(upcoming).toHaveLength(0);
  });

  test('an unparseable raw date is stored without throwing but never produces a reminder (never a guess)', async () => {
    await recordExpiration(OWNER, 'Whole Milk', 'not a real date');

    await expect(getUpcomingExpirations(OWNER)).resolves.toEqual([]);
  });

  test('recording a new date for the same product replaces the old one, not duplicates it', async () => {
    await recordExpiration(OWNER, 'Whole Milk', isoDaysFromNow(2));
    await recordExpiration(OWNER, 'Whole Milk', isoDaysFromNow(1));

    const upcoming = await getUpcomingExpirations(OWNER);

    expect(upcoming).toHaveLength(1);
    expect(upcoming[0].daysUntilExpiration).toBe(1);
  });

  test('expirations are scoped per account', async () => {
    await recordExpiration(OWNER, 'Whole Milk', isoDaysFromNow(1));

    const otherAccount = await getUpcomingExpirations('someone-else@example.com');

    expect(otherAccount).toHaveLength(0);
  });

  test('recording with no signed-in account (empty ownerEmail) is a no-op, never throws', async () => {
    await expect(recordExpiration('', 'Whole Milk', isoDaysFromNow(1))).resolves.toBeUndefined();
    await expect(getUpcomingExpirations('')).resolves.toEqual([]);
  });

  test('a custom reminder window is respected', async () => {
    await recordExpiration(OWNER, 'Bread', isoDaysFromNow(5));

    expect(await getUpcomingExpirations(OWNER, 3)).toHaveLength(0);
    expect(await getUpcomingExpirations(OWNER, 7)).toHaveLength(1);
  });
});

import AsyncStorage from '@react-native-async-storage/async-storage';
import { dismissInsight, getActiveDismissals } from '../dismissalStore';

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));

const OWNER = 'shopper@example.com';

describe('dismissalStore', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  test('a dismissed key is active immediately after dismissal', async () => {
    await dismissInsight(OWNER, 'deal:abc123');
    const active = await getActiveDismissals(OWNER);
    expect(active.has('deal:abc123')).toBe(true);
  });

  test('a dismissal with an already-elapsed cooldown is not active', async () => {
    await dismissInsight(OWNER, 'pantry:milk', -1); // negative cooldown = expired the instant it's written
    const active = await getActiveDismissals(OWNER);
    expect(active.has('pantry:milk')).toBe(false);
  });

  test('dismissals are scoped per account', async () => {
    await dismissInsight(OWNER, 'budget:budget');
    const otherAccount = await getActiveDismissals('someone-else@example.com');
    expect(otherAccount.size).toBe(0);
  });

  test('dismissInsight with no ownerEmail is a safe no-op', async () => {
    await dismissInsight('', 'deal:abc');
    expect((await getActiveDismissals('')).size).toBe(0);
  });
});

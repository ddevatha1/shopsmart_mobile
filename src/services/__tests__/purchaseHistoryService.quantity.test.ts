import AsyncStorage from '@react-native-async-storage/async-storage';
import { getAllRecords } from '../purchaseHistoryService';

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));

const OWNER = 'shopper@example.com';
const STORAGE_KEY = `CartIQ_purchases_${OWNER}`;

describe('purchaseHistoryService — legacy record compatibility', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  test('a record persisted before `quantity` existed loads as quantity 1', async () => {
    const legacyRecord = {
      normalizedName: 'milk', displayName: 'Whole Milk', store: 'Kroger', brand: 'Kroger',
      isOrganic: false, price: 3.5, timestamp: Date.now(),
      // no `quantity` field at all — exactly what's on disk for any
      // account that used the app before this change shipped.
    };
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify([legacyRecord]));

    const records = await getAllRecords(OWNER);
    expect(records).toHaveLength(1);
    expect(records[0].quantity).toBe(1);
  });

  test('a record that already has a real quantity keeps it, not defaulted', async () => {
    const record = {
      normalizedName: 'eggs', displayName: 'Eggs', store: 'Aldi', brand: 'Aldi',
      isOrganic: false, price: 2, timestamp: Date.now(), quantity: 3,
    };
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify([record]));

    const records = await getAllRecords(OWNER);
    expect(records[0].quantity).toBe(3);
  });
});

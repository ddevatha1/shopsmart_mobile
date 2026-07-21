import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ApiProduct, CartItem, StoreName } from '../models/types';
import { normalizeProductName } from './priceHistoryService';
import { isOrganicProduct } from '../utils/filterProducts';

/**
 * A real, on-device purchase log — one entry per product per completed
 * shopping stop, scoped per signed-in account (same pattern as
 * `cartRepository`). "Purchased" is inferred from the Route feature's own
 * pickup checklist: when every item at a stop is checked off, this app's
 * only real signal that something left the store is that the shopper just
 * marked it collected (see RouteScreen's TripLoader, which calls
 * `recordPurchases` on that transition). There's no checkout/receipt
 * integration to do better than that, and this app doesn't fabricate one.
 *
 * Powers pantry reminders (Home) and feeds personalizationService — both
 * read real dates and real product choices, never assumed ones.
 */
const keyFor = (ownerEmail: string) => `shopsmart_purchases_${ownerEmail}`;
const MAX_RECORDS = 500;

export interface PurchaseRecord {
  normalizedName: string;
  displayName: string;
  store: StoreName;
  brand: string;
  isOrganic: boolean;
  price: number;
  timestamp: number;
}

async function loadRecords(ownerEmail: string): Promise<PurchaseRecord[]> {
  const raw = await AsyncStorage.getItem(keyFor(ownerEmail));
  if (!raw) return [];
  try {
    return JSON.parse(raw) as PurchaseRecord[];
  } catch {
    return [];
  }
}

async function saveRecords(ownerEmail: string, records: PurchaseRecord[]): Promise<void> {
  await AsyncStorage.setItem(keyFor(ownerEmail), JSON.stringify(records.slice(-MAX_RECORDS)));
}

export async function recordPurchases(ownerEmail: string, items: CartItem[]): Promise<void> {
  if (!ownerEmail || items.length === 0) return;
  const records = await loadRecords(ownerEmail);
  const now = Date.now();
  for (const item of items) {
    const p = item.product;
    records.push({
      normalizedName: normalizeProductName(p.name),
      displayName: p.name,
      store: p.store,
      brand: p.brand,
      isOrganic: isOrganicProduct(p),
      price: p.price,
      timestamp: now,
    });
  }
  await saveRecords(ownerEmail, records);
}

export interface PantryReminder {
  normalizedName: string;
  displayName: string;
  daysSince: number;
  typicalIntervalDays: number;
}

/**
 * "It's been about N days since you bought X" — but only for products
 * this shopper has genuinely bought at least twice, so the "typical
 * interval" is their own real average, not an assumed default (a
 * single-purchase product simply produces no reminder yet; that's correct
 * behavior, not a missing feature). A reminder stops qualifying the
 * moment the item is bought again, since `daysSince` resets to ~0 —
 * "disappears after repurchase" falls out of the math for free.
 */
export async function getPantryReminders(ownerEmail: string): Promise<PantryReminder[]> {
  if (!ownerEmail) return [];
  const records = await loadRecords(ownerEmail);
  const byProduct = new Map<string, PurchaseRecord[]>();
  for (const r of records) {
    const list = byProduct.get(r.normalizedName) ?? [];
    list.push(r);
    byProduct.set(r.normalizedName, list);
  }

  const now = Date.now();
  const reminders: PantryReminder[] = [];
  for (const [normalizedName, purchases] of byProduct) {
    if (purchases.length < 2) continue;
    const sorted = purchases.slice().sort((a, b) => a.timestamp - b.timestamp);
    const intervals: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
      intervals.push((sorted[i].timestamp - sorted[i - 1].timestamp) / (24 * 60 * 60 * 1000));
    }
    const typicalIntervalDays = intervals.reduce((sum, d) => sum + d, 0) / intervals.length;
    if (typicalIntervalDays < 1) continue; // same-trip duplicate scans, not a real repurchase cadence
    const last = sorted[sorted.length - 1];
    const daysSince = (now - last.timestamp) / (24 * 60 * 60 * 1000);
    if (daysSince >= typicalIntervalDays * 0.9) {
      reminders.push({
        normalizedName,
        displayName: last.displayName,
        daysSince: Math.round(daysSince),
        typicalIntervalDays: Math.round(typicalIntervalDays),
      });
    }
  }

  // Most overdue relative to the shopper's own usual cadence first.
  return reminders.sort((a, b) => b.daysSince / b.typicalIntervalDays - a.daysSince / a.typicalIntervalDays);
}

/** Raw purchase records — used by personalizationService to derive
 * preferred store/brand/organic-affinity signals from real history. */
export async function getAllRecords(ownerEmail: string): Promise<PurchaseRecord[]> {
  return loadRecords(ownerEmail);
}

export function isProductPurchased(product: Pick<ApiProduct, 'name'>, records: PurchaseRecord[]): boolean {
  const key = normalizeProductName(product.name);
  return records.some((r) => r.normalizedName === key);
}

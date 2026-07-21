import type { StoreName } from '../models/types';
import { getAllRecords, type PurchaseRecord } from './purchaseHistoryService';

/**
 * Every "preference" ShopSmart knows about a shopper is counted straight
 * out of their own real purchase history (see purchaseHistoryService) —
 * nothing here is asked for, configured, or assumed. There is no settings
 * screen backing this; it exists purely to bias recommendations (which
 * substitution to suggest first, which store to trust in a close call) a
 * little more toward how this shopper actually shops, and gets more
 * confident as more real history accumulates. A brand-new account gets an
 * all-null profile, which every caller treats as "no opinion" rather than
 * a guess.
 */
export interface PersonalizationProfile {
  preferredStore: StoreName | null;
  organicAffinity: number; // 0–1, fraction of purchases that were organic
  frequentBrands: string[]; // most-purchased brands, most frequent first
  purchaseCount: number;
}

const MIN_PURCHASES_FOR_SIGNAL = 3;

function mostFrequent<T extends string>(values: T[], min: number): T[] {
  const counts = new Map<T, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()]
    .filter(([, count]) => count >= min)
    .sort((a, b) => b[1] - a[1])
    .map(([v]) => v);
}

function buildProfile(records: PurchaseRecord[]): PersonalizationProfile {
  if (records.length < MIN_PURCHASES_FOR_SIGNAL) {
    return { preferredStore: null, organicAffinity: 0, frequentBrands: [], purchaseCount: records.length };
  }
  const stores = mostFrequent(records.map((r) => r.store), 2);
  const brands = mostFrequent(records.map((r) => r.brand).filter(Boolean), 2);
  const organicCount = records.filter((r) => r.isOrganic).length;

  return {
    preferredStore: stores[0] ?? null,
    organicAffinity: organicCount / records.length,
    frequentBrands: brands.slice(0, 5),
    purchaseCount: records.length,
  };
}

// Cheap in absolute terms (records are a small local array) but reused by
// several recommendation computations per screen render — memoized per
// account so re-renders don't repeatedly re-scan the same history.
let cache: { ownerEmail: string; recordCount: number; profile: PersonalizationProfile } | null = null;

export async function getPersonalizationProfile(ownerEmail: string): Promise<PersonalizationProfile> {
  if (!ownerEmail) return buildProfile([]);
  const records = await getAllRecords(ownerEmail);
  if (cache && cache.ownerEmail === ownerEmail && cache.recordCount === records.length) {
    return cache.profile;
  }
  const profile = buildProfile(records);
  cache = { ownerEmail, recordCount: records.length, profile };
  return profile;
}

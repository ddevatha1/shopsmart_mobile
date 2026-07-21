import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ApiProduct, StoreName } from '../models/types';

/**
 * The app's only source of "price history": a running, real, locally
 * recorded log of prices this device has actually seen — one entry per
 * search result, ever. Not global market data (there's no backend
 * database for that), not fabricated — genuinely observed prices,
 * timestamped as they're returned by `/api/search`. A brand-new install
 * has none, and every stat below refuses to render anything until there
 * are enough real observations to say something true (see
 * `MIN_OBSERVATIONS_FOR_STATS`) — that silence *is* the progressive
 * disclosure the feature is supposed to have, not a bug to work around.
 */
const STORAGE_KEY = 'shopsmart_price_history';
const MAX_OBSERVATIONS_PER_PRODUCT = 30;
const MAX_OBSERVATION_AGE_MS = 180 * 24 * 60 * 60 * 1000; // 180 days
const MIN_OBSERVATIONS_FOR_STATS = 2;

export interface PriceObservation {
  price: number;
  timestamp: number;
}

type StoreObservations = Partial<Record<StoreName, PriceObservation[]>>;
type HistoryLog = Record<string, StoreObservations>;

// Words that describe the product but not what it fundamentally is —
// stripped so "Organic Whole Milk, Half Gallon" and "Whole Milk 64 fl oz"
// (same product, different store listing conventions) key to the same
// entry. Deliberately smaller/looser than the backend's search-relevance
// dictionaries (routes/search.ts) — this only needs "close enough to be
// the same shopping-list item," not exact catalog matching.
const NOISE_WORDS = new Set([
  'organic', 'natural', 'fresh', 'the', 'a', 'an', 'of', 'with', 'and', 'grade', 'select',
]);
const UNIT_PATTERN = /\b\d+(\.\d+)?\s*(oz|fl|lb|lbs|pound|pounds|g|gram|grams|kg|ml|l|liter|gal|gallon|qt|pt|ct|count|pk|pack)\b/gi;

/** Normalizes a product name to a stable key so the same real-world item
 * (milk, bananas, ...) matches across size/format variations in a store's
 * own listing text — same purpose as the backend's `dedupSignature`
 * (routes/search.ts), reimplemented locally since price history is a
 * frontend-only, on-device concern with no backend persistence. */
export function normalizeProductName(name: string): string {
  const withoutUnits = name.toLowerCase().replace(UNIT_PATTERN, ' ');
  const words = withoutUnits
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !NOISE_WORDS.has(w) && !/^\d+$/.test(w));
  return [...new Set(words)].sort().join(' ');
}

async function loadLog(): Promise<HistoryLog> {
  const raw = await AsyncStorage.getItem(STORAGE_KEY);
  if (!raw) return {};
  try {
    return JSON.parse(raw) as HistoryLog;
  } catch {
    return {};
  }
}

async function saveLog(log: HistoryLog): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(log));
}

/** Records one observation per product in a fresh search response — call
 * this exactly once per `/api/search` result set (see searchStore.ts).
 * Prunes aggressively (age + count cap) so the log never grows unbounded
 * on a device that searches often. */
export async function recordObservations(products: ApiProduct[]): Promise<void> {
  if (products.length === 0) return;
  const log = await loadLog();
  const now = Date.now();
  const cutoff = now - MAX_OBSERVATION_AGE_MS;

  for (const product of products) {
    const key = normalizeProductName(product.name);
    if (!key) continue;
    const forProduct = log[key] ?? {};
    const forStore = (forProduct[product.store] ?? []).filter((o) => o.timestamp >= cutoff);
    forStore.push({ price: product.price, timestamp: now });
    forProduct[product.store] = forStore.slice(-MAX_OBSERVATIONS_PER_PRODUCT);
    log[key] = forProduct;
  }

  await saveLog(log);
}

export interface PriceStats {
  current: number;
  average: number;
  lowest: number;
  highest: number;
  trend: 'up' | 'down' | 'flat';
  changePercent: number;
  /** Oldest-to-newest observed prices, capped short for a compact
   * sparkline — never more detail than "Price History" on the product
   * page needs. */
  sparkline: number[];
  observationCount: number;
}

/** Real stats from this device's own observation log for `product` at its
 * own store — null when there isn't enough real history yet to say
 * anything meaningful (fewer than two observations), which is the normal,
 * expected state for a product just seen for the first time. */
export async function getStats(product: Pick<ApiProduct, 'name' | 'store' | 'price'>): Promise<PriceStats | null> {
  const log = await loadLog();
  const key = normalizeProductName(product.name);
  const observations = (log[key]?.[product.store] ?? []).slice().sort((a, b) => a.timestamp - b.timestamp);
  if (observations.length < MIN_OBSERVATIONS_FOR_STATS) return null;

  const prices = observations.map((o) => o.price);
  const average = prices.reduce((sum, p) => sum + p, 0) / prices.length;
  const lowest = Math.min(...prices);
  const highest = Math.max(...prices);
  const current = product.price;
  const changePercent = average > 0 ? Math.round(((current - average) / average) * 100) : 0;

  return {
    current,
    average: Math.round(average * 100) / 100,
    lowest,
    highest,
    trend: changePercent <= -3 ? 'down' : changePercent >= 3 ? 'up' : 'flat',
    changePercent,
    sparkline: prices.slice(-10),
    observationCount: observations.length,
  };
}

/** All stores this device has observed prices for the same normalized
 * product at — the real cross-store data `advisorService`'s "worth the
 * extra stop" and `substitutionService` read from. Returns {} rather than
 * guessing when nothing has been observed yet. */
export async function getCrossStoreObservations(productName: string): Promise<StoreObservations> {
  const log = await loadLog();
  return log[normalizeProductName(productName)] ?? {};
}

/** Latest known price for `productName` at `store`, or null if this
 * device has never seen it. Used by advisorService to price out "what
 * would this cart item cost elsewhere" without a network call. */
export async function getLatestPrice(productName: string, store: StoreName): Promise<number | null> {
  const observations = await getCrossStoreObservations(productName);
  const forStore = observations[store];
  if (!forStore || forStore.length === 0) return null;
  return forStore[forStore.length - 1].price;
}

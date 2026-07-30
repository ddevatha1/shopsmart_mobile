import { getAllRecords, type PurchaseRecord } from './purchaseHistoryService';

/**
 * Deterministic pantry-inventory estimation from real, on-device purchase
 * history only — no "My Fridge" screen, no pretending to know exact
 * inventory, never an AI guess. This is deliberately a *foundation*: it
 * answers "does this shopper's own buying pattern suggest they're
 * probably running low," with an honest confidence level attached, not
 * "here is your exact remaining inventory." A product this shopper has
 * never bought (or bought only once, with nothing else to go on) simply
 * comes back `unknown` — never a fabricated "you are out."
 */

export type InventoryStatus = 'likely_available' | 'likely_low' | 'unknown';
export type InventoryConfidence = 'high' | 'medium' | 'low';

export interface InventoryEstimate {
  /** The purchase-history identity this estimate is about — a
   * `normalizedName` (see purchaseHistoryService.ts), the same stable,
   * on-device identity every other purchase-history consumer already
   * keys by. Deliberately NOT `ApiProduct.id`: that id comes from a live
   * search/scrape result and isn't stable across searches, so it can't
   * serve as a durable "this is the same product over time" identity the
   * way a persisted purchase-history key can. */
  productId: string;
  /** Present only when at least one purchase in this estimate's group had
   * one (see PurchaseRecord.canonicalId) — the group's most recent
   * purchase's canonicalId, when available. */
  canonicalId?: string;
  displayName: string;
  estimatedStatus: InventoryStatus;
  confidence: InventoryConfidence;
  /** A short, factual explanation of the real numbers behind the
   * estimate — never a generated sentence, always built from real
   * purchase timestamps/quantities/counts. */
  reason: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
// Matches purchaseHistoryService's own pantry-reminder threshold — filters
// out same-trip duplicate scans, which aren't a real repurchase interval.
const MIN_REAL_INTERVAL_DAYS = 1;
// A purchase counts as "possibly due" once we're at least this fraction of
// the way through the typical interval — same ratio purchaseHistoryService
// already uses for pantry reminders, reused here rather than inventing a
// second threshold for what is conceptually the same judgment call.
const LOW_STOCK_RATIO = 0.9;

// A small, closed-class, hand-curated fallback — the same kind of
// dictionary as cartSuggestionService.ts's PAIRINGS, not a learned model.
// Used ONLY when a product has been bought exactly once and there's no
// real interval yet, to give a conservative first estimate for well-known
// fast-turnover grocery categories. Deliberately short and conservative:
// a category NOT in this list simply stays `unknown` rather than guessing.
const CATEGORY_DEFAULT_INTERVAL_DAYS: Record<string, number> = {
  dairy: 7,
  produce: 5,
  bakery: 5,
  meat: 7,
};

function computeTypicalIntervalDays(sortedByTime: PurchaseRecord[]): number | null {
  if (sortedByTime.length < 2) return null;
  const intervals: number[] = [];
  for (let i = 1; i < sortedByTime.length; i++) {
    const days = (sortedByTime[i].timestamp - sortedByTime[i - 1].timestamp) / DAY_MS;
    if (days >= MIN_REAL_INTERVAL_DAYS) intervals.push(days);
  }
  if (intervals.length === 0) return null;
  return intervals.reduce((sum, d) => sum + d, 0) / intervals.length;
}

/**
 * The pure, synchronous core: given one product's purchase records (0, 1,
 * or many — already grouped by whatever identity the caller chose, see
 * `estimateAllInventory`), decide a status/confidence/reason. Never
 * throws, never fabricates a number it doesn't have.
 */
export function estimateInventoryStatus(
  records: PurchaseRecord[],
  now: Date = new Date(),
): { estimatedStatus: InventoryStatus; confidence: InventoryConfidence; reason: string } {
  if (records.length === 0) {
    return { estimatedStatus: 'unknown', confidence: 'low', reason: 'No purchase history for this product yet.' };
  }

  const sorted = records.slice().sort((a, b) => a.timestamp - b.timestamp);
  const last = sorted[sorted.length - 1];
  const daysSince = (now.getTime() - last.timestamp) / DAY_MS;

  const realIntervalDays = computeTypicalIntervalDays(sorted);
  let typicalIntervalDays = realIntervalDays;
  let usedCategoryDefault = false;
  if (typicalIntervalDays == null && sorted.length === 1 && last.category && CATEGORY_DEFAULT_INTERVAL_DAYS[last.category] != null) {
    typicalIntervalDays = CATEGORY_DEFAULT_INTERVAL_DAYS[last.category];
    usedCategoryDefault = true;
  }

  if (typicalIntervalDays == null) {
    return {
      estimatedStatus: 'unknown',
      confidence: 'low',
      reason: sorted.length === 1
        ? 'Only bought once so far — not enough pattern yet to estimate.'
        : 'No repeatable purchase pattern found yet.',
    };
  }

  // A real, logged quantity plausibly stretches how long a purchase
  // lasts — a conservative multiplier off the shopper's own recorded
  // number, never a fabricated "servings per unit" estimate. Buying 2 at
  // once roughly doubles the assumed depletion window.
  const quantity = last.quantity && last.quantity > 0 ? last.quantity : 1;
  const adjustedIntervalDays = typicalIntervalDays * quantity;
  const ratio = daysSince / adjustedIntervalDays;

  let confidence: InventoryConfidence;
  if (realIntervalDays != null && sorted.length >= 3) confidence = 'high';
  else if (realIntervalDays != null && sorted.length === 2) confidence = 'medium';
  else if (usedCategoryDefault) confidence = 'medium';
  else confidence = 'low';

  if (ratio >= LOW_STOCK_RATIO) {
    return {
      estimatedStatus: 'likely_low',
      confidence,
      reason: `Last bought ${Math.round(daysSince)} day(s) ago${quantity > 1 ? ` (${quantity} at once)` : ''} — your typical cycle is about ${Math.round(adjustedIntervalDays)} day(s).`,
    };
  }

  return {
    estimatedStatus: 'likely_available',
    confidence,
    reason: `Bought ${Math.round(daysSince)} day(s) ago${quantity > 1 ? ` (${quantity} at once)` : ''}, within your typical ~${Math.round(adjustedIntervalDays)}-day cycle.`,
  };
}

function groupKey(record: PurchaseRecord): string {
  // Prefer canonicalId when available so brand/variant name differences
  // that describe the exact same underlying product (e.g. "Organic Whole
  // Milk" vs "365 Whole Milk", both canonicalId "whole-milk") count as one
  // repurchase pattern instead of two thin, independent ones. Falls back
  // to normalizedName — the identity every other purchase-history
  // consumer already uses — when no canonicalId was captured.
  return record.canonicalId ? `canonical:${record.canonicalId}` : `name:${record.normalizedName}`;
}

/**
 * The real-world entry point: loads this shopper's actual purchase
 * history, groups it (canonicalId-aware, see `groupKey`), and estimates
 * each group's current status. Existing users with no history at all
 * simply get an empty array back — never an error, never a fabricated
 * "everything is fine" placeholder.
 */
export async function estimateAllInventory(ownerEmail: string, now: Date = new Date()): Promise<InventoryEstimate[]> {
  if (!ownerEmail) return [];
  const records = await getAllRecords(ownerEmail);
  if (records.length === 0) return [];

  const groups = new Map<string, PurchaseRecord[]>();
  for (const record of records) {
    const key = groupKey(record);
    const list = groups.get(key) ?? [];
    list.push(record);
    groups.set(key, list);
  }

  const estimates: InventoryEstimate[] = [];
  for (const groupRecords of groups.values()) {
    const sorted = groupRecords.slice().sort((a, b) => a.timestamp - b.timestamp);
    const last = sorted[sorted.length - 1];
    const { estimatedStatus, confidence, reason } = estimateInventoryStatus(groupRecords, now);
    estimates.push({
      productId: last.normalizedName,
      canonicalId: last.canonicalId,
      displayName: last.displayName,
      estimatedStatus,
      confidence,
      reason,
    });
  }
  return estimates;
}

/**
 * Homepage/Meal Planner shared helper — the exact real, on-device pantry
 * signal `assistantDispatcher.ts`'s `getLowStockItems` dependency already
 * computes (filter to `'likely_low'`, most-likely-low first, capped),
 * pulled out so a second real caller (`MealPlannerScreen.tsx`) reuses the
 * identical selection instead of re-deriving its own. Never a guess —
 * `estimateAllInventory` remains the only source of truth this reads
 * from, unchanged.
 */
export async function getLikelyLowStockDisplayNames(ownerEmail: string, max = 3): Promise<string[]> {
  if (!ownerEmail) return [];
  const estimates = await estimateAllInventory(ownerEmail);
  return estimates
    .filter((e) => e.estimatedStatus === 'likely_low')
    .slice(0, max)
    .map((e) => e.displayName);
}

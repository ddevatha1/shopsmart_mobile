import { estimateAllInventory } from './inventoryEstimationService';
import { getAllRecords, type PurchaseRecord } from './purchaseHistoryService';
import { getPreferences } from './shopperPreferenceService';
import { dismissInsight, getActiveDismissals } from './dismissalStore';
import { searchRepository } from '../repositories/searchRepository';
import { useUserStore } from '../store/userStore';
import type { AssistantSuggestion, SearchResponse, SuggestionPriority } from '../models/types';

/**
 * Purchase Intelligence Bridge (Phase 5.2 Part 3, extended Phase 5.3
 * Part 3) — connects the assistant to Phase 2.5's existing, unmodified
 * intelligence (inventoryEstimationService.ts / purchaseHistoryService.ts)
 * and Phase 5.2's own preference memory. This file computes NOTHING new
 * on its own: every suggestion's `reason` is either a real, already-
 * generated explanation string from `estimateAllInventory` (never
 * rewritten here), a plain count pulled directly from real records, or a
 * real historical-vs-current PRICE comparison (see `buildPriceComparisonTips`
 * — a real search call, the SAME `searchRepository` every other
 * read-only intent already uses, never a second pricing engine). Read-
 * only end to end — this module has no cart/session dependency at all,
 * and nothing here ever calls a mutation function.
 *
 * **vs. `advisorService.ts` (reviewed again, Phase 6 Part 3; first
 * reviewed Phase 5.5 — kept separate both times).** This file returns
 * the FULL, ranked list of every real suggestion that clears its bar —
 * always in response to an explicit ask (see assistantDispatcher.ts's
 * `dispatchStartShoppingSession` restock branch) — scoped to purchase-
 * pattern data only (restock/frequent-purchase/budget). `advisorService.ts`
 * instead picks at most ONE insight per screen (Home/Cart/Compare) from a
 * wider candidate pool (deals, budget, drive-time tradeoffs, occasions,
 * plus the same purchase-pattern signals) to show ambiently, unasked —
 * which is why IT has a dismissal-cooldown mechanism and this file
 * doesn't need one (a shopper who asked "what should I buy?" wants the
 * real list, not a filtered version of it). See that file's own header
 * comment for the mirror of this note.
 */

const MIN_FREQUENT_PURCHASE_COUNT = 3;
const MAX_SUGGESTIONS_PER_TYPE = 5;
const MAX_PRICE_COMPARISON_LOOKUPS = 3; // capped — each one is a real network search call

/** A fixed mapping from suggestion type to urgency — never computed,
 * never inferred from anything about the specific item. */
const PRIORITY_BY_TYPE: Record<AssistantSuggestion['type'], SuggestionPriority> = {
  restock: 'urgent',
  frequent_purchase: 'helpful',
  budget_tip: 'optional',
};
const PRIORITY_RANK: Record<SuggestionPriority, number> = { urgent: 0, helpful: 1, optional: 2 };

function suggestionKey(type: AssistantSuggestion['type'], itemName: string): string {
  return `assistant-suggestion:${type}:${itemName.toLowerCase()}`;
}

export interface SuggestionDependencies {
  search: (query: string, zipcode: string) => Promise<SearchResponse>;
  getZipcode: () => string;
}

const defaultDependencies: SuggestionDependencies = {
  search: (query, zipcode) => searchRepository.search(query, zipcode),
  getZipcode: () => useUserStore.getState().user?.zipcode ?? '',
};

/**
 * Real historical-vs-current price comparisons only (Phase 5.3 Part 3).
 * For a capped, small set of real, recently-purchased items, this
 * compares the shopper's own last recorded price against a REAL current
 * search result — a `budget_tip` is only ever produced when BOTH a real
 * historical price AND a real, cheaper, direct-match current product
 * exist. No zipcode, no search results, or no cheaper match all
 * correctly produce nothing — never "milk is usually expensive" with no
 * evidence.
 */
async function buildPriceComparisonTips(
  candidates: { normalizedName: string; displayName: string; lastPrice: number }[],
  deps: SuggestionDependencies,
): Promise<AssistantSuggestion[]> {
  const zipcode = deps.getZipcode();
  if (!zipcode) return [];

  const tips: AssistantSuggestion[] = [];
  for (const candidate of candidates.slice(0, MAX_PRICE_COMPARISON_LOOKUPS)) {
    let response: SearchResponse;
    try {
      response = await deps.search(candidate.displayName, zipcode);
    } catch {
      continue; // a failed lookup never becomes a fabricated tip
    }
    const cheaper = response.products
      .filter((p) => p.matchType !== 'related' && p.price < candidate.lastPrice)
      .sort((a, b) => a.price - b.price)[0];
    if (!cheaper) continue;

    tips.push({
      type: 'budget_tip',
      itemName: candidate.displayName,
      reason: `Your last ${candidate.displayName} purchase was $${candidate.lastPrice.toFixed(2)}. Current plans include a cheaper equivalent at $${cheaper.price.toFixed(2)}.`,
      priority: PRIORITY_BY_TYPE.budget_tip,
    });
  }
  return tips;
}

/**
 * Real, data-backed suggestions only — see this file's header comment.
 * `'restock'` requires BOTH a real `'likely_low'` estimate AND a
 * confidence above `'low'` (a low-confidence estimate produces no
 * suggestion at all — this app's own existing "low confidence, no
 * assertion" rule, reused rather than loosened). `'frequent_purchase'`
 * requires real repeat purchases (>= 3), and never duplicates an item
 * already surfaced as a restock candidate. `'budget_tip'` fires from
 * TWO independent, real signals — a stored `defaultBudgetTarget` (Phase
 * 5.2), and a real price-comparison (Phase 5.3, see
 * `buildPriceComparisonTips`) — never a guessed number either way.
 * Dismissed suggestions (see dismissalStore.ts, the same mechanism
 * AdvisorCard already uses) are filtered out so an "Ignore" tap sticks
 * for this session's own cooldown window. The final list is sorted by
 * `priority` (urgent first) — a fixed, type-based ordering, never a
 * per-item judgment call.
 */
export async function getShoppingSuggestions(ownerEmail: string, deps: SuggestionDependencies = defaultDependencies): Promise<AssistantSuggestion[]> {
  if (!ownerEmail) return [];

  const [estimates, records, preferences, activeDismissals] = await Promise.all([
    estimateAllInventory(ownerEmail),
    getAllRecords(ownerEmail),
    getPreferences(ownerEmail),
    getActiveDismissals(ownerEmail),
  ]);

  const restock: AssistantSuggestion[] = [];
  const restockKeys = new Set<string>();
  for (const estimate of estimates) {
    if (estimate.estimatedStatus !== 'likely_low' || estimate.confidence === 'low') continue;
    restock.push({ type: 'restock', itemName: estimate.displayName, reason: estimate.reason, priority: PRIORITY_BY_TYPE.restock });
    restockKeys.add(estimate.productId);
  }

  const byName = new Map<string, PurchaseRecord[]>();
  for (const record of records) {
    const list = byName.get(record.normalizedName) ?? [];
    list.push(record);
    byName.set(record.normalizedName, list);
  }

  const frequent: AssistantSuggestion[] = [];
  const priceComparisonCandidates: { normalizedName: string; displayName: string; lastPrice: number }[] = [];
  for (const [normalizedName, purchases] of byName) {
    const mostRecent = purchases.slice().sort((a, b) => b.timestamp - a.timestamp)[0];
    if (purchases.length >= MIN_FREQUENT_PURCHASE_COUNT && !restockKeys.has(normalizedName)) {
      frequent.push({
        type: 'frequent_purchase',
        itemName: mostRecent.displayName,
        reason: `You've bought ${mostRecent.displayName} ${purchases.length} times recently.`,
        priority: PRIORITY_BY_TYPE.frequent_purchase,
      });
    }
    // A real historical price exists for every recorded purchase — a
    // candidate for the price-comparison tip regardless of frequency,
    // capped below to a small number of real lookups.
    priceComparisonCandidates.push({ normalizedName, displayName: mostRecent.displayName, lastPrice: mostRecent.price });
  }

  const priceTips = await buildPriceComparisonTips(priceComparisonCandidates, deps);

  const suggestions: AssistantSuggestion[] = [
    ...restock.slice(0, MAX_SUGGESTIONS_PER_TYPE),
    ...frequent.slice(0, MAX_SUGGESTIONS_PER_TYPE),
    ...priceTips,
  ];

  if (preferences.defaultBudgetTarget != null) {
    suggestions.push({
      type: 'budget_tip',
      itemName: 'Grocery budget',
      reason: `Your grocery budget is set to $${preferences.defaultBudgetTarget.toFixed(2)}.`,
      priority: PRIORITY_BY_TYPE.budget_tip,
    });
  }

  return suggestions
    .filter((s) => !activeDismissals.has(suggestionKey(s.type, s.itemName)))
    .sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]);
}

/** "Ignore" — a real, remembered dismissal (same mechanism/cooldown as
 * AdvisorCard's own dismiss button), never just a client-side hide that
 * reappears on the next request. */
export async function dismissSuggestion(ownerEmail: string, suggestion: Pick<AssistantSuggestion, 'type' | 'itemName'>): Promise<void> {
  if (!ownerEmail) return;
  await dismissInsight(ownerEmail, suggestionKey(suggestion.type, suggestion.itemName));
}

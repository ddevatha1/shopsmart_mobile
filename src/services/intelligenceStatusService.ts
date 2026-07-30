import { getPreferences } from './shopperPreferenceService';
import { getSessionHistory } from './assistantShoppingSessionStore';
import { getHistoricalSavingsAverage } from './shoppingHistoryInsightService';

/**
 * "Intelligence Available" Indicator (Phase 6 Part 4) — a pure
 * composition over three already-real, already-computed sources
 * (`shopperPreferenceService`, `assistantShoppingSessionStore`,
 * `shoppingHistoryInsightService`), never a new signal of its own. Each
 * field is a plain boolean existence check — "does at least one real
 * fact of this kind exist for this shopper" — never a count, a guess, or
 * an inferred trait. A brand-new or signed-out account gets all three
 * `false`, which the UI (see components/assistant/IntelligenceStatusCard.tsx)
 * renders as nothing at all, not an empty checklist.
 */
export interface IntelligenceSignals {
  /** A real, explicitly-stated preferred store exists (see
   * shopperPreferenceService.ts — never inferred from search/purchase
   * behavior). */
  preferredStores: boolean;
  /** At least one real, completed shopping session exists (see
   * assistantShoppingSessionStore.ts's `getSessionHistory`). */
  shoppingHistory: boolean;
  /** At least one completed session recorded a real `estimatedSavings`
   * figure, i.e. there's a real average to ever compare a future trip
   * against (see shoppingHistoryInsightService.ts's
   * `getHistoricalSavingsAverage` — the exact same gate the "Magic
   * Moment" banner already uses). */
  savingsPatterns: boolean;
}

export async function getIntelligenceSignals(ownerEmail: string): Promise<IntelligenceSignals> {
  if (!ownerEmail) return { preferredStores: false, shoppingHistory: false, savingsPatterns: false };

  const [preferences, history] = await Promise.all([
    getPreferences(ownerEmail),
    getSessionHistory(ownerEmail),
  ]);

  return {
    preferredStores: (preferences.preferredStores?.length ?? 0) > 0,
    shoppingHistory: history.length > 0,
    savingsPatterns: getHistoricalSavingsAverage(history) != null,
  };
}

/** Whether the indicator card should render at all — false when every
 * signal is false (a brand-new or signed-out account), which is the
 * correct, honest "nothing learned yet" state, not an error. */
export function hasAnyIntelligenceSignal(signals: IntelligenceSignals): boolean {
  return signals.preferredStores || signals.shoppingHistory || signals.savingsPatterns;
}

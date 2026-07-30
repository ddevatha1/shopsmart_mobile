/**
 * Homepage Intelligence Priority Layer (Phase 6.1 Part 1) — a pure,
 * presentation-only decision over content that ALREADY exists and is
 * ALREADY independently evidence-gated by its own real source:
 *   - `HomeInsightsStrip` (assistantSuggestionService + shoppingHistoryInsightService)
 *   - `PantryCheckInCard` (purchaseHistoryService's `getPantryReminders`)
 *   - `AdvisorCard` (advisorService's `getHomeInsight`)
 *   - the Assistant-discovery `ContextualHint`
 *
 * This file computes NOTHING about whether a shopper's data is
 * meaningful — every one of the four surfaces above already decided
 * that for itself, correctly, before this layer ever runs. All this
 * file decides is which ONE of the four already-real "I have something
 * to say" signals actually gets screen space, so a shopper never sees
 * four independently-correct cards stack into one cluttered homepage
 * (see docs/competition_readiness_review.md §3's own finding). No
 * service this file reads from is modified, and `advisorService.ts`/
 * `assistantSuggestionService.ts` are not merged — see that same
 * review's Part 3, reconfirmed here.
 *
 * Fixed priority order, and why:
 *   1. `HomeInsightsStrip` — carries BOTH a real comparative savings
 *      chip ("Saved $X last trip") and real purchase-pattern suggestion
 *      chips in one surface; it is deliberately this app's flagship
 *      homepage signal (Phase 5.5/6), so it always wins when it has
 *      anything real to show.
 *   2. `PantryCheckInCard` — a real, dated pantry reminder is the next
 *      most actionable thing to lead with.
 *   3. `AdvisorCard` — the general single-best-insight fallback (deals,
 *      budget standing, drive-time tradeoffs, occasions) when neither
 *      of the above has anything.
 *   4. The Assistant-discovery hint — shown ONLY when none of the
 *      above have real content, i.e. exactly the shopper who has no
 *      other on-screen proof the assistant/intelligence layer works yet.
 */

export type HomeIntelligenceSurface = 'insights_strip' | 'pantry_check_in' | 'advisor' | 'assistant_hint';

export interface HomeIntelligenceAvailability {
  insightsStripHasContent: boolean;
  pantryHasContent: boolean;
  advisorHasContent: boolean;
}

export function selectHomeIntelligenceSurface(availability: HomeIntelligenceAvailability): HomeIntelligenceSurface {
  if (availability.insightsStripHasContent) return 'insights_strip';
  if (availability.pantryHasContent) return 'pantry_check_in';
  if (availability.advisorHasContent) return 'advisor';
  return 'assistant_hint';
}

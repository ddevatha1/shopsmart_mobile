import type { ShoppingSessionHistory } from '../models/intent';

/**
 * Comparative Session-History Insight (Phase 5.5 §4/§8) — a small, pure
 * aggregation over `ShoppingSessionHistory` (see
 * assistantShoppingSessionStore.ts's `getSessionHistory`, this file's
 * only real data source). No network calls, no storage of its own, no
 * new signal: every number here is already sitting in a real, previously
 * completed `AssistantShoppingSession`. Used by both the homepage
 * insights strip (Part 1 — "Saved $14.50 last trip") and the "Magic
 * Moment" comparison (Part 3 — "This trip saves $18.40, N% more than your
 * usual $12 average") so there is exactly one place that turns session
 * history into a savings claim.
 */

export interface HistoricalSavingsAverage {
  averageSavings: number;
  /** How many real, saved sessions had a real `estimatedSavings` figure
   * — always >= 1 whenever this type is returned at all. */
  sessionCount: number;
}

/** Only counts sessions with a real `estimatedSavings` value — a session
 * that never recorded one (e.g. no store assignments) is skipped, never
 * treated as a zero. Returns `undefined` when there isn't at least one
 * real data point, so a caller never divides by zero or shows an average
 * of nothing. */
export function getHistoricalSavingsAverage(history: ShoppingSessionHistory[]): HistoricalSavingsAverage | undefined {
  const withSavings = history.filter((s): s is ShoppingSessionHistory & { estimatedSavings: number } => s.estimatedSavings != null);
  if (withSavings.length === 0) return undefined;
  const total = withSavings.reduce((sum, s) => sum + s.estimatedSavings, 0);
  return { averageSavings: total / withSavings.length, sessionCount: withSavings.length };
}

/** The most recent real session with a real `estimatedSavings` figure —
 * `history` is already most-recent-first (see `getSessionHistory`), so
 * this is simply the first match. Powers the homepage strip's one-line
 * "Saved $X last trip" chip; `undefined` for a new/signed-out account or
 * one whose sessions never recorded a savings figure. */
export function getMostRecentSessionSavings(history: ShoppingSessionHistory[]): number | undefined {
  return history.find((s) => s.estimatedSavings != null)?.estimatedSavings;
}

export interface SessionSavingsComparison {
  currentSavings: number;
  averageSavings: number;
  sessionCount: number;
  /** Percent better than the average, rounded to the nearest whole
   * number — only present when `averageSavings > 0`; omitted otherwise
   * so nothing divides by zero into a fabricated percentage. */
  percentBetter?: number;
}

/**
 * Compares a just-completed session's real savings against the real
 * average of the shopper's own PRIOR sessions only — `priorHistory` must
 * be fetched BEFORE the current session is persisted (see
 * assistantDispatcher.ts's `dispatchStartShoppingSession`), otherwise the
 * "previous" average would include the very session being compared.
 * Returns `undefined` whenever there's no real current savings figure or
 * no real prior data — this is the one gate that guarantees "Never say
 * 'You improved' unless a real previous comparison exists."
 */
export function compareSessionToHistory(
  currentSavings: number | undefined,
  priorHistory: ShoppingSessionHistory[],
): SessionSavingsComparison | undefined {
  if (currentSavings == null) return undefined;
  const avg = getHistoricalSavingsAverage(priorHistory);
  if (!avg) return undefined;
  const percentBetter = avg.averageSavings > 0
    ? Math.round(((currentSavings - avg.averageSavings) / avg.averageSavings) * 100)
    : undefined;
  return {
    currentSavings,
    averageSavings: avg.averageSavings,
    sessionCount: avg.sessionCount,
    ...(percentBetter != null ? { percentBetter } : {}),
  };
}

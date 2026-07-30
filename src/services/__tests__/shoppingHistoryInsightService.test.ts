import {
  compareSessionToHistory,
  getHistoricalSavingsAverage,
  getMostRecentSessionSavings,
} from '../shoppingHistoryInsightService';
import type { ShoppingSessionHistory } from '../../models/intent';

function makeHistory(overrides: Partial<ShoppingSessionHistory> = {}): ShoppingSessionHistory {
  return { id: 's1', createdAt: Date.now(), goal: 'save_money', itemCount: 5, ...overrides };
}

describe('getHistoricalSavingsAverage', () => {
  test('returns undefined for empty history — no fabricated average of nothing', () => {
    expect(getHistoricalSavingsAverage([])).toBeUndefined();
  });

  test('returns undefined when no session recorded a real estimatedSavings', () => {
    const history = [makeHistory({ estimatedSavings: undefined }), makeHistory({ estimatedSavings: undefined })];
    expect(getHistoricalSavingsAverage(history)).toBeUndefined();
  });

  test('averages only sessions with a real estimatedSavings, skipping ones without', () => {
    const history = [
      makeHistory({ id: 'a', estimatedSavings: 10 }),
      makeHistory({ id: 'b', estimatedSavings: undefined }),
      makeHistory({ id: 'c', estimatedSavings: 20 }),
    ];
    expect(getHistoricalSavingsAverage(history)).toEqual({ averageSavings: 15, sessionCount: 2 });
  });
});

describe('getMostRecentSessionSavings', () => {
  test('returns undefined for a shopper with no history', () => {
    expect(getMostRecentSessionSavings([])).toBeUndefined();
  });

  test('returns the first entry with a real estimatedSavings — history is already most-recent-first', () => {
    const history = [
      makeHistory({ id: 'newest', estimatedSavings: undefined }),
      makeHistory({ id: 'next', estimatedSavings: 14.5 }),
      makeHistory({ id: 'oldest', estimatedSavings: 9 }),
    ];
    expect(getMostRecentSessionSavings(history)).toBe(14.5);
  });
});

describe('compareSessionToHistory', () => {
  test('returns undefined when the current session has no real savings figure', () => {
    expect(compareSessionToHistory(undefined, [makeHistory({ estimatedSavings: 10 })])).toBeUndefined();
  });

  test('returns undefined when there is no real prior history — never a fabricated "you improved" claim', () => {
    expect(compareSessionToHistory(18.4, [])).toBeUndefined();
  });

  test('returns undefined when prior sessions exist but none recorded a real estimatedSavings', () => {
    expect(compareSessionToHistory(18.4, [makeHistory({ estimatedSavings: undefined })])).toBeUndefined();
  });

  test('computes a real comparison against the real prior average, including percentBetter', () => {
    const priorHistory = [makeHistory({ id: 'a', estimatedSavings: 12 }), makeHistory({ id: 'b', estimatedSavings: 8 })];
    const result = compareSessionToHistory(18.4, priorHistory);
    expect(result).toEqual({ currentSavings: 18.4, averageSavings: 10, sessionCount: 2, percentBetter: 84 });
  });

  test('omits percentBetter rather than dividing by zero when the average is exactly 0', () => {
    const priorHistory = [makeHistory({ estimatedSavings: 0 })];
    const result = compareSessionToHistory(5, priorHistory);
    expect(result).toEqual({ currentSavings: 5, averageSavings: 0, sessionCount: 1 });
    expect(result?.percentBetter).toBeUndefined();
  });
});

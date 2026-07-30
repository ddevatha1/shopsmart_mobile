// Run with: npm test
//
// Tests computeBudgetAnalysis/isValidBudgetTarget — pure, synchronous,
// deterministic, no network (same convention as
// nutritionScoringService.test.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeBudgetAnalysis, isValidBudgetTarget } from './budgetAnalysisService.ts';

test('under budget: positive difference, status "under"', () => {
  const result = computeBudgetAnalysis(82, 100);
  assert.equal(result.target, 100);
  assert.equal(result.actual, 82);
  assert.equal(result.difference, 18);
  assert.equal(result.status, 'under');
});

test('exact budget: zero difference, status "at_target"', () => {
  const result = computeBudgetAnalysis(100, 100);
  assert.equal(result.difference, 0);
  assert.equal(result.status, 'at_target');
});

test('over budget: negative difference, status "over"', () => {
  const result = computeBudgetAnalysis(120, 100);
  assert.equal(result.difference, -20);
  assert.equal(result.status, 'over');
});

test('isValidBudgetTarget accepts only positive, finite numbers', () => {
  assert.equal(isValidBudgetTarget(100), true);
  assert.equal(isValidBudgetTarget(0.01), true);
});

test('isValidBudgetTarget rejects zero, negative, NaN, Infinity, and non-numbers, never throwing', () => {
  for (const invalid of [0, -50, NaN, Infinity, -Infinity, undefined, null, 'ARM' as any, {} as any]) {
    assert.equal(isValidBudgetTarget(invalid), false, `expected ${String(invalid)} to be invalid`);
  }
});

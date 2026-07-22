// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { correctQuery } from './queryCorrection.ts';

const REQUIRED_CASES: Array<[string, string]> = [
  ['orange juive', 'orange juice'],
  ['bananna', 'banana'],
  ['chkien breast', 'chicken breast'],
  ['almond mik', 'almond milk'],
  ['stawberries', 'strawberries'],
  ['peperoni', 'pepperoni'],
  ['yoghrt', 'yogurt'],
];

for (const [typo, expected] of REQUIRED_CASES) {
  test(`correctQuery("${typo}") suggests "${expected}" with high confidence`, () => {
    const result = correctQuery(typo);
    assert.equal(result.corrected, expected);
    assert.equal(result.level, 'high');
    assert.ok(result.confidence >= 0.75, `expected confidence >= 0.75, got ${result.confidence}`);
  });
}

test('an already-correct query is never "corrected"', () => {
  const result = correctQuery('orange juice');
  assert.equal(result.level, 'none');
  assert.equal(result.corrected, 'orange juice');
});

test('never silently replaces a query with a completely different meaning', () => {
  // "milk" and "cream" are both valid vocabulary words on their own — one
  // must never be "corrected" into the other just because they're both
  // dairy words of similar length.
  const result = correctQuery('cream');
  assert.equal(result.level, 'none');
  assert.equal(result.corrected, 'cream');
});

test('normalizes whitespace, punctuation, and casing before correction', () => {
  const result = correctQuery('  Orange   JUIVE!!  ');
  assert.equal(result.corrected, 'orange juice');
  assert.equal(result.level, 'high');
});

test('logs are traceable even when no correction is needed', () => {
  const result = correctQuery('bananas');
  assert.equal(result.level, 'none');
  assert.equal(result.method, 'none-needed');
});

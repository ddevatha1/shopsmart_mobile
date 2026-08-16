// Run with: npm test
//
// Tests raceAgainstResponseBudget's own orchestration in isolation — no
// real store scraper/network involved, just plain promises that resolve/
// reject/hang on a controlled schedule (same "inject a fake, no framework"
// convention as searchServiceNutritionEnrichment.test.ts). Covers the
// actual production bug this fixes: `Promise.allSettled` alone waits for
// the SLOWEST branch, so one store still running past a shared response
// budget must be reported as 'pending' instead of holding up every other,
// already-finished store's real result.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { raceAgainstResponseBudget } from './searchService.ts';

function delay<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

test('raceAgainstResponseBudget resolves fulfilled when the store finishes within budget', async () => {
  const outcome = await raceAgainstResponseBudget('Kroger', delay(5, ['product']), 50);
  assert.deepEqual(outcome, { status: 'fulfilled', value: ['product'] });
});

test('raceAgainstResponseBudget resolves rejected when the store fails within budget', async () => {
  const failing = Promise.reject(new Error('boom'));
  const outcome = await raceAgainstResponseBudget('Aldi', failing, 50);
  assert.equal(outcome.status, 'rejected');
  assert.equal((outcome as { status: 'rejected'; reason: unknown }).reason instanceof Error, true);
});

test('raceAgainstResponseBudget resolves pending — not fulfilled/rejected — once the budget elapses, without the slow store ever settling', async () => {
  // Never resolves within this test's lifetime — stands in for a store
  // that's still genuinely in flight (a real network hang) when the
  // shared response budget runs out.
  const neverSettles = new Promise<string[]>(() => {});
  const outcome = await raceAgainstResponseBudget('Trader Joe\'s', neverSettles, 20);
  assert.deepEqual(outcome, { status: 'pending' });
});

test('raceAgainstResponseBudget lets a slow-but-not-hung store keep running after reporting pending — the underlying promise still settles on its own', async () => {
  let settledLate = false;
  const slow = delay(30, ['late-product']).then((value) => {
    settledLate = true;
    return value;
  });
  const outcome = await raceAgainstResponseBudget('Publix', slow, 10);
  assert.deepEqual(outcome, { status: 'pending' });
  assert.equal(settledLate, false); // hasn't had time yet — budget (10ms) < store's own delay (30ms)
  await delay(30, undefined); // let the underlying promise actually finish
  assert.equal(settledLate, true); // it was never cancelled — just too late for the response that already went out
});

test('a fast store is unaffected by a slow sibling racing the same budget', async () => {
  const [fast, slow] = await Promise.all([
    raceAgainstResponseBudget('Sprouts', delay(1, ['milk']), 20),
    raceAgainstResponseBudget('Whole Foods Market', new Promise<string[]>(() => {}), 20),
  ]);
  assert.deepEqual(fast, { status: 'fulfilled', value: ['milk'] });
  assert.deepEqual(slow, { status: 'pending' });
});

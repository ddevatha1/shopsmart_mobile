// Run with: npm test
//
// Tests raceAgainstResponseBudget's own orchestration in isolation — no
// real store scraper/network involved, just plain promises that resolve/
// reject/hang on a controlled schedule (same "inject a fake, no framework"
// convention as this file's neighboring tests). Covers the actual
// production bug this fixes: `Promise.allSettled` alone waits for the
// SLOWEST branch, so one store still running past a shared response
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
  const outcome = await raceAgainstResponseBudget('Sprouts', slow, 10);
  assert.deepEqual(outcome, { status: 'pending' });
  assert.equal(settledLate, false); // hasn't had time yet — budget (10ms) < store's own delay (30ms)
  await delay(30, undefined); // let the underlying promise actually finish
  assert.equal(settledLate, true); // it was never cancelled — just too late for the response that already went out
});

test('a fast store is unaffected by a slow sibling racing the same budget', async () => {
  const [fast, slow] = await Promise.all([
    raceAgainstResponseBudget('Sprouts', delay(1, ['milk']), 20),
    raceAgainstResponseBudget("Trader Joe's", new Promise<string[]>(() => {}), 20),
  ]);
  assert.deepEqual(fast, { status: 'fulfilled', value: ['milk'] });
  assert.deepEqual(slow, { status: 'pending' });
});

test('timer cleanup: a store that settles well within budget does not leave the response waiting for the full budget window', async () => {
  const start = Date.now();
  await raceAgainstResponseBudget('Kroger', delay(5, ['product']), 5000);
  const elapsed = Date.now() - start;
  // If the timer weren't cleared/short-circuited on early settlement, this
  // would still resolve correctly (the promise resolves on first settle
  // either way) — this assertion is about latency, not correctness: the
  // wrapper must not itself introduce delay beyond the store's real time.
  assert.ok(elapsed < 200, `expected near-instant resolution once the store settled, took ${elapsed}ms`);
});

test('no unhandled rejection: a store that fails AFTER the budget already reported pending is still safely consumed', async () => {
  let unhandled: unknown = null;
  const onUnhandledRejection = (reason: unknown) => { unhandled = reason; };
  process.on('unhandledRejection', onUnhandledRejection);
  try {
    const lateFailure = delay(15, undefined).then(() => { throw new Error('late failure'); });
    const outcome = await raceAgainstResponseBudget('Aldi', lateFailure, 5);
    assert.deepEqual(outcome, { status: 'pending' });
    // Give the late rejection a chance to actually fire and, if it were
    // going to produce an unhandled rejection, to be reported.
    await delay(30, undefined);
    assert.equal(unhandled, null);
  } finally {
    process.off('unhandledRejection', onUnhandledRejection);
  }
});

test('concurrent searches are isolated: two calls for the same store name racing independently never share state', async () => {
  const [a, b] = await Promise.all([
    raceAgainstResponseBudget('Kroger', delay(5, ['search-a-result']), 50),
    raceAgainstResponseBudget('Kroger', new Promise<string[]>(() => {}), 5),
  ]);
  assert.deepEqual(a, { status: 'fulfilled', value: ['search-a-result'] });
  assert.deepEqual(b, { status: 'pending' });
});

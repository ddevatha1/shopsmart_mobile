// Tests warmAll's aggregation/timing/error-containment logic against fake
// tasks — no network access needed. runWarmup itself (which wires in the
// real Kroger/Aldi/Sprouts/Trader Joe's warm functions) isn't covered here
// since those genuinely hit live network/credentials; warmAll is where all
// of runWarmup's actual logic (parallelism, per-task timing, never letting
// one task's failure affect another) lives, so it's the meaningful unit to
// test in isolation.
//
// Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { warmAll, runWarmup, getBackendReadiness } from './warmupService.ts';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('warmAll runs every task and reports success for each', async () => {
  const results = await warmAll([
    { store: 'A', run: async () => { await delay(5); } },
    { store: 'B', run: async () => { await delay(5); } },
  ]);

  assert.equal(results.length, 2);
  for (const r of results) {
    assert.equal(r.ok, true);
    assert.equal(r.error, undefined);
    assert.ok(r.ms >= 0);
  }
});

test('warmAll contains a failing task instead of throwing, and other tasks still complete', async () => {
  const results = await warmAll([
    { store: 'Failing', run: async () => { throw new Error('boom'); } },
    { store: 'Fine', run: async () => { await delay(5); } },
  ]);

  const failing = results.find((r) => r.store === 'Failing');
  const fine = results.find((r) => r.store === 'Fine');

  assert.ok(failing);
  assert.equal(failing!.ok, false);
  assert.equal(failing!.error, 'boom');

  assert.ok(fine);
  assert.equal(fine!.ok, true);
});

test('warmAll runs tasks in parallel, not sequentially', async () => {
  const start = Date.now();
  await warmAll([
    { store: 'A', run: () => delay(50) },
    { store: 'B', run: () => delay(50) },
    { store: 'C', run: () => delay(50) },
  ]);
  const elapsed = Date.now() - start;
  // Sequential would take ~150ms; parallel should stay well under that.
  assert.ok(elapsed < 120, `expected parallel execution (~50ms), took ${elapsed}ms`);
});

test('warmAll returns an empty array for an empty task list without throwing', async () => {
  const results = await warmAll([]);
  assert.deepEqual(results, []);
});

// Regression coverage for a real, confirmed production bug: once a
// warm-up cycle for a given key completed, the very next call used to
// unconditionally restart a brand new cycle (the completed promise had
// already left `inFlight`), synchronously resetting readiness back to
// 'warming' before the route's own same-tick readiness read — meaning a
// client polling /api/warmup could never observe 'ready', no matter how
// long the backend had genuinely been warm. Confirmed live against
// production: 10 consecutive polls, several seconds apart, every one
// reporting "warming" despite every store's own warm function completing
// in single-digit milliseconds each time. `tasksOverride` (test-only —
// see runWarmup's own doc comment) lets this be exercised with fake,
// instantly-resolving tasks instead of the real network-bound store
// warm functions.
test('runWarmup does not restart a new cycle for a key that already reached "ready" recently — the exact bug behind /api/warmup never converging', async () => {
  const zipcode = '99999-regression-a';
  let callCount = 0;
  const tasks = [{ store: 'Fake', run: async () => { callCount += 1; } }];

  const first = await runWarmup(zipcode, tasks);
  assert.equal(callCount, 1);
  assert.equal(getBackendReadiness(zipcode).status, 'ready');
  assert.equal(getBackendReadiness(zipcode).searchReady, true);

  // A second call for the same key, made after the first cycle's promise
  // has already settled and left `inFlight` — this is exactly the
  // shape of a client's next /api/warmup poll arriving after the
  // previous one finished.
  const second = await runWarmup(zipcode, tasks);
  assert.equal(callCount, 1, 'a second call within the cooldown window must not re-run the warm-up tasks');
  assert.equal(second, first, 'must return the exact same cached result, not a fresh one');

  // The real, observable bug this fixes: readiness must still report
  // 'ready' immediately afterward, not flash back to 'warming'.
  const readiness = getBackendReadiness(zipcode);
  assert.equal(readiness.status, 'ready');
  assert.equal(readiness.searchReady, true);
});

test('runWarmup still dedupes two overlapping calls for the same key against one in-flight cycle (unchanged, pre-existing behavior)', async () => {
  const zipcode = '99999-regression-b';
  let callCount = 0;
  const tasks = [{ store: 'Fake', run: async () => { callCount += 1; await delay(10); } }];

  const [a, b] = await Promise.all([runWarmup(zipcode, tasks), runWarmup(zipcode, tasks)]);
  assert.equal(callCount, 1, 'two overlapping calls must share one in-flight cycle, not run the tasks twice');
  assert.equal(a, b);
});

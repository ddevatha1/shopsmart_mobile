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
import { warmAll } from './warmupService.ts';

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

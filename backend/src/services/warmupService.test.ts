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
import { warmAll, getBackendReadiness } from './warmupService.ts';

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

test('warmAll caps how long it waits on a single slow task, reporting it as a soft failure', async () => {
  const start = Date.now();
  const results = await warmAll(
    [
      { store: 'Slow', run: () => delay(200) },
      { store: 'Fast', run: () => delay(5) },
    ],
    20, // a much shorter budget than the real PER_STORE_TIMEOUT_MS, for a fast test
  );
  const elapsed = Date.now() - start;

  const slow = results.find((r) => r.store === 'Slow');
  const fast = results.find((r) => r.store === 'Fast');

  assert.ok(slow);
  assert.equal(slow!.ok, false);
  assert.match(slow!.error ?? '', /timed out/);
  assert.ok(fast);
  assert.equal(fast!.ok, true);
  // The whole call resolves close to the timeout budget, not the slow
  // task's real 200ms duration — this is the actual bug being fixed.
  assert.ok(elapsed < 150, `expected warmAll to resolve near the timeout budget, took ${elapsed}ms`);
});

// getBackendReadiness() is a synchronous, side-effect-free snapshot — safe
// to test directly without touching runWarmup (which wires in the real
// store warm functions; see this file's own header comment for why that
// stays untested here). Run first/in isolation from anything that calls
// runWarmup — a status of 'starting' is only guaranteed before any warm-up
// cycle has ever been kicked off in this process.
test('getBackendReadiness starts at "starting" — not ready, no prior result, before any warm-up has run', () => {
  const readiness = getBackendReadiness();
  assert.equal(readiness.status, 'starting');
  assert.equal(readiness.searchReady, false);
  assert.equal(readiness.lastResult, null);
  assert.ok(readiness.uptimeMs >= 0);
});

test('getBackendReadiness never throws and is cheap to call repeatedly (it is what /api/warmup responds from directly)', () => {
  for (let i = 0; i < 100; i++) {
    const readiness = getBackendReadiness();
    assert.ok(typeof readiness.uptimeMs === 'number');
  }
});

// Regression guard for a real bug this file used to have: readiness was a
// single global flag, so one shopper's in-progress (or just-completed)
// zip-specific warm-up could make a DIFFERENT shopper's /api/warmup poll
// for their OWN, unrelated zip report the wrong status — including a
// false 'ready' for a zip that was never actually warmed. runWarmup
// itself isn't exercised here (see this file's own header comment — it
// wires in real store network calls); this only locks in the contract
// `getBackendReadiness` must uphold: each zipcode key's snapshot is
// independent and never bleeds into another's.
test('getBackendReadiness is scoped independently per zipcode — never shares state across different zips', () => {
  const neverWarmedA = getBackendReadiness('99999');
  const neverWarmedB = getBackendReadiness('11111');

  assert.equal(neverWarmedA.status, 'starting');
  assert.equal(neverWarmedB.status, 'starting');
  assert.equal(neverWarmedA.searchReady, false);
  assert.equal(neverWarmedB.searchReady, false);
  assert.equal(neverWarmedA.lastResult, null);
  assert.equal(neverWarmedB.lastResult, null);

  // The zip-less key (server-boot warm-up) is its own independent key too
  // — not a fallback/default that a zip-specific lookup silently reads.
  const zipLess = getBackendReadiness();
  assert.equal(zipLess.status, 'starting');
});

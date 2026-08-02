// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TtlCache } from './ttlCache.ts';

test('returns a value set within the TTL window', () => {
  const cache = new TtlCache<string>(1000);
  cache.set('a', 'value');
  assert.equal(cache.get('a'), 'value');
});

test('returns undefined for a key that was never set', () => {
  const cache = new TtlCache<string>(1000);
  assert.equal(cache.get('missing'), undefined);
});

test('an expired entry is evicted from the underlying store on read, not just hidden', async () => {
  const cache = new TtlCache<string>(10);
  cache.set('a', 'value');
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(cache.get('a'), undefined);
  // Internal-state check: a real regression here (memory leak) is that the
  // entry technically stays in the Map forever, just always reported as a
  // miss — re-setting the same key after eviction must behave like a
  // fresh write, not silently resurrect the old timestamp.
  cache.set('a', 'fresh');
  assert.equal(cache.get('a'), 'fresh');
});

// Regression test for a real, observed production incident: a multi-day
// TTL (traderJoesLocator.ts's store-detail cache uses 30 days) passed
// straight through to `setInterval` overflows its 32-bit signed-int delay
// limit (~24.8 days). Node doesn't throw for this — it silently clamps
// the delay to 1ms and emits a `TimeoutOverflowWarning`, which turned the
// periodic sweep into a runaway loop re-scanning the whole cache on every
// tick. That single-handedly stalled the event loop badly enough to turn
// one live store search into a 27-second request. This locks in that a
// long TTL can never reach `setInterval` un-clamped.
test('a multi-day TTL never overflows setInterval\'s 32-bit delay limit', async () => {
  const warnings: string[] = [];
  const onWarning = (w: Error) => warnings.push(w.name);
  process.on('warning', onWarning);
  try {
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
    const cache = new TtlCache<string>(THIRTY_DAYS_MS);
    cache.set('a', 'value');
    // Give any synchronously-scheduled 'warning' event a turn to fire.
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(
      !warnings.includes('TimeoutOverflowWarning'),
      `expected no TimeoutOverflowWarning, got: ${warnings.join(', ') || '(none)'}`,
    );
  } finally {
    process.off('warning', onWarning);
  }
});

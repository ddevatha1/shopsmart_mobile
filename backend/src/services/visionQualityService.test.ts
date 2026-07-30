// Tests the one pure, network-free piece of the vision-LLM boundary: its
// rate limiter — the same pattern as intentClassifierService.test.ts's own
// `isOverRateLimit` tests, with a separate counter/env var for this
// feature. `callVisionProvider` itself makes a real network call and is
// exercised only via injected fakes at the route level.
//
// Run with: npm test (from backend/)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isOverVisionRateLimit, resetVisionRateLimitForTests } from './visionQualityService.ts';

test('isOverVisionRateLimit allows calls up to the configured per-minute limit, then blocks further ones', () => {
  const previousLimit = process.env.VISION_RATE_LIMIT_PER_MINUTE;
  process.env.VISION_RATE_LIMIT_PER_MINUTE = '2';
  resetVisionRateLimitForTests();
  try {
    assert.equal(isOverVisionRateLimit(), false); // call 1
    assert.equal(isOverVisionRateLimit(), false); // call 2
    assert.equal(isOverVisionRateLimit(), true); // call 3 — over the limit
  } finally {
    if (previousLimit === undefined) delete process.env.VISION_RATE_LIMIT_PER_MINUTE;
    else process.env.VISION_RATE_LIMIT_PER_MINUTE = previousLimit;
    resetVisionRateLimitForTests();
  }
});

test('isOverVisionRateLimit falls back to the documented default (10/min) when unset', () => {
  const previousLimit = process.env.VISION_RATE_LIMIT_PER_MINUTE;
  delete process.env.VISION_RATE_LIMIT_PER_MINUTE;
  resetVisionRateLimitForTests();
  try {
    for (let i = 0; i < 10; i++) {
      assert.equal(isOverVisionRateLimit(), false, `call ${i + 1} should be within the default limit`);
    }
    assert.equal(isOverVisionRateLimit(), true); // 11th call exceeds the default
  } finally {
    if (previousLimit === undefined) delete process.env.VISION_RATE_LIMIT_PER_MINUTE;
    else process.env.VISION_RATE_LIMIT_PER_MINUTE = previousLimit;
    resetVisionRateLimitForTests();
  }
});

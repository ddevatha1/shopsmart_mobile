// Tests the one pure, network-free piece of the LLM classifier boundary:
// `buildLLMContext`'s allowlist — the input-side mirror of
// intentClassifierValidation.ts's own output-side allowlist (see this
// file's header comment). `callLLMProvider` itself makes a real network
// call and is exercised only via injected fakes in intentRouterService's
// own hybrid tests, never here.
//
// Run with: npm test (from backend/)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLLMContext, isOverRateLimit, resetRateLimitForTests } from './intentClassifierService.ts';

test('buildLLMContext keeps the shopper\'s text', () => {
  const safe = buildLLMContext({ text: 'add milk to my cart' });
  assert.equal(safe.text, 'add milk to my cart');
  assert.equal(safe.currentScreen, undefined);
});

test('buildLLMContext passes through a real string currentScreen', () => {
  const safe = buildLLMContext({ text: 'add milk', context: { currentScreen: 'Cart' } });
  assert.equal(safe.currentScreen, 'Cart');
});

test('buildLLMContext drops a malformed currentScreen rather than passing it through', () => {
  // @ts-expect-error — deliberately malformed input, exactly what a
  // careless future caller might pass; the allowlist must still hold.
  const safe = buildLLMContext({ text: 'add milk', context: { currentScreen: 12345 } });
  assert.equal(safe.currentScreen, undefined);
});

test('buildLLMContext never carries any field beyond text/currentScreen, even if the input object has extras', () => {
  const input = { text: 'add milk', context: { currentScreen: 'Home' }, cartItems: ['secret'], email: 'shopper@example.com' };
  const safe = buildLLMContext(input as never);
  assert.deepEqual(Object.keys(safe).sort(), ['currentScreen', 'text']);
});

test('isOverRateLimit allows calls up to the configured per-minute limit, then blocks further ones', () => {
  const previousLimit = process.env.LLM_RATE_LIMIT_PER_MINUTE;
  process.env.LLM_RATE_LIMIT_PER_MINUTE = '3';
  resetRateLimitForTests();
  try {
    assert.equal(isOverRateLimit(), false); // call 1
    assert.equal(isOverRateLimit(), false); // call 2
    assert.equal(isOverRateLimit(), false); // call 3
    assert.equal(isOverRateLimit(), true); // call 4 — over the limit
    assert.equal(isOverRateLimit(), true); // stays blocked within the same window
  } finally {
    if (previousLimit === undefined) delete process.env.LLM_RATE_LIMIT_PER_MINUTE;
    else process.env.LLM_RATE_LIMIT_PER_MINUTE = previousLimit;
    resetRateLimitForTests();
  }
});

test('isOverRateLimit falls back to the default limit when the env var is unset or invalid', () => {
  const previousLimit = process.env.LLM_RATE_LIMIT_PER_MINUTE;
  delete process.env.LLM_RATE_LIMIT_PER_MINUTE;
  resetRateLimitForTests();
  try {
    for (let i = 0; i < 20; i++) {
      assert.equal(isOverRateLimit(), false, `call ${i + 1} should be within the default limit`);
    }
    assert.equal(isOverRateLimit(), true); // 21st call exceeds the documented default of 20/min
  } finally {
    if (previousLimit === undefined) delete process.env.LLM_RATE_LIMIT_PER_MINUTE;
    else process.env.LLM_RATE_LIMIT_PER_MINUTE = previousLimit;
    resetRateLimitForTests();
  }
});

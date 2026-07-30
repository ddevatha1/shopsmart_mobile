// Run with: npm test
//
// Tests validateClassifierOutput — pure, synchronous, deterministic, no
// network. This is the one place raw LLM output is ever trusted (or,
// almost always in these tests, deliberately not trusted).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateClassifierOutput, UNKNOWN_INTENT } from './intentClassifierValidation.ts';

test('a well-formed, valid classifier response is accepted as-is', () => {
  const result = validateClassifierOutput({ type: 'search', confidence: 0.9, parameters: { query: 'milk' } });
  assert.deepEqual(result, { type: 'search', confidence: 0.9, parameters: { query: 'milk' } });
});

test('an unsupported/hallucinated intent type falls back to unknown', () => {
  const result = validateClassifierOutput({ type: 'delete_account', confidence: 0.95, parameters: {} });
  assert.deepEqual(result, UNKNOWN_INTENT);
});

test('a non-string type falls back to unknown', () => {
  assert.deepEqual(validateClassifierOutput({ type: 42, confidence: 0.9, parameters: {} }), UNKNOWN_INTENT);
  assert.deepEqual(validateClassifierOutput({ type: null, confidence: 0.9, parameters: {} }), UNKNOWN_INTENT);
});

test('confidence is clamped into [0, 1], not rejected, when out of range', () => {
  const over = validateClassifierOutput({ type: 'search', confidence: 1.7, parameters: {} });
  assert.equal(over.confidence, 1);
  const under = validateClassifierOutput({ type: 'search', confidence: -0.3, parameters: {} });
  assert.equal(under.confidence, 0);
});

test('a non-numeric or non-finite confidence falls back to unknown (never silently coerced)', () => {
  assert.deepEqual(validateClassifierOutput({ type: 'search', confidence: 'high', parameters: {} }), UNKNOWN_INTENT);
  assert.deepEqual(validateClassifierOutput({ type: 'search', confidence: NaN, parameters: {} }), UNKNOWN_INTENT);
  assert.deepEqual(validateClassifierOutput({ type: 'search', confidence: Infinity, parameters: {} }), UNKNOWN_INTENT);
});

test('malformed top-level shapes (not a plain object) all fall back to unknown, never throwing', () => {
  for (const bad of [null, undefined, 'a string', 42, true, [], ['type', 'search']]) {
    assert.doesNotThrow(() => validateClassifierOutput(bad));
    assert.deepEqual(validateClassifierOutput(bad), UNKNOWN_INTENT);
  }
});

test('missing type or confidence entirely falls back to unknown', () => {
  assert.deepEqual(validateClassifierOutput({ confidence: 0.9, parameters: {} }), UNKNOWN_INTENT);
  assert.deepEqual(validateClassifierOutput({ type: 'search', parameters: {} }), UNKNOWN_INTENT);
  assert.deepEqual(validateClassifierOutput({}), UNKNOWN_INTENT);
});

test('only allowlisted parameter keys (query/item/amount) survive — everything else is dropped', () => {
  const result = validateClassifierOutput({
    type: 'search',
    confidence: 0.9,
    parameters: { query: 'milk', notAllowed: 'sneaky', anotherOne: 123 },
  });
  assert.deepEqual(result.parameters, { query: 'milk' });
});

test('a hallucinated productId is always dropped, even though it is a plain string value', () => {
  const result = validateClassifierOutput({
    type: 'add_to_cart',
    confidence: 0.9,
    parameters: { item: 'milk', productId: 'llm-invented-id-123' },
  });
  assert.deepEqual(result.parameters, { item: 'milk' });
  assert.equal('productId' in result.parameters, false);
});

test('Phase 5.1: a hallucinated goal/items/budgetTarget on start_shopping_session is always dropped — never inferred from an LLM', () => {
  const result = validateClassifierOutput({
    type: 'start_shopping_session',
    confidence: 0.9,
    parameters: { goal: 'save_money', items: 'milk, eggs', budgetTarget: 100 },
  });
  assert.equal(result.type, 'start_shopping_session');
  assert.deepEqual(result.parameters, {}); // the dispatcher must ask for every field explicitly
});

test('Phase 5.2: a hallucinated field/value on update_preferences is always dropped — never inferred from an LLM', () => {
  const result = validateClassifierOutput({
    type: 'update_preferences',
    confidence: 0.9,
    parameters: { field: 'preferredStores', value: 'Aldi' },
  });
  assert.equal(result.type, 'update_preferences');
  assert.deepEqual(result.parameters, {}); // the dispatcher must report "not sure what to remember"
});

test('a tool-call-shaped payload smuggled into parameters is dropped, never passed through', () => {
  const result = validateClassifierOutput({
    type: 'add_to_cart',
    confidence: 0.9,
    parameters: {
      item: 'milk',
      toolCall: { name: 'addToCart', args: { productId: 'xyz', quantity: 5 } },
    },
  });
  assert.deepEqual(result.parameters, { item: 'milk' });
  assert.equal('toolCall' in result.parameters, false);
});

test('non-scalar values for an otherwise-allowed key are dropped, not coerced', () => {
  const result = validateClassifierOutput({
    type: 'search',
    confidence: 0.9,
    parameters: { query: { nested: 'object' }, item: ['array', 'value'], amount: null },
  });
  assert.deepEqual(result.parameters, {});
});

test('a missing/non-object parameters field results in an empty parameters bag, not a crash', () => {
  assert.deepEqual(validateClassifierOutput({ type: 'search', confidence: 0.9 }).parameters, {});
  assert.deepEqual(validateClassifierOutput({ type: 'search', confidence: 0.9, parameters: null }).parameters, {});
  assert.deepEqual(validateClassifierOutput({ type: 'search', confidence: 0.9, parameters: 'nope' }).parameters, {});
});

test('every valid IntentType is accepted', () => {
  const validTypes = [
    'search', 'add_to_cart', 'remove_from_cart', 'compare_options', 'optimize_cart',
    'open_planner', 'set_budget_target', 'meal_plan', 'nutrition_question', 'start_shopping_session',
    'update_preferences', 'unknown',
  ];
  for (const type of validTypes) {
    const result = validateClassifierOutput({ type, confidence: 0.5, parameters: {} });
    assert.equal(result.type, type);
  }
});

// Run with: npm test
//
// Tests resolveHybridIntent — the Phase 4.1 orchestrator. Every test
// injects a fake IntentClassifier (see HybridResolverDependencies) —
// none of these ever makes a real network call, and LLM_API_KEY is
// never set in this test environment either way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveHybridIntent } from './intentRouterService.ts';
import type { IntentClassifierInput } from './intentClassifierService.ts';

/** Tracks invocation via a shared flag rather than throwing — a throw
 * inside the classifier would just be caught by resolveHybridIntent's
 * own try/catch and silently masked by its fallback, which would defeat
 * the point of asserting "never called." */
function trackedClassifier(): { classifier: (input: IntentClassifierInput) => Promise<unknown>; wasCalled: () => boolean } {
  let called = false;
  return {
    classifier: async (_input: IntentClassifierInput) => {
      called = true;
      return { type: 'unknown', confidence: 0, parameters: {} };
    },
    wasCalled: () => called,
  };
}

test('1. A high-confidence deterministic match skips the LLM tier completely', async () => {
  let called = false;
  const classifier = async (_input: IntentClassifierInput) => {
    called = true;
    return { type: 'search', confidence: 0.99, parameters: {} };
  };

  const result = await resolveHybridIntent('find apples', { classifier });

  assert.equal(result.type, 'search');
  assert.equal(called, false, 'the injected classifier must not be invoked when tier 1 is already confident');
});

test('2. An ambiguous/unclassifiable query invokes the injected LLM classifier', async () => {
  let receivedInput: IntentClassifierInput | undefined;
  const classifier = async (input: IntentClassifierInput) => {
    receivedInput = input;
    return { type: 'meal_plan', confidence: 0.7, parameters: {} };
  };

  // Deliberately keyword-free (see Phase 5.0's meal_plan keyword expansion
  // in intentRouterService.ts, which added "dinner"/"breakfast" — an
  // earlier version of this sentence used the word "dinner" and would now
  // resolve confidently at tier 1, never reaching this test's classifier).
  const result = await resolveHybridIntent('surprise me with something good to make tonight', { classifier });

  assert.ok(receivedInput, 'expected the classifier to have been called');
  assert.equal(receivedInput!.text, 'surprise me with something good to make tonight');
  assert.equal(result.type, 'meal_plan');
  assert.equal(result.confidence, 0.7);
});

test('3. A valid LLM response is accepted and returned as the resolved intent', async () => {
  const classifier = async (_input: IntentClassifierInput) => ({
    type: 'nutrition_question',
    confidence: 0.85,
    parameters: { query: 'lentils' },
  });

  // Deliberately free of every rule keyword (no "protein"/"calorie"/etc.)
  // so tier 1 genuinely can't resolve this and the classifier's return
  // value is actually what this test observes.
  const result = await resolveHybridIntent('are lentils a good thing to eat a lot of', { classifier });

  assert.deepEqual(result, { type: 'nutrition_question', confidence: 0.85, parameters: { query: 'lentils' } });
});

test('4. Malformed (non-JSON-shaped) LLM output falls back to unknown', async () => {
  const classifier = async (_input: IntentClassifierInput) => 'not even an object, just a raw string';

  const result = await resolveHybridIntent('something ambiguous entirely', { classifier });

  assert.equal(result.type, 'unknown');
  assert.equal(result.confidence, 0);
});

test('4b. A classifier that throws on JSON parsing also falls back to unknown, never propagating', async () => {
  const classifier = async (_input: IntentClassifierInput) => {
    throw new SyntaxError('Unexpected token in JSON');
  };

  const result = await resolveHybridIntent('something ambiguous entirely', { classifier });

  assert.equal(result.type, 'unknown');
});

test('5. An unsupported/hallucinated intent type from the LLM falls back to unknown', async () => {
  const classifier = async (_input: IntentClassifierInput) => ({
    type: 'delete_my_account',
    confidence: 0.99,
    parameters: {},
  });

  const result = await resolveHybridIntent('something ambiguous entirely', { classifier });

  assert.equal(result.type, 'unknown');
});

test('6. An LLM call that times out falls back to the deterministic result (unknown), never hanging or throwing', async () => {
  const classifier = async (_input: IntentClassifierInput): Promise<unknown> => {
    return new Promise(() => {}); // never resolves
  };

  const start = Date.now();
  const result = await resolveHybridIntent('something ambiguous entirely', { classifier, timeoutMs: 50 });
  const elapsed = Date.now() - start;

  assert.equal(result.type, 'unknown');
  assert.ok(elapsed < 1000, `expected the timeout to bound the wait, took ${elapsed}ms`);
});

test('7. Product IDs / tool-call instructions the LLM attempts to include are stripped, never passed through', async () => {
  const classifier = async (_input: IntentClassifierInput) => ({
    type: 'add_to_cart',
    confidence: 0.9,
    parameters: {
      item: 'milk',
      productId: 'llm-invented-id',
      toolCall: { name: 'addToCart', args: { productId: 'llm-invented-id', quantity: 3 } },
    },
  });

  // Deliberately free of every rule keyword (no "add"/"remove"/etc.) so
  // tier 1 genuinely can't resolve this and the classifier's (attempted)
  // hallucinated output is actually what this test observes.
  const result = await resolveHybridIntent('can you get some milk for me please', { classifier });

  assert.equal(result.type, 'add_to_cart');
  assert.deepEqual(result.parameters, { item: 'milk' });
  assert.equal('productId' in result.parameters, false);
  assert.equal('toolCall' in result.parameters, false);
});

test('with no classifier configured/injected at all, the hybrid resolver behaves exactly like tier 1 alone', async () => {
  const confident = await resolveHybridIntent('find apples');
  assert.equal(confident.type, 'search');

  const unresolvable = await resolveHybridIntent('something ambiguous entirely');
  assert.equal(unresolvable.type, 'unknown');
});

test('the classifier is never invoked for input tier 1 already resolves confidently, across several intent types', async () => {
  for (const input of ['add eggs', 'remove milk', 'set my budget to 50', 'open the planner']) {
    const { classifier, wasCalled } = trackedClassifier();
    await resolveHybridIntent(input, { classifier });
    assert.equal(wasCalled(), false, `classifier should not have been called for "${input}"`);
  }
});

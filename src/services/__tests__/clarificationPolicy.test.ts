import { evaluateClarificationPolicy } from '../clarificationPolicy';
import type { Intent } from '../../models/intent';

function makeIntent(overrides: Partial<Intent> = {}): Intent {
  return { type: 'search', confidence: 0.8, parameters: {}, ...overrides };
}

describe('evaluateClarificationPolicy', () => {
  test('1. Low confidence always requires clarification, regardless of type', () => {
    const decision = evaluateClarificationPolicy(makeIntent({ type: 'search', confidence: 0.3, parameters: { query: 'milk' } }));
    expect(decision.required).toBe(true);
    expect(decision.request?.type).toBe('clarification');
  });

  test('3. "add milk" (item text present) proceeds — real product resolution happens downstream, in the dispatcher', () => {
    // Phase 4.3: this layer never calls a service (see this file's own
    // header comment), so it can't itself decide "resolved" vs. "needs
    // selection" — that requires a real search, which happens in
    // assistantDispatcher.ts's dispatchAddToCart. See that file's own
    // tests for the full resolve/select/confirm state machine.
    const decision = evaluateClarificationPolicy(makeIntent({ type: 'add_to_cart', confidence: 0.8, parameters: { item: 'milk' } }));
    expect(decision.required).toBe(false);
  });

  test('a hallucinated parameters.productId has no effect on this decision either way — it is never read here', () => {
    const withId = evaluateClarificationPolicy(
      makeIntent({ type: 'add_to_cart', confidence: 0.8, parameters: { item: 'milk', productId: 'llm-invented-id' } }),
    );
    const withoutId = evaluateClarificationPolicy(makeIntent({ type: 'add_to_cart', confidence: 0.8, parameters: { item: 'milk' } }));
    expect(withId).toEqual(withoutId);
  });

  test('add_to_cart with no item text at all still asks a clarifying question', () => {
    const decision = evaluateClarificationPolicy(makeIntent({ type: 'add_to_cart', confidence: 0.8, parameters: {} }));
    expect(decision.required).toBe(true);
    expect(decision.request?.message).toBe('Which product would you like to add to your cart?');
    expect(decision.missingFields).toContain('item');
  });

  test('remove_from_cart with item text present also proceeds, same as add_to_cart', () => {
    const decision = evaluateClarificationPolicy(makeIntent({ type: 'remove_from_cart', confidence: 0.8, parameters: { item: 'eggs' } }));
    expect(decision.required).toBe(false);
  });

  test('remove_from_cart with no item text asks a clarifying question', () => {
    const decision = evaluateClarificationPolicy(makeIntent({ type: 'remove_from_cart', confidence: 0.8, parameters: {} }));
    expect(decision.required).toBe(true);
    expect(decision.request?.message).toBe('Which item would you like to remove from your cart?');
  });

  test('4. "find milk" (search with a query) does NOT require clarification', () => {
    const decision = evaluateClarificationPolicy(makeIntent({ type: 'search', confidence: 0.8, parameters: { query: 'milk' } }));
    expect(decision.required).toBe(false);
  });

  test('search with no query at all DOES require clarification', () => {
    const decision = evaluateClarificationPolicy(makeIntent({ type: 'search', confidence: 0.8, parameters: {} }));
    expect(decision.required).toBe(true);
    expect(decision.request?.message).toBe('What would you like to search for?');
  });

  test('5. "set budget to 50" (a valid amount) proceeds without clarification', () => {
    const decision = evaluateClarificationPolicy(makeIntent({ type: 'set_budget_target', confidence: 0.9, parameters: { amount: 50 } }));
    expect(decision.required).toBe(false);
  });

  test('Phase 5.3: set_budget_target with any amount (missing, zero, negative, or valid) always PROCEEDs — its own real, merge-capable follow-up lives in assistantDispatcher.ts now, not here', () => {
    for (const amount of [undefined, 0, -5, NaN, Infinity, 50]) {
      const decision = evaluateClarificationPolicy(makeIntent({ type: 'set_budget_target', confidence: 0.9, parameters: { amount } }));
      expect(decision.required).toBe(false);
    }
  });

  test('compare_options requires a query', () => {
    const withQuery = evaluateClarificationPolicy(makeIntent({ type: 'compare_options', confidence: 0.7, parameters: { query: 'milk brands' } }));
    expect(withQuery.required).toBe(false);

    const withoutQuery = evaluateClarificationPolicy(makeIntent({ type: 'compare_options', confidence: 0.7, parameters: {} }));
    expect(withoutQuery.required).toBe(true);
  });

  test('nutrition_question requires a food/product query', () => {
    const withQuery = evaluateClarificationPolicy(makeIntent({ type: 'nutrition_question', confidence: 0.7, parameters: { query: 'lentils' } }));
    expect(withQuery.required).toBe(false);

    const withoutQuery = evaluateClarificationPolicy(makeIntent({ type: 'nutrition_question', confidence: 0.7, parameters: {} }));
    expect(withoutQuery.required).toBe(true);
  });

  test('"make my shopping list cheaper" (optimize_cart) proceeds — existing routing already handles it', () => {
    const decision = evaluateClarificationPolicy(makeIntent({ type: 'optimize_cart', confidence: 0.9, parameters: {} }));
    expect(decision.required).toBe(false);
  });

  test('open_planner never requires clarification', () => {
    const decision = evaluateClarificationPolicy(makeIntent({ type: 'open_planner', confidence: 0.7, parameters: {} }));
    expect(decision.required).toBe(false);
  });

  test('meal_plan never requires extra clarification beyond confidence', () => {
    const decision = evaluateClarificationPolicy(makeIntent({ type: 'meal_plan', confidence: 0.7, parameters: {} }));
    expect(decision.required).toBe(false);
  });

  test('unknown intent (always confidence 0) requires clarification via the universal floor', () => {
    const decision = evaluateClarificationPolicy(makeIntent({ type: 'unknown', confidence: 0, parameters: {} }));
    expect(decision.required).toBe(true);
  });

  test('this policy never mutates or reaches into any external service — it is a pure function of its inputs', () => {
    const intent = makeIntent({ type: 'add_to_cart', confidence: 0.8, parameters: { item: 'milk' } });
    const before = JSON.stringify(intent);
    evaluateClarificationPolicy(intent, { cartSize: 2, activeQuery: 'milk' });
    expect(JSON.stringify(intent)).toBe(before);
  });
});

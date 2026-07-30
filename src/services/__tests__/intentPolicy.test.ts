import { evaluateIntent, buildClarification, validateSessionContext } from '../intentPolicy';
import type { Intent } from '../../models/intent';

function makeIntent(overrides: Partial<Intent> = {}): Intent {
  return { type: 'search', confidence: 0.8, parameters: {}, ...overrides };
}

describe('evaluateIntent', () => {
  test('low confidence is blocked, regardless of intent type', () => {
    const decision = evaluateIntent(makeIntent({ type: 'search', confidence: 0.3 }));
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBeTruthy();
  });

  test('search is allowed at the lower (0.6) safe threshold', () => {
    expect(evaluateIntent(makeIntent({ type: 'search', confidence: 0.6 })).allowed).toBe(true);
    expect(evaluateIntent(makeIntent({ type: 'search', confidence: 0.65 })).allowed).toBe(true);
  });

  test('open_planner and nutrition_question are also allowed at the lower safe threshold', () => {
    expect(evaluateIntent(makeIntent({ type: 'open_planner', confidence: 0.6 })).allowed).toBe(true);
    expect(evaluateIntent(makeIntent({ type: 'nutrition_question', confidence: 0.6 })).allowed).toBe(true);
  });

  test('cart-mutating intents require the higher (0.8) confidence threshold', () => {
    expect(evaluateIntent(makeIntent({ type: 'add_to_cart', confidence: 0.7 })).allowed).toBe(false);
    expect(evaluateIntent(makeIntent({ type: 'remove_from_cart', confidence: 0.7 })).allowed).toBe(false);
    expect(evaluateIntent(makeIntent({ type: 'add_to_cart', confidence: 0.8 })).allowed).toBe(true);
    expect(evaluateIntent(makeIntent({ type: 'remove_from_cart', confidence: 0.85 })).allowed).toBe(true);
  });

  test('optimize_cart requires the higher (0.8) confidence threshold', () => {
    expect(evaluateIntent(makeIntent({ type: 'optimize_cart', confidence: 0.6 })).allowed).toBe(false);
    expect(evaluateIntent(makeIntent({ type: 'optimize_cart', confidence: 0.79 })).allowed).toBe(false);
    expect(evaluateIntent(makeIntent({ type: 'optimize_cart', confidence: 0.8 })).allowed).toBe(true);
  });

  test('set_budget_target requires the higher (0.8) confidence threshold', () => {
    expect(evaluateIntent(makeIntent({ type: 'set_budget_target', confidence: 0.7 })).allowed).toBe(false);
    expect(evaluateIntent(makeIntent({ type: 'set_budget_target', confidence: 0.9 })).allowed).toBe(true);
  });

  test('unknown is always blocked (it always carries confidence 0)', () => {
    expect(evaluateIntent(makeIntent({ type: 'unknown', confidence: 0 })).allowed).toBe(false);
  });

  test('compare_options and meal_plan were deliberately reviewed and promoted to safe in Phase 3.2 — allowed at the lower threshold', () => {
    expect(evaluateIntent(makeIntent({ type: 'compare_options', confidence: 0.6 })).allowed).toBe(true);
    expect(evaluateIntent(makeIntent({ type: 'meal_plan', confidence: 0.6 })).allowed).toBe(true);
  });

  test('update_preferences (Phase 5.2) was deliberately reviewed as safe — it never touches cart/account state, only local preference memory', () => {
    expect(evaluateIntent(makeIntent({ type: 'update_preferences', confidence: 0.6 })).allowed).toBe(true);
    expect(evaluateIntent(makeIntent({ type: 'update_preferences', confidence: 0.59 })).allowed).toBe(false);
  });
});

describe('buildClarification', () => {
  test('search gets the exact clarification message from the sprint brief', () => {
    const clarification = buildClarification(makeIntent({ type: 'search' }));
    expect(clarification.type).toBe('clarification');
    expect(clarification.message).toBe('Did you want to search for a product?');
    expect(clarification.originalIntent.type).toBe('search');
  });

  test('optimize_cart gets the exact clarification message from the sprint brief', () => {
    const clarification = buildClarification(makeIntent({ type: 'optimize_cart' }));
    expect(clarification.message).toBe('Would you like me to optimize your cart?');
  });

  test('an intent type with no specific message falls back to a generic clarification', () => {
    const clarification = buildClarification(makeIntent({ type: 'unknown' }));
    expect(clarification.message.length).toBeGreaterThan(0);
  });
});

describe('validateSessionContext', () => {
  test('optimize_cart requires cart context (a non-empty cart)', () => {
    expect(validateSessionContext(makeIntent({ type: 'optimize_cart' }), {})).toBe(false);
    expect(validateSessionContext(makeIntent({ type: 'optimize_cart' }), { cartSize: 0 })).toBe(false);
    expect(validateSessionContext(makeIntent({ type: 'optimize_cart' }), { cartSize: 3 })).toBe(true);
  });

  test('remove_from_cart requires cart context', () => {
    expect(validateSessionContext(makeIntent({ type: 'remove_from_cart' }), {})).toBe(false);
    expect(validateSessionContext(makeIntent({ type: 'remove_from_cart' }), { cartSize: 1 })).toBe(true);
  });

  test('add_to_cart requires search/product context OR an explicit product id', () => {
    const intent = makeIntent({ type: 'add_to_cart' });
    expect(validateSessionContext(intent, {})).toBe(false);
    expect(validateSessionContext(intent, { activeQuery: 'milk' })).toBe(true);
    expect(validateSessionContext(makeIntent({ type: 'add_to_cart', parameters: { productId: 'abc-123' } }), {})).toBe(true);
  });

  test('add_to_cart is NOT satisfied merely by the router\'s own crude free-text item extraction', () => {
    // The router always sets `parameters.item` for any add_to_cart match
    // — trusting that alone would make this check meaningless.
    const intent = makeIntent({ type: 'add_to_cart', parameters: { item: 'milk to cart' } });
    expect(validateSessionContext(intent, {})).toBe(false);
  });

  test('search and nutrition_question are never rejected for missing context', () => {
    expect(validateSessionContext(makeIntent({ type: 'search' }), {})).toBe(true);
    expect(validateSessionContext(makeIntent({ type: 'nutrition_question' }), {})).toBe(true);
  });
});

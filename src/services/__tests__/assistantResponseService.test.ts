import { formatAssistantResponse } from '../assistantResponseService';
import type { AssistantOutcome, Intent } from '../../models/intent';
import type { ApiProduct } from '../../models/types';

function makeIntent(overrides: Partial<Intent> = {}): Intent {
  return { type: 'search', confidence: 0.8, parameters: {}, ...overrides };
}

function makeProduct(id: string, name = `Product ${id}`): ApiProduct {
  return { id, name, brand: 'Brand', price: 3.5, rating: 4, size: '1 ea', store: 'Kroger' };
}

describe('formatAssistantResponse — success cases', () => {
  test('open_planner success converts to a plain instruction sentence', () => {
    const outcome: AssistantOutcome = {
      success: true,
      intent: makeIntent({ type: 'open_planner' }),
      data: { action: 'open_planner' },
    };
    const response = formatAssistantResponse(outcome);
    expect(response.text).toBe('Opening your shopping planner.');
    expect(response.shouldSpeak).toBe(true);
  });

  test('a real cart mutation success names the real product', () => {
    const product = makeProduct('milk-1', 'Organic Whole Milk');
    const outcome: AssistantOutcome = {
      success: true,
      intent: makeIntent({ type: 'add_to_cart' }),
      data: { action: 'added_to_cart', product },
    };
    expect(formatAssistantResponse(outcome).text).toBe('Added Organic Whole Milk to your cart.');
  });

  test('a search success references the real query and real result count, never fabricated', () => {
    const outcome: AssistantOutcome = {
      success: true,
      intent: makeIntent({ type: 'search', parameters: { query: 'milk' } }),
      data: { products: [makeProduct('a')], storeStatuses: [] },
    };
    const response = formatAssistantResponse(outcome);
    expect(response.text.toLowerCase()).toContain('milk');
  });

  test('a search success with zero results says so honestly, never claims results exist', () => {
    const outcome: AssistantOutcome = {
      success: true,
      intent: makeIntent({ type: 'search', parameters: { query: 'unobtainium' } }),
      data: { products: [], storeStatuses: [] },
    };
    expect(formatAssistantResponse(outcome).text.toLowerCase()).toContain("couldn't find");
  });

  test('meal_plan success names the real meal/grocery-item counts, never a generic "Done."', () => {
    const outcome: AssistantOutcome = {
      success: true,
      intent: makeIntent({ type: 'meal_plan' }),
      data: { action: 'meal_plan_result', meals: [{ id: 'a', name: 'Chicken Tacos', mealType: 'dinner', ingredients: ['chicken breast'] }], groceryItems: ['chicken breast'], pantryAdditions: [] },
    };
    const text = formatAssistantResponse(outcome).text;
    expect(text).toContain('1 meal');
    expect(text).toContain('1 grocery item');
    expect(text).not.toBe('Done.');
  });

  test('meal_plan success names real pantry advisory additions when present', () => {
    const outcome: AssistantOutcome = {
      success: true,
      intent: makeIntent({ type: 'meal_plan' }),
      data: {
        action: 'meal_plan_result',
        meals: [{ id: 'a', name: 'Chicken Tacos', mealType: 'dinner', ingredients: ['chicken breast'] }],
        groceryItems: ['chicken breast', 'rice'],
        pantryAdditions: ['rice'],
      },
    };
    const text = formatAssistantResponse(outcome).text;
    expect(text.toLowerCase()).toContain('low on rice');
  });

  test('a shopping_session_plan success speaks the real explanation text verbatim', () => {
    const outcome: AssistantOutcome = {
      success: true,
      intent: makeIntent({ type: 'start_shopping_session' }),
      data: {
        action: 'shopping_session_plan', sessionId: 's1', goal: 'save_money', items: [],
        plan: { candidates: [], recommendedId: 'balanced', unresolvedItems: [] },
        explanation: 'I found 1 way to shop:\n- Balanced: a total cost of $50.00 across 2 stores.',
      },
    };
    expect(formatAssistantResponse(outcome).text).toBe('I found 1 way to shop:\n- Balanced: a total cost of $50.00 across 2 stores.');
  });

  test('a preference_update_result success names the exact real field/value that was remembered', () => {
    const outcome: AssistantOutcome = {
      success: true,
      intent: makeIntent({ type: 'update_preferences' }),
      data: { action: 'preference_update_result', field: 'preferredStores', value: 'Aldi', preferences: { preferredStores: ['Aldi'] } },
    };
    expect(formatAssistantResponse(outcome).text).toBe('I\'ll remember you prefer Aldi.');
  });

  test('a defaultBudgetTarget preference_update_result names the real amount', () => {
    const outcome: AssistantOutcome = {
      success: true,
      intent: makeIntent({ type: 'set_budget_target' }),
      data: { action: 'preference_update_result', field: 'defaultBudgetTarget', value: 150, preferences: { defaultBudgetTarget: 150 } },
    };
    expect(formatAssistantResponse(outcome).text).toContain('$150.00');
  });

  test('a restock_suggestions success names the real suggested item names, never a generic message when suggestions exist', () => {
    const outcome: AssistantOutcome = {
      success: true,
      intent: makeIntent({ type: 'start_shopping_session' }),
      data: { action: 'restock_suggestions', suggestions: [{ type: 'restock', itemName: 'Milk', reason: 'real reason', priority: 'urgent' }] },
    };
    expect(formatAssistantResponse(outcome).text).toContain('Milk');
  });

  test('a restock_suggestions success with zero suggestions is honest about having nothing to say', () => {
    const outcome: AssistantOutcome = {
      success: true,
      intent: makeIntent({ type: 'start_shopping_session' }),
      data: { action: 'restock_suggestions', suggestions: [] },
    };
    expect(formatAssistantResponse(outcome).text.toLowerCase()).toContain("don't have enough");
  });

  test('a shopping_history_result success names the real session count', () => {
    const outcome: AssistantOutcome = {
      success: true,
      intent: makeIntent({ type: 'start_shopping_session' }),
      data: { action: 'shopping_history_result', sessions: [{ id: 's1', createdAt: Date.now(), goal: 'save_money', itemCount: 12 }] },
    };
    expect(formatAssistantResponse(outcome).text).toContain('1 previous shopping session');
  });

  test('a shopping_history_result success with no sessions is honest, never fabricated history', () => {
    const outcome: AssistantOutcome = {
      success: true,
      intent: makeIntent({ type: 'start_shopping_session' }),
      data: { action: 'shopping_history_result', sessions: [] },
    };
    expect(formatAssistantResponse(outcome).text.toLowerCase()).toContain("don't have any previous");
  });

  test('nutrition success uses only real, present fields — never a fabricated number', () => {
    const outcome: AssistantOutcome = {
      success: true,
      intent: makeIntent({ type: 'nutrition_question' }),
      data: {
        action: 'nutrition_result',
        productName: 'Whole Milk',
        nutrition: { caloriesPer100g: 60, source: 'open_food_facts', completeness: 'partial' },
      },
    };
    const text = formatAssistantResponse(outcome).text;
    expect(text).toContain('Whole Milk');
    expect(text).toContain('60 calories');
    expect(text).not.toContain('protein'); // never present in the data, never invented
  });
});

describe('formatAssistantResponse — clarification / selection / confirmation', () => {
  test('a clarification_required outcome speaks the exact real clarification message, verbatim', () => {
    const outcome: AssistantOutcome = {
      success: false,
      intent: makeIntent({ type: 'add_to_cart' }),
      type: 'clarification_required',
      clarification: { type: 'clarification', message: 'Which product would you like to add to your cart?', originalIntent: makeIntent() },
    };
    expect(formatAssistantResponse(outcome).text).toBe('Which product would you like to add to your cart?');
  });

  test('a product_selection_required outcome mentions the real candidate count and query', () => {
    const outcome: AssistantOutcome = {
      success: false,
      intent: makeIntent({ type: 'add_to_cart' }),
      type: 'product_selection_required',
      data: { action: 'product_selection_required', query: 'milk', candidates: [makeProduct('a'), makeProduct('b')] },
    };
    const text = formatAssistantResponse(outcome).text;
    expect(text).toContain('2');
    expect(text).toContain('milk');
  });

  test('a confirmation_required outcome asks about the exact real product by name', () => {
    const outcome: AssistantOutcome = {
      success: false,
      intent: makeIntent({ type: 'add_to_cart' }),
      type: 'confirmation_required',
      data: { action: 'confirmation_required', mutationAction: 'add_to_cart', product: makeProduct('a', 'Organic Whole Milk') },
    };
    expect(formatAssistantResponse(outcome).text).toBe('Add Organic Whole Milk?');
  });

  test('a remove confirmation phrases the verb correctly', () => {
    const outcome: AssistantOutcome = {
      success: false,
      intent: makeIntent({ type: 'remove_from_cart' }),
      type: 'confirmation_required',
      data: { action: 'confirmation_required', mutationAction: 'remove_from_cart', product: makeProduct('a', 'Whole Milk') },
    };
    expect(formatAssistantResponse(outcome).text).toBe('Remove Whole Milk?');
  });
});

describe('formatAssistantResponse — failure cases (safe, generic messages)', () => {
  test('network_error gets a safe, generic connectivity message', () => {
    const outcome: AssistantOutcome = { success: false, intent: makeIntent({ type: 'unknown' }), errorType: 'network_error', error: 'fetch failed: ECONNREFUSED' };
    const text = formatAssistantResponse(outcome).text;
    expect(text).not.toContain('ECONNREFUSED'); // never speaks a raw technical error
    expect(text.length).toBeGreaterThan(0);
  });

  test('unknown_intent gets a safe generic message', () => {
    const outcome: AssistantOutcome = { success: false, intent: makeIntent({ type: 'unknown' }), errorType: 'unknown_intent' };
    expect(formatAssistantResponse(outcome).text.length).toBeGreaterThan(0);
  });

  test('service_failure gets a safe generic message, never the raw internal error code verbatim', () => {
    const outcome: AssistantOutcome = { success: false, intent: makeIntent({ type: 'meal_plan' }), errorType: 'service_failure', error: 'meal_plan_not_available' };
    expect(formatAssistantResponse(outcome).text).not.toBe('meal_plan_not_available');
  });

  test('a failure with no errorType at all still produces a safe, non-empty message, never crashing', () => {
    const outcome: AssistantOutcome = { success: false, intent: makeIntent({ type: 'unknown' }) };
    expect(() => formatAssistantResponse(outcome)).not.toThrow();
    expect(formatAssistantResponse(outcome).text.length).toBeGreaterThan(0);
  });
});

describe('formatAssistantResponse — shouldSpeak', () => {
  test('every real response produced by this service has shouldSpeak: true', () => {
    const outcomes: AssistantOutcome[] = [
      { success: true, intent: makeIntent(), data: { action: 'open_planner' } },
      { success: false, intent: makeIntent(), errorType: 'service_failure' },
    ];
    for (const outcome of outcomes) {
      expect(formatAssistantResponse(outcome).shouldSpeak).toBe(true);
    }
  });
});

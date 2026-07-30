import AsyncStorage from '@react-native-async-storage/async-storage';
import { dispatchIntent, parseShoppingGoal, type DispatcherDependencies } from '../assistantDispatcher';
import { getPendingProductSelection, getPendingCartMutationConfirmation, clearPendingProductSelection, clearPendingCartMutationConfirmation, createPendingCartMutationConfirmation } from '../productSelectionStore';
import { getPendingConversation, clearPendingConversation } from '../assistantConversationStore';
import { listSessions, clearAllSessions } from '../assistantShoppingSessionStore';
import { getPreferences, clearAllPreferences, setDefaultBudgetTarget, setOptimizationPreference } from '../shopperPreferenceService';
import { recordPurchases } from '../purchaseHistoryService';
import type { AssistantSessionContext, CartConfirmationResult, CartMutationResult, Intent } from '../../models/intent';
import type { ApiProduct, CartItem, MealPlanGenerationResult, PlanCandidate, SearchResponse, ShoppingPlanResponse } from '../../models/types';

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));

/**
 * Uses dependency injection (see assistantDispatcher.ts's `deps` param) —
 * fakes stand in for the real search/planner services and Zustand
 * stores, so these tests never touch AsyncStorage or the network. Same
 * DI-for-testability convention this codebase already uses for backend
 * nutrition enrichment.
 */

function makeIntent(overrides: Partial<Intent> = {}): Intent {
  return { type: 'unknown', confidence: 0, parameters: {}, ...overrides };
}

function makeProduct(id: string): ApiProduct {
  return { id, name: `Product ${id}`, brand: 'Brand', price: 3, rating: 4, size: '1 ea', store: 'Kroger' };
}

function makeSearchResponse(): SearchResponse {
  return { products: [makeProduct('a')], storeStatuses: [] };
}

function makePlanResponse(): ShoppingPlanResponse {
  return { candidates: [], recommendedId: 'balanced', unresolvedItems: [] };
}

function makeMealPlanResponse(): MealPlanGenerationResult {
  return {
    meals: [{ id: 'dinner-tacos-1', name: 'Chicken Tacos', mealType: 'dinner', ingredients: ['chicken breast', 'tortillas'] }],
    groceryItems: ['chicken breast', 'tortillas'],
    pantryAdditions: [],
  };
}

function baseDeps(overrides: Partial<DispatcherDependencies> = {}): DispatcherDependencies {
  return {
    search: jest.fn().mockResolvedValue(makeSearchResponse()),
    optimizeCart: jest.fn().mockResolvedValue(makePlanResponse()),
    getZipcode: () => '78701',
    getCartItems: () => [],
    addToCart: jest.fn().mockResolvedValue(undefined),
    removeFromCart: jest.fn().mockResolvedValue(undefined),
    generateMealPlan: jest.fn().mockResolvedValue(makeMealPlanResponse()),
    getLowStockItems: jest.fn().mockResolvedValue([]),
    getOwnerEmail: () => 'shopper@example.com',
    ...overrides,
  };
}

afterEach(async () => {
  clearPendingProductSelection();
  clearPendingCartMutationConfirmation();
  clearPendingConversation();
  await clearAllSessions('shopper@example.com');
  await clearAllPreferences('shopper@example.com');
  await AsyncStorage.removeItem('CartIQ_purchases_shopper@example.com'); // purchaseHistoryService.ts has no dedicated clear helper
});

describe('dispatchIntent — policy gating', () => {
  test('a blocked (low-confidence) intent returns a clarification and executes nothing', async () => {
    const deps = baseDeps();
    const intent = makeIntent({ type: 'search', confidence: 0.3, parameters: { query: 'bananas' } });

    const result = await dispatchIntent(intent, {}, deps);

    expect(result.success).toBe(false);
    expect(result.clarification?.type).toBe('clarification');
    expect(result.clarification?.message).toBe('Did you want to search for a product?');
    expect(deps.search).not.toHaveBeenCalled();
  });

  test('an allowed (high-confidence) intent with valid context executes for real', async () => {
    const deps = baseDeps();
    const intent = makeIntent({ type: 'search', confidence: 0.8, parameters: { query: 'bananas' } });

    const result = await dispatchIntent(intent, {}, deps);

    expect(result.success).toBe(true);
    expect(result.clarification).toBeUndefined();
    expect(deps.search).toHaveBeenCalledWith('bananas', '78701');
  });

  test('optimize_cart without cart context in the session is blocked before the planner is ever called', async () => {
    const deps = baseDeps();
    const intent = makeIntent({ type: 'optimize_cart', confidence: 0.9, parameters: {} });

    const result = await dispatchIntent(intent, {}, deps); // no cartSize in context

    expect(result.success).toBe(false);
    expect(result.clarification?.message).toBe('Would you like me to optimize your cart?');
    expect(deps.optimizeCart).not.toHaveBeenCalled();
  });

  test('optimize_cart WITH cart context in the session proceeds to call the planner', async () => {
    const cartItems: CartItem[] = [{ product: makeProduct('milk'), quantity: 2 }];
    const deps = baseDeps({ getCartItems: () => cartItems });
    const intent = makeIntent({ type: 'optimize_cart', confidence: 0.9, parameters: {} });
    const context: AssistantSessionContext = { cartSize: 2 };

    const result = await dispatchIntent(intent, context, deps);

    expect(result.success).toBe(true);
    expect(deps.optimizeCart).toHaveBeenCalledWith([{ id: 'milk', rawText: 'Product milk' }], '78701');
  });

  test('search without any session context is allowed — search/nutrition_question are never context-gated', async () => {
    const deps = baseDeps();
    const intent = makeIntent({ type: 'search', confidence: 0.8, parameters: { query: 'bananas' } });

    const result = await dispatchIntent(intent, {}, deps);

    expect(result.success).toBe(true);
    expect(deps.search).toHaveBeenCalled();
  });
});

describe('dispatchIntent — execution', () => {
  test('an unknown intent does not execute anything — neither service function is called', async () => {
    const deps = baseDeps();
    const intent = makeIntent({ type: 'unknown', confidence: 0, parameters: {} });

    const result = await dispatchIntent(intent, {}, deps);

    expect(deps.search).not.toHaveBeenCalled();
    expect(deps.optimizeCart).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.clarification).toBeTruthy(); // blocked by policy (confidence 0)
  });

  test('a failed underlying search call returns success:false with an error, never throwing', async () => {
    const deps = baseDeps({ search: jest.fn().mockRejectedValue(new Error('network down')) });
    const intent = makeIntent({ type: 'search', confidence: 0.8, parameters: { query: 'bananas' } });

    const result = await dispatchIntent(intent, {}, deps);

    expect(result.success).toBe(false);
    expect(result.error).toContain('network down');
  });

  test('optimize_cart with cart context but an empty real cart (deps disagree with context) returns success:false without calling the planner', async () => {
    // context says there's a cart (passes validateSessionContext), but
    // the real, live cart read disagrees — the dispatcher's own deeper
    // check must still catch this, never trusting the context hint alone.
    const deps = baseDeps({ getCartItems: () => [] });
    const intent = makeIntent({ type: 'optimize_cart', confidence: 0.9, parameters: {} });

    const result = await dispatchIntent(intent, { cartSize: 2 }, deps);

    expect(deps.optimizeCart).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
  });

  test('a search intent with no extractable query returns success:false without calling search', async () => {
    const deps = baseDeps();
    const intent = makeIntent({ type: 'search', confidence: 0.8, parameters: {} });

    const result = await dispatchIntent(intent, {}, deps);

    expect(deps.search).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
  });

  test('Phase 5.2: set_budget_target now writes ONLY to the local ShopperPreferences record, never the cart/account', async () => {
    const deps = baseDeps();
    const intent = makeIntent({ type: 'set_budget_target', confidence: 0.9, parameters: { amount: 100 } });

    const result = await dispatchIntent(intent, {}, deps);

    expect(result.success).toBe(true);
    const data = result.data as { action: string; field: string; value: number };
    expect(data.action).toBe('preference_update_result');
    expect(data.field).toBe('defaultBudgetTarget');
    expect(data.value).toBe(100);
    expect(deps.search).not.toHaveBeenCalled();
    expect(deps.optimizeCart).not.toHaveBeenCalled();
    expect(deps.addToCart).not.toHaveBeenCalled();
  });

  test('Phase 5.3: set_budget_target with no valid amount asks a real, merge-capable follow-up question, never a guessed default', async () => {
    const deps = baseDeps();
    const intent = makeIntent({ type: 'set_budget_target', confidence: 0.9, parameters: {} });

    const result = await dispatchIntent(intent, {}, deps);

    expect(result.success).toBe(false);
    expect(result.pendingType).toBe('conversation_required');
    expect(result.missingField).toBe('amount');
    expect(result.clarification?.message).toBe('What would you like to set your budget to?');
    expect(getPendingConversation()?.missingField).toBe('amount');
  });

  test('the returned result always echoes back the exact intent it was given', async () => {
    const deps = baseDeps();
    const intent = makeIntent({ type: 'search', confidence: 0.8, parameters: { query: 'milk' } });
    const result = await dispatchIntent(intent, {}, deps);
    expect(result.intent).toBe(intent);
  });
});

describe('dispatchIntent — open_planner', () => {
  test('returns a navigation INSTRUCTION, never navigating directly — no service is called', async () => {
    const deps = baseDeps();
    const intent = makeIntent({ type: 'open_planner', confidence: 0.7, parameters: {} });

    const result = await dispatchIntent(intent, {}, deps);

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ action: 'open_planner' });
    expect(deps.search).not.toHaveBeenCalled();
    expect(deps.optimizeCart).not.toHaveBeenCalled();
  });
});

describe('dispatchIntent — nutrition_question', () => {
  function makeNutritionProduct(): ApiProduct {
    return {
      ...makeProduct('milk'),
      name: 'Whole Milk',
      nutrition: { caloriesPer100g: 120, proteinGPer100g: 3.4, source: 'open_food_facts', completeness: 'partial' },
    };
  }

  test('returns verified nutrition data (real fields, untouched) when the matched product has it', async () => {
    const deps = baseDeps({ search: jest.fn().mockResolvedValue({ products: [makeNutritionProduct()], storeStatuses: [] }) });
    const intent = makeIntent({ type: 'nutrition_question', confidence: 0.7, parameters: { query: 'milk' } });

    const result = await dispatchIntent(intent, {}, deps);

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      action: 'nutrition_result',
      productName: 'Whole Milk',
      nutrition: { caloriesPer100g: 120, proteinGPer100g: 3.4, source: 'open_food_facts', completeness: 'partial' },
    });
  });

  test('returns an honest failure — never an estimate — when no matched product has verified nutrition data', async () => {
    const deps = baseDeps({ search: jest.fn().mockResolvedValue({ products: [makeProduct('a')], storeStatuses: [] }) });
    const intent = makeIntent({ type: 'nutrition_question', confidence: 0.7, parameters: { query: 'milk' } });

    const result = await dispatchIntent(intent, {}, deps);

    expect(result.success).toBe(false);
    expect(result.data).toBeUndefined();
    expect(result.error).toContain('No verified nutrition data');
  });
});

describe('dispatchIntent — compare_options', () => {
  test('works through the existing comparisonService (enrichProducts + getBestValueSummary), never a new comparison engine', async () => {
    const cheap: ApiProduct = { ...makeProduct('cheap'), name: 'Milk', price: 2, size: '1 gal' };
    const pricey: ApiProduct = { ...makeProduct('pricey'), name: 'Milk', price: 4, size: '1 gal' };
    const deps = baseDeps({ search: jest.fn().mockResolvedValue({ products: [pricey, cheap], storeStatuses: [] }) });
    const intent = makeIntent({ type: 'compare_options', confidence: 0.7, parameters: { query: 'milk' } });

    const result = await dispatchIntent(intent, {}, deps);

    expect(result.success).toBe(true);
    const data = result.data as { action: string; best: { product: ApiProduct } };
    expect(data.action).toBe('comparison_result');
    expect(data.best.product.id).toBe('cheap'); // the real, cheaper-per-unit product wins, not a guess
  });

  test('returns an honest failure — never fabricated comparison data — when search finds nothing', async () => {
    const deps = baseDeps({ search: jest.fn().mockResolvedValue({ products: [], storeStatuses: [] }) });
    const intent = makeIntent({ type: 'compare_options', confidence: 0.7, parameters: { query: 'unobtainium' } });

    const result = await dispatchIntent(intent, {}, deps);

    expect(result.success).toBe(false);
    expect(result.data).toBeUndefined();
  });
});

describe('dispatchIntent — meal_plan (Phase 5.0 Conversational Grocery Planner v1)', () => {
  test('with no mealCount, asks a real follow-up question instead of generating anything', async () => {
    const deps = baseDeps();
    const intent = makeIntent({ type: 'meal_plan', confidence: 0.7, parameters: { mealType: 'dinner' } });

    const result = await dispatchIntent(intent, {}, deps);

    expect(result.success).toBe(false);
    expect(result.pendingType).toBe('conversation_required');
    expect(result.missingField).toBe('mealCount');
    expect(result.clarification?.message).toBe('How many meals should I plan for?');
    expect(deps.generateMealPlan).not.toHaveBeenCalled();
    expect(getPendingConversation()?.missingField).toBe('mealCount');
  });

  test('with a real mealCount, generates a real deterministic meal plan via the injected generator', async () => {
    const deps = baseDeps();
    const intent = makeIntent({ type: 'meal_plan', confidence: 0.7, parameters: { mealCount: 5, mealType: 'dinner' } });

    const result = await dispatchIntent(intent, {}, deps);

    expect(result.success).toBe(true);
    expect(deps.generateMealPlan).toHaveBeenCalledWith({ mealCount: 5, mealType: 'dinner', lowStockItems: [] });
    const data = result.data as { action: string; meals: unknown[]; groceryItems: string[] };
    expect(data.action).toBe('meal_plan_result');
    expect(data.meals).toEqual(makeMealPlanResponse().meals);
    expect(data.groceryItems).toEqual(makeMealPlanResponse().groceryItems);
  });

  test('mealType defaults to dinner when not specified', async () => {
    const deps = baseDeps();
    const intent = makeIntent({ type: 'meal_plan', confidence: 0.7, parameters: { mealCount: 3 } });

    await dispatchIntent(intent, {}, deps);

    expect(deps.generateMealPlan).toHaveBeenCalledWith(expect.objectContaining({ mealType: 'dinner' }));
  });

  test('never mutates the cart — addToCart/removeFromCart are never called, regardless of outcome', async () => {
    const deps = baseDeps();
    await dispatchIntent(makeIntent({ type: 'meal_plan', confidence: 0.7, parameters: {} }), {}, deps);
    await dispatchIntent(makeIntent({ type: 'meal_plan', confidence: 0.7, parameters: { mealCount: 4 } }), {}, deps);

    expect(deps.addToCart).not.toHaveBeenCalled();
    expect(deps.removeFromCart).not.toHaveBeenCalled();
    expect(deps.optimizeCart).not.toHaveBeenCalled();
  });

  test('real pantry low-stock signal is passed through and surfaced as pantryAdditions — advisory only, never a cart change', async () => {
    const deps = baseDeps({
      getLowStockItems: jest.fn().mockResolvedValue(['rice']),
      generateMealPlan: jest.fn().mockResolvedValue({
        meals: makeMealPlanResponse().meals,
        groceryItems: [...makeMealPlanResponse().groceryItems, 'rice'],
        pantryAdditions: ['rice'],
      }),
    });
    const intent = makeIntent({ type: 'meal_plan', confidence: 0.7, parameters: { mealCount: 2 } });

    const result = await dispatchIntent(intent, {}, deps);

    expect(deps.getLowStockItems).toHaveBeenCalled();
    expect(deps.generateMealPlan).toHaveBeenCalledWith(expect.objectContaining({ lowStockItems: ['rice'] }));
    const data = result.data as { pantryAdditions: string[] };
    expect(data.pantryAdditions).toEqual(['rice']);
    expect(deps.addToCart).not.toHaveBeenCalled();
  });
});

describe('dispatchIntent — safety: blocked intents never reach dependencies', () => {
  test('every kind of block (low confidence, missing context) leaves every service dependency untouched', async () => {
    const deps = baseDeps();

    await dispatchIntent(makeIntent({ type: 'search', confidence: 0.2, parameters: { query: 'milk' } }), {}, deps);
    await dispatchIntent(makeIntent({ type: 'optimize_cart', confidence: 0.9, parameters: {} }), {}, deps); // no cart context
    await dispatchIntent(makeIntent({ type: 'add_to_cart', confidence: 0.5, parameters: {} }), {}, deps); // below mutation threshold
    await dispatchIntent(makeIntent({ type: 'unknown', confidence: 0, parameters: {} }), {}, deps);

    expect(deps.search).not.toHaveBeenCalled();
    expect(deps.optimizeCart).not.toHaveBeenCalled();
    expect(deps.addToCart).not.toHaveBeenCalled();
    expect(deps.removeFromCart).not.toHaveBeenCalled();
  });
});

describe('dispatchIntent — add_to_cart (Phase 4.3 product resolution)', () => {
  // Every test here supplies context.activeQuery so validateSessionContext
  // (intentPolicy.ts, unchanged) lets the request reach dispatchAddToCart
  // at all — a realistic stand-in for "the shopper was just searching."
  const CONTEXT: AssistantSessionContext = { activeQuery: 'milk' };

  test('1. Exactly one real direct match resolves — but still requires confirmation, never an automatic add', async () => {
    const match = makeProduct('milk-1');
    const deps = baseDeps({ search: jest.fn().mockResolvedValue({ products: [match], storeStatuses: [] }) });
    const intent = makeIntent({ type: 'add_to_cart', confidence: 0.85, parameters: { item: 'milk' } });

    const result = await dispatchIntent(intent, CONTEXT, deps);

    expect(result.success).toBe(false);
    expect(result.pendingType).toBe('confirmation_required');
    expect(deps.addToCart).not.toHaveBeenCalled();
    expect(getPendingCartMutationConfirmation()?.product.id).toBe('milk-1');
  });

  test('2. Multiple real direct matches require selection — never auto-picked by price or position', async () => {
    const cheap = { ...makeProduct('cheap'), price: 2 };
    const pricey = { ...makeProduct('pricey'), price: 5 };
    const deps = baseDeps({ search: jest.fn().mockResolvedValue({ products: [pricey, cheap], storeStatuses: [] }) });
    const intent = makeIntent({ type: 'add_to_cart', confidence: 0.85, parameters: { item: 'milk' } });

    const result = await dispatchIntent(intent, CONTEXT, deps);

    expect(result.success).toBe(false);
    expect(result.pendingType).toBe('product_selection_required');
    expect(deps.addToCart).not.toHaveBeenCalled();
    const pending = getPendingProductSelection();
    expect(pending?.candidates.map((c) => c.id).sort()).toEqual(['cheap', 'pricey']);
  });

  test('3. No results returns not_found, no pending state created', async () => {
    const deps = baseDeps({ search: jest.fn().mockResolvedValue({ products: [], storeStatuses: [] }) });
    const intent = makeIntent({ type: 'add_to_cart', confidence: 0.85, parameters: { item: 'unobtainium' } });

    const result = await dispatchIntent(intent, CONTEXT, deps);

    expect(result.success).toBe(false);
    expect(result.pendingType).toBeUndefined();
    expect(getPendingProductSelection()).toBeUndefined();
    expect(getPendingCartMutationConfirmation()).toBeUndefined();
  });

  test('4. A hallucinated parameters.productId is never trusted or read — resolution runs exactly as if it were absent', async () => {
    const match = makeProduct('real-match');
    const deps = baseDeps({ search: jest.fn().mockResolvedValue({ products: [match], storeStatuses: [] }) });
    const intent = makeIntent({
      type: 'add_to_cart',
      confidence: 0.85,
      parameters: { item: 'milk', productId: 'llm-invented-id-999' },
    });

    const result = await dispatchIntent(intent, CONTEXT, deps);

    // Still goes through the normal resolve-then-confirm flow — the
    // hallucinated id changes nothing about the outcome.
    expect(result.success).toBe(false);
    expect(result.pendingType).toBe('confirmation_required');
    expect(deps.addToCart).not.toHaveBeenCalled();
    expect(getPendingCartMutationConfirmation()?.product.id).toBe('real-match'); // never 'llm-invented-id-999'
  });

  test('5. "add milk" never calls the cart mutation on its own, regardless of how resolution turns out', async () => {
    for (const products of [[makeProduct('a')], [makeProduct('a'), makeProduct('b')], []]) {
      const deps = baseDeps({ search: jest.fn().mockResolvedValue({ products, storeStatuses: [] }) });
      const intent = makeIntent({ type: 'add_to_cart', confidence: 0.85, parameters: { item: 'milk' } });
      await dispatchIntent(intent, CONTEXT, deps);
      expect(deps.addToCart).not.toHaveBeenCalled();
      clearPendingCartMutationConfirmation();
      clearPendingProductSelection();
    }
  });

  test('a real, existing confirmation is what actually triggers the mutation — and only that', async () => {
    const product = makeProduct('confirmed-product');
    const originalIntent = makeIntent({ type: 'add_to_cart', confidence: 0.85, parameters: { item: 'milk' } });
    createPendingCartMutationConfirmation({ action: 'add_to_cart', product, originalIntent });
    const deps = baseDeps();

    const result = await dispatchIntent(originalIntent, CONTEXT, deps);

    expect(result.success).toBe(true);
    expect(deps.addToCart).toHaveBeenCalledWith(product);
    expect(getPendingCartMutationConfirmation()).toBeUndefined(); // consumed, not left behind
  });
});

describe('dispatchIntent — remove_from_cart (Phase 4.3, resolves against real cart contents)', () => {
  const CONTEXT: AssistantSessionContext = { cartSize: 2 };

  test('6. "remove milk" never removes automatically — resolves against the cart, then still requires confirmation', async () => {
    const cartItems: CartItem[] = [{ product: { ...makeProduct('milk-in-cart'), name: 'Whole Milk' }, quantity: 1 }];
    const deps = baseDeps({ getCartItems: () => cartItems });
    const intent = makeIntent({ type: 'remove_from_cart', confidence: 0.85, parameters: { item: 'milk' } });

    const result = await dispatchIntent(intent, CONTEXT, deps);

    expect(result.success).toBe(false);
    expect(result.pendingType).toBe('confirmation_required');
    expect(deps.removeFromCart).not.toHaveBeenCalled();
    expect(deps.search).not.toHaveBeenCalled(); // removal never searches the catalog
  });

  test('multiple matching cart items require selection', async () => {
    const cartItems: CartItem[] = [
      { product: { ...makeProduct('whole'), name: 'Whole Milk' }, quantity: 1 },
      { product: { ...makeProduct('almond'), name: 'Almond Milk' }, quantity: 1 },
    ];
    const deps = baseDeps({ getCartItems: () => cartItems });
    const intent = makeIntent({ type: 'remove_from_cart', confidence: 0.85, parameters: { item: 'milk' } });

    const result = await dispatchIntent(intent, CONTEXT, deps);

    expect(result.pendingType).toBe('product_selection_required');
    expect(deps.removeFromCart).not.toHaveBeenCalled();
  });

  test('a confirmed removal actually calls removeFromCart', async () => {
    const product = { ...makeProduct('to-remove'), name: 'Whole Milk' };
    const originalIntent = makeIntent({ type: 'remove_from_cart', confidence: 0.85, parameters: { item: 'milk' } });
    createPendingCartMutationConfirmation({ action: 'remove_from_cart', product, originalIntent });
    const deps = baseDeps({ getCartItems: () => [{ product, quantity: 1 }] });

    const result = await dispatchIntent(originalIntent, CONTEXT, deps);

    expect(result.success).toBe(true);
    expect(deps.removeFromCart).toHaveBeenCalledWith('to-remove', undefined);
  });

  test('"remove 2 bananas" clamps the requested quantity to what\'s really in the cart and threads it through confirmation', async () => {
    const product = { ...makeProduct('bananas'), name: 'Bananas' };
    const deps = baseDeps({ getCartItems: () => [{ product, quantity: 3 }] });
    const intent = makeIntent({ type: 'remove_from_cart', confidence: 0.85, parameters: { item: '2 bananas', quantity: 2 } });

    const result = await dispatchIntent(intent, CONTEXT, deps);

    expect(result.pendingType).toBe('confirmation_required');
    expect((result.data as CartConfirmationResult).requestedQuantity).toBe(2);
    expect(deps.removeFromCart).not.toHaveBeenCalled();
  });

  test('a requested quantity greater than what\'s in the cart clamps down to the real amount, never over-removes', async () => {
    const product = { ...makeProduct('bananas'), name: 'Bananas' };
    const deps = baseDeps({ getCartItems: () => [{ product, quantity: 3 }] });
    const intent = makeIntent({ type: 'remove_from_cart', confidence: 0.85, parameters: { item: '5 bananas', quantity: 5 } });

    const result = await dispatchIntent(intent, CONTEXT, deps);

    expect((result.data as CartConfirmationResult).requestedQuantity).toBe(3);
  });

  test('confirming a partial-quantity removal calls removeFromCart with that exact quantity', async () => {
    const product = { ...makeProduct('bananas'), name: 'Bananas' };
    const originalIntent = makeIntent({ type: 'remove_from_cart', confidence: 0.85, parameters: { item: '2 bananas', quantity: 2 } });
    createPendingCartMutationConfirmation({ action: 'remove_from_cart', product, originalIntent, requestedQuantity: 2 });
    const deps = baseDeps({ getCartItems: () => [{ product, quantity: 3 }] });

    const result = await dispatchIntent(originalIntent, CONTEXT, deps);

    expect(result.success).toBe(true);
    expect(deps.removeFromCart).toHaveBeenCalledWith('bananas', 2);
    expect((result.data as CartMutationResult).requestedQuantity).toBe(2);
  });
});

describe('parseShoppingGoal — deterministic, closed-vocabulary goal mapping', () => {
  test('recognizes each of the assistant\'s own offered choices', () => {
    expect(parseShoppingGoal('save money')).toBe('save_money');
    expect(parseShoppingGoal('Save Money')).toBe('save_money');
    expect(parseShoppingGoal('fastest trip')).toBe('general_shopping');
    expect(parseShoppingGoal('healthiest options')).toBe('general_shopping');
  });

  test('unrecognized free text returns undefined — never a guessed goal', () => {
    expect(parseShoppingGoal('purple elephant')).toBeUndefined();
  });
});

describe('dispatchIntent — start_shopping_session (Phase 5.1)', () => {
  function makePlanCandidate(overrides: Partial<PlanCandidate> = {}): PlanCandidate {
    return {
      id: 'cheapest', label: 'Cheapest', storeAssignments: [], totalCost: 42, estimatedGasCost: 2,
      estimatedSavings: 8.42, totalDriveMinutes: 12, totalDriveMiles: 5, storeCount: 2, itemsFound: 5, itemsTotal: 5,
      tripPlan: { origin: { latitude: 0, longitude: 0 }, totalDurationMinutes: 12, totalDistanceMiles: 5, routeGeometry: { type: 'LineString', coordinates: [] }, stops: [] },
      ...overrides,
    };
  }

  function makePlanResponseWithCandidates(): ShoppingPlanResponse {
    return { candidates: [makePlanCandidate()], recommendedId: 'cheapest', unresolvedItems: [] };
  }

  test('with no goal yet, asks a real follow-up question and never calls the optimizer', async () => {
    const deps = baseDeps();
    const intent = makeIntent({ type: 'start_shopping_session', confidence: 0.8, parameters: {} });

    const result = await dispatchIntent(intent, {}, deps);

    expect(result.success).toBe(false);
    expect(result.pendingType).toBe('conversation_required');
    expect(result.missingField).toBe('goal');
    expect(deps.optimizeCart).not.toHaveBeenCalled();
  });

  test('with a goal but no hasList answer, asks about an existing list next', async () => {
    const deps = baseDeps();
    const intent = makeIntent({ type: 'start_shopping_session', confidence: 0.8, parameters: { goal: 'save_money' } });

    const result = await dispatchIntent(intent, {}, deps);

    expect(result.missingField).toBe('hasList');
    expect(deps.optimizeCart).not.toHaveBeenCalled();
  });

  test('with goal + hasList but no items, asks for the items next', async () => {
    const deps = baseDeps();
    const intent = makeIntent({ type: 'start_shopping_session', confidence: 0.8, parameters: { goal: 'save_money', hasList: true } });

    const result = await dispatchIntent(intent, {}, deps);

    expect(result.missingField).toBe('items');
    expect(result.clarification?.message).toContain('enter your items');
    expect(deps.optimizeCart).not.toHaveBeenCalled();
  });

  test('once goal + hasList + items are all present, calls the SAME optimizeCart the existing optimize_cart intent uses', async () => {
    const deps = baseDeps({ optimizeCart: jest.fn().mockResolvedValue(makePlanResponseWithCandidates()) });
    const intent = makeIntent({
      type: 'start_shopping_session', confidence: 0.8,
      parameters: { goal: 'save_money', hasList: true, items: 'milk, eggs, bread' },
    });

    const result = await dispatchIntent(intent, {}, deps);

    expect(result.success).toBe(true);
    expect(deps.optimizeCart).toHaveBeenCalledTimes(1);
    const [items, zipcode] = (deps.optimizeCart as jest.Mock).mock.calls[0];
    expect(items).toEqual([
      { id: 'session-item-0', rawText: 'milk' },
      { id: 'session-item-1', rawText: 'eggs' },
      { id: 'session-item-2', rawText: 'bread' },
    ]);
    expect(zipcode).toBe('78701');
    const data = result.data as { action: string; goal: string; explanation: string };
    expect(data.action).toBe('shopping_session_plan');
    expect(data.goal).toBe('save_money');
    expect(data.explanation).toContain('Cheapest');
  });

  test('a real, explicit budgetTarget is passed through to the optimizer unchanged', async () => {
    const deps = baseDeps({ optimizeCart: jest.fn().mockResolvedValue(makePlanResponseWithCandidates()) });
    const intent = makeIntent({
      type: 'start_shopping_session', confidence: 0.8,
      parameters: { goal: 'save_money', hasList: true, items: 'milk', budgetTarget: 100 },
    });

    await dispatchIntent(intent, {}, deps);

    expect(deps.optimizeCart).toHaveBeenCalledWith(expect.anything(), '78701', 100);
  });

  test('never mutates the cart, regardless of how far the conversation gets', async () => {
    const deps = baseDeps({ optimizeCart: jest.fn().mockResolvedValue(makePlanResponseWithCandidates()) });
    await dispatchIntent(makeIntent({ type: 'start_shopping_session', confidence: 0.8, parameters: {} }), {}, deps);
    await dispatchIntent(makeIntent({ type: 'start_shopping_session', confidence: 0.8, parameters: { goal: 'save_money', hasList: true, items: 'milk' } }), {}, deps);

    expect(deps.addToCart).not.toHaveBeenCalled();
    expect(deps.removeFromCart).not.toHaveBeenCalled();
  });

  test('a completed session is persisted via getOwnerEmail — a real, explicit-fields-only record', async () => {
    const deps = baseDeps({ optimizeCart: jest.fn().mockResolvedValue(makePlanResponseWithCandidates()) });
    const intent = makeIntent({
      type: 'start_shopping_session', confidence: 0.8,
      parameters: { goal: 'restock', hasList: false, items: 'rice, beans' },
    });

    await dispatchIntent(intent, {}, deps);

    const sessions = await listSessions('shopper@example.com');
    expect(sessions.length).toBeGreaterThan(0);
    const last = sessions[sessions.length - 1];
    expect(last.goal).toBe('restock');
    expect(last.items.map((i) => i.rawText)).toEqual(['rice', 'beans']);
    expect(last.status).toBe('active');
  });

  test('Phase 5.2: a fresh "restock" goal with real purchase-history signal returns suggestions and never reaches the optimizer', async () => {
    const deps = baseDeps();
    // A real, repeated, overdue purchase (see assistantSuggestionService.test.ts
    // for the same fixture shape) — recorded directly via purchaseHistoryService
    // so this test proves the REAL suggestion service is wired in, not a fake.
    const realNow = Date.now();
    for (const daysAgo of [22, 15, 8]) {
      jest.spyOn(Date, 'now').mockReturnValue(realNow - daysAgo * 24 * 60 * 60 * 1000);
      await recordPurchases('shopper@example.com', [{ product: { ...makeProduct(`milk-${daysAgo}`), name: 'Whole Milk' }, quantity: 1 }]);
    }
    jest.spyOn(Date, 'now').mockReturnValue(realNow);

    const intent = makeIntent({ type: 'start_shopping_session', confidence: 0.8, parameters: { goal: 'restock' } });
    const result = await dispatchIntent(intent, {}, deps);

    expect(result.success).toBe(true);
    const data = result.data as { action: string; suggestions: { itemName: string }[] };
    expect(data.action).toBe('restock_suggestions');
    expect(data.suggestions.some((s) => s.itemName === 'Whole Milk')).toBe(true);
    expect(deps.optimizeCart).not.toHaveBeenCalled();
    expect(deps.addToCart).not.toHaveBeenCalled();
    jest.restoreAllMocks();
  });

  test('a fresh "restock" goal with no real purchase history falls through honestly to the normal list question', async () => {
    const deps = baseDeps();
    const intent = makeIntent({ type: 'start_shopping_session', confidence: 0.8, parameters: { goal: 'restock' } });

    const result = await dispatchIntent(intent, {}, deps);

    expect(result.pendingType).toBe('conversation_required');
    expect(result.missingField).toBe('hasList');
  });

  test('a remembered defaultBudgetTarget preference fills in when this turn stated no budget itself', async () => {
    await setDefaultBudgetTarget('shopper@example.com', 75);
    const deps = baseDeps({ optimizeCart: jest.fn().mockResolvedValue(makePlanResponseWithCandidates()) });
    const intent = makeIntent({
      type: 'start_shopping_session', confidence: 0.8,
      parameters: { goal: 'save_money', hasList: true, items: 'milk' },
    });

    await dispatchIntent(intent, {}, deps);

    expect(deps.optimizeCart).toHaveBeenCalledWith(expect.anything(), '78701', 75);
  });

  test('a budget stated THIS turn always wins over a remembered preference default', async () => {
    await setDefaultBudgetTarget('shopper@example.com', 75);
    const deps = baseDeps({ optimizeCart: jest.fn().mockResolvedValue(makePlanResponseWithCandidates()) });
    const intent = makeIntent({
      type: 'start_shopping_session', confidence: 0.8,
      parameters: { goal: 'save_money', hasList: true, items: 'milk', budgetTarget: 30 },
    });

    await dispatchIntent(intent, {}, deps);

    expect(deps.optimizeCart).toHaveBeenCalledWith(expect.anything(), '78701', 30);
  });

  test('Phase 5.3 Part 1: a real, evidence-backed recommendationExplanation is attached to the result', async () => {
    const deps = baseDeps({ optimizeCart: jest.fn().mockResolvedValue(makePlanResponseWithCandidates()) });
    const intent = makeIntent({
      type: 'start_shopping_session', confidence: 0.8,
      parameters: { goal: 'save_money', hasList: true, items: 'milk' },
    });

    const result = await dispatchIntent(intent, {}, deps);

    const data = result.data as { recommendationExplanation?: { savingsReasons?: unknown[] } };
    // makePlanResponseWithCandidates' one candidate has a real, positive
    // estimatedSavings (8.42, per this describe block's own fixture) —
    // real evidence, so a real savings reason must appear.
    expect(data.recommendationExplanation?.savingsReasons?.length).toBeGreaterThan(0);
  });

  test('Phase 5.3 Part 2: a remembered optimizationPreference of "cheapest" skips the goal question entirely', async () => {
    await setOptimizationPreference('shopper@example.com', 'cheapest');
    const deps = baseDeps();
    const intent = makeIntent({ type: 'start_shopping_session', confidence: 0.8, parameters: {} });

    const result = await dispatchIntent(intent, {}, deps);

    // No goal was stated, yet the flow moves straight to the NEXT
    // question (hasList) instead of asking "what are you optimizing
    // for" — proving the remembered preference supplied a real default.
    expect(result.missingField).toBe('hasList');
    expect(getPendingConversation()?.collectedParameters.goal).toBe('save_money');
  });

  test('Phase 5.3 Part 2: an explicit goal stated THIS turn always wins over a remembered optimizationPreference', async () => {
    await setOptimizationPreference('shopper@example.com', 'cheapest');
    const deps = baseDeps();
    const intent = makeIntent({ type: 'start_shopping_session', confidence: 0.8, parameters: { goal: 'meal_plan' } });

    const result = await dispatchIntent(intent, {}, deps);

    expect(result.missingField).toBe('hasList');
    expect(getPendingConversation()?.collectedParameters.goal).toBe('meal_plan'); // not the remembered 'save_money'
  });

  test('Phase 5.3 Part 5: "show my previous sessions" returns real, already-stored history and never touches the optimizer', async () => {
    const deps = baseDeps({ optimizeCart: jest.fn().mockResolvedValue(makePlanResponseWithCandidates()) });
    // Complete one real session first, so there is real history to show.
    await dispatchIntent(makeIntent({
      type: 'start_shopping_session', confidence: 0.8,
      parameters: { goal: 'save_money', hasList: true, items: 'milk, eggs' },
    }), {}, deps);
    (deps.optimizeCart as jest.Mock).mockClear();

    const intent = makeIntent({ type: 'start_shopping_session', confidence: 0.8, parameters: { showHistory: true } });
    const result = await dispatchIntent(intent, {}, deps);

    expect(result.success).toBe(true);
    const data = result.data as { action: string; sessions: { itemCount: number; goal: string }[] };
    expect(data.action).toBe('shopping_history_result');
    expect(data.sessions.length).toBeGreaterThan(0);
    expect(data.sessions[0].itemCount).toBe(2);
    expect(deps.optimizeCart).not.toHaveBeenCalled();
  });

  test('Phase 5.3 Part 5: showHistory with no prior sessions returns an honest empty list, never fabricated history', async () => {
    const deps = baseDeps();
    const intent = makeIntent({ type: 'start_shopping_session', confidence: 0.8, parameters: { showHistory: true } });

    const result = await dispatchIntent(intent, {}, deps);

    expect(result.success).toBe(true);
    const data = result.data as { sessions: unknown[] };
    expect(data.sessions).toEqual([]);
  });

  test('Phase 5.5 Part 3: a shopper\'s very first session gets no historyComparison — no real prior data to compare against', async () => {
    const deps = baseDeps({ optimizeCart: jest.fn().mockResolvedValue(makePlanResponseWithCandidates()) });
    const intent = makeIntent({
      type: 'start_shopping_session', confidence: 0.8,
      parameters: { goal: 'save_money', hasList: true, items: 'milk' },
    });

    const result = await dispatchIntent(intent, {}, deps);

    const data = result.data as { historyComparison?: unknown };
    expect(data.historyComparison).toBeUndefined();
  });

  test('Phase 5.5 Part 3: a second session gets a real historyComparison against the first session\'s real estimatedSavings', async () => {
    const deps = baseDeps({ optimizeCart: jest.fn().mockResolvedValue(makePlanResponseWithCandidates()) });
    // Complete one real session first, so there's real prior history —
    // both sessions use the exact same fixture candidate (estimatedSavings 8.42).
    await dispatchIntent(makeIntent({
      type: 'start_shopping_session', confidence: 0.8,
      parameters: { goal: 'save_money', hasList: true, items: 'milk, eggs' },
    }), {}, deps);

    const intent = makeIntent({
      type: 'start_shopping_session', confidence: 0.8,
      parameters: { goal: 'save_money', hasList: true, items: 'bread' },
    });
    const result = await dispatchIntent(intent, {}, deps);

    const data = result.data as { historyComparison?: { currentSavings: number; averageSavings: number; sessionCount: number; percentBetter?: number } };
    expect(data.historyComparison).toEqual({ currentSavings: 8.42, averageSavings: 8.42, sessionCount: 1, percentBetter: 0 });
  });
});

describe('dispatchIntent — update_preferences (Phase 5.2)', () => {
  test('a real, recognized field/value pair updates the stored preference and returns it', async () => {
    const deps = baseDeps();
    const intent = makeIntent({ type: 'update_preferences', confidence: 0.7, parameters: { field: 'preferredStores', value: 'Aldi' } });

    const result = await dispatchIntent(intent, {}, deps);

    expect(result.success).toBe(true);
    const data = result.data as { action: string; preferences: { preferredStores?: string[] } };
    expect(data.action).toBe('preference_update_result');
    expect(data.preferences.preferredStores).toEqual(['Aldi']);
    expect(await getPreferences('shopper@example.com')).toEqual({ preferredStores: ['Aldi'] });
  });

  test('missing or unrecognized field/value never writes anything and reports honestly', async () => {
    const deps = baseDeps();
    const intent = makeIntent({ type: 'update_preferences', confidence: 0.7, parameters: {} });

    const result = await dispatchIntent(intent, {}, deps);

    expect(result.success).toBe(false);
    expect(result.error).toContain('not sure what to remember');
    expect(await getPreferences('shopper@example.com')).toEqual({});
  });

  test('this intent can never touch the cart, search, or the optimizer — it has no such dependency call', async () => {
    const deps = baseDeps();
    const intent = makeIntent({ type: 'update_preferences', confidence: 0.7, parameters: { field: 'optimizationPreference', value: 'healthiest' } });

    await dispatchIntent(intent, {}, deps);

    expect(deps.search).not.toHaveBeenCalled();
    expect(deps.optimizeCart).not.toHaveBeenCalled();
    expect(deps.addToCart).not.toHaveBeenCalled();
    expect(deps.removeFromCart).not.toHaveBeenCalled();
  });

  test('an out-of-allowlist field is rejected even if it was somehow present in parameters', async () => {
    const deps = baseDeps();
    const intent = makeIntent({ type: 'update_preferences', confidence: 0.7, parameters: { field: 'weeklyBudget', value: 500 } });

    const result = await dispatchIntent(intent, {}, deps);

    expect(result.success).toBe(false);
    expect(await getPreferences('shopper@example.com')).toEqual({});
  });
});

import { runAssistant, type AssistantServiceDependencies } from '../assistantService';
import { dispatchIntent } from '../assistantDispatcher';
import { getPendingClarification, clearPendingClarification } from '../clarificationStore';
import {
  createPendingCartMutationConfirmation, createPendingProductSelection, getPendingCartMutationConfirmation,
  getPendingProductSelection, clearPendingCartMutationConfirmation, clearPendingProductSelection,
} from '../productSelectionStore';
import { createPendingConversation, getPendingConversation, clearPendingConversation } from '../assistantConversationStore';
import type { ApiProduct, PlanCandidate, ShoppingPlanResponse } from '../../models/types';
import type { AssistantActionResult, AssistantSessionContext, Intent } from '../../models/intent';
import { clearAllSessions } from '../assistantShoppingSessionStore';

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));

/**
 * Uses dependency injection (see assistantService.ts's `deps` param) —
 * `resolveIntent` and `dispatch` are both swappable, so these tests never
 * touch the network or AsyncStorage.
 *
 * Phase 4.2 note: `runAssistant` now runs clarificationPolicy.ts's
 * `evaluateClarificationPolicy` BEFORE calling `deps.dispatch` at all.
 * Several tests below use the REAL `dispatchIntent` as `dispatch` to
 * prove intentPolicy.ts's own gates are still intact and unchanged — but
 * for intents the NEW upstream clarification layer already blocks (e.g.
 * a bare low-confidence `search`, or `unknown`), `dispatchIntent` is
 * never actually invoked at all now; the assertions on the resulting
 * `AssistantOutcome` still hold either way (see clarificationPolicy.ts
 * and assistantDispatcher.test.ts, which independently re-confirms
 * dispatchIntent's own internal gates on their own, unaffected by
 * anything in this file).
 */

function makeIntent(overrides: Partial<Intent> = {}): Intent {
  return { type: 'search', confidence: 0.8, parameters: {}, ...overrides };
}

function makeResult(overrides: Partial<AssistantActionResult> = {}): AssistantActionResult {
  return { success: true, intent: makeIntent(), ...overrides };
}

function makeProduct(id: string, name = `Product ${id}`): ApiProduct {
  return { id, name, brand: 'Brand', price: 3, rating: 4, size: '1 ea', store: 'Kroger' };
}

afterEach(async () => {
  clearPendingClarification();
  clearPendingCartMutationConfirmation();
  clearPendingProductSelection();
  clearPendingConversation();
  await clearAllSessions('shopper@example.com');
});

describe('runAssistant — orchestration order', () => {
  test('calls resolveIntent before dispatch, and passes dispatch the exact intent resolveIntent returned', async () => {
    const calls: string[] = [];
    const intent = makeIntent({ type: 'search', parameters: { query: 'milk' } });
    const deps: AssistantServiceDependencies = {
      resolveIntent: jest.fn(async () => {
        calls.push('resolveIntent');
        return intent;
      }),
      dispatch: jest.fn(async (receivedIntent) => {
        calls.push('dispatch');
        expect(receivedIntent).toBe(intent);
        return makeResult({ intent: receivedIntent });
      }),
    };

    await runAssistant('find milk', {}, deps);

    expect(calls).toEqual(['resolveIntent', 'dispatch']);
  });

  test('passes the session context through to dispatch unchanged', async () => {
    const context = { currentScreen: 'Cart', cartSize: 3 };
    const deps: AssistantServiceDependencies = {
      // A real query is required here — a bare `makeIntent()` (no
      // query) would now be caught by the new clarification gate before
      // dispatch is ever reached, which isn't what this test is about.
      resolveIntent: jest.fn().mockResolvedValue(makeIntent({ parameters: { query: 'milk' } })),
      dispatch: jest.fn().mockResolvedValue(makeResult()),
    };

    await runAssistant('optimize my cart', context, deps);

    expect(deps.dispatch).toHaveBeenCalledWith(expect.anything(), context);
  });
});

describe('runAssistant — blocked intent never executes', () => {
  test('a low-confidence resolved intent is blocked (by the new clarification gate) and never reaches dispatch', async () => {
    const dispatchSpy = jest.fn(dispatchIntent);
    const deps: AssistantServiceDependencies = {
      resolveIntent: jest.fn().mockResolvedValue(makeIntent({ type: 'search', confidence: 0.3, parameters: { query: 'milk' } })),
      dispatch: dispatchSpy,
    };

    const outcome = await runAssistant('find milk', {}, deps);

    expect(outcome.success).toBe(false);
    expect(outcome.errorType).toBe('blocked_intent');
    expect(outcome.type).toBe('clarification_required');
    expect(outcome.clarification).toBeTruthy();
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  test('a real intent blocked for missing session context (optimize_cart with no cart) still reaches and is blocked by dispatchIntent itself', async () => {
    const deps: AssistantServiceDependencies = {
      resolveIntent: jest.fn().mockResolvedValue(makeIntent({ type: 'optimize_cart', confidence: 0.9, parameters: {} })),
      dispatch: dispatchIntent, // the real dispatcher — clarificationPolicy has no extra check for optimize_cart, so this proves dispatchIntent's own gate still fires
    };

    const outcome = await runAssistant('optimize my cart', {}, deps); // no cartSize in context

    expect(outcome.success).toBe(false);
    expect(outcome.errorType).toBe('blocked_intent');
    expect(outcome.type).toBe('clarification_required');
  });
});

describe('runAssistant — supported intent reaches dispatcher', () => {
  test('a high-confidence, supported intent is dispatched and its real result is returned', async () => {
    const successResult = makeResult({ success: true, data: { products: [], storeStatuses: [] } });
    const deps: AssistantServiceDependencies = {
      resolveIntent: jest.fn().mockResolvedValue(makeIntent({ type: 'search', confidence: 0.8, parameters: { query: 'milk' } })),
      dispatch: jest.fn().mockResolvedValue(successResult),
    };

    const outcome = await runAssistant('find milk', {}, deps);

    expect(deps.dispatch).toHaveBeenCalled();
    expect(outcome).toEqual(successResult);
    expect(outcome.errorType).toBeUndefined();
  });

  test('4. "find milk" executes search — a valid query never triggers clarification', async () => {
    const deps: AssistantServiceDependencies = {
      resolveIntent: jest.fn().mockResolvedValue(makeIntent({ type: 'search', confidence: 0.8, parameters: { query: 'milk' } })),
      dispatch: dispatchIntent,
    };

    const outcome = await runAssistant('find milk', {}, deps);

    expect(outcome.type).toBeUndefined();
  });
});

describe('runAssistant — error classification', () => {
  test('a network failure resolving the intent never throws, and classifies as network_error', async () => {
    const deps: AssistantServiceDependencies = {
      resolveIntent: jest.fn().mockRejectedValue(new Error('network down')),
      dispatch: jest.fn(),
    };

    const outcome = await runAssistant('find milk', {}, deps);

    expect(outcome.success).toBe(false);
    expect(outcome.errorType).toBe('network_error');
    expect(outcome.error).toContain('network down');
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  test('2. An unknown intent classifies as unknown_intent and never reaches dispatch', async () => {
    const dispatchSpy = jest.fn(dispatchIntent);
    const deps: AssistantServiceDependencies = {
      resolveIntent: jest.fn().mockResolvedValue(makeIntent({ type: 'unknown', confidence: 0, parameters: {} })),
      dispatch: dispatchSpy,
    };

    const outcome = await runAssistant('asdf qwerty', {}, deps);

    expect(outcome.success).toBe(false);
    expect(outcome.errorType).toBe('unknown_intent');
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  test('Phase 5.2: set_budget_target now succeeds — a real, local preference write, never account/cart state', async () => {
    const deps: AssistantServiceDependencies = {
      resolveIntent: jest.fn().mockResolvedValue(makeIntent({ type: 'set_budget_target', confidence: 0.9, parameters: { amount: 100 } })),
      dispatch: dispatchIntent,
    };

    const outcome = await runAssistant('set my budget to 100', {}, deps);

    expect(outcome.success).toBe(true);
    expect(outcome.errorType).toBeUndefined();
    expect(outcome.type).toBeUndefined();
  });
});

describe('runAssistant — clarification flow (Phase 4.2)', () => {
  test('3. "add" with NO item at all requires clarification and never reaches dispatch', async () => {
    const dispatchSpy = jest.fn(dispatchIntent);
    const deps: AssistantServiceDependencies = {
      resolveIntent: jest.fn().mockResolvedValue(makeIntent({ type: 'add_to_cart', confidence: 0.8, parameters: {} })),
      dispatch: dispatchSpy,
    };

    const outcome = await runAssistant('add something', {}, deps);

    expect(outcome.success).toBe(false);
    expect(outcome.type).toBe('clarification_required');
    expect(outcome.clarification?.message).toContain('product');
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  test('Phase 4.3: "add milk" (item text present) now PROCEEDS past clarificationPolicy to real product resolution', async () => {
    const deps: AssistantServiceDependencies = {
      resolveIntent: jest.fn().mockResolvedValue(makeIntent({ type: 'add_to_cart', confidence: 0.85, parameters: { item: 'milk' } })),
      dispatch: dispatchIntent, // real dispatcher, real product resolution
    };

    const outcome = await runAssistant('add milk', { activeQuery: 'milk' }, deps);

    // Never a plain 'clarification_required' anymore for this case — it's
    // now the more specific product_selection_required/confirmation_required
    // flow (see assistantDispatcher.test.ts for the full resolution matrix).
    expect(outcome.type).not.toBe('clarification_required');
  });

  test('5. "set budget to 50" (a valid amount) proceeds to dispatch, no clarification', async () => {
    const successResult = makeResult({ success: true, intent: makeIntent({ type: 'set_budget_target' }) });
    const deps: AssistantServiceDependencies = {
      resolveIntent: jest.fn().mockResolvedValue(makeIntent({ type: 'set_budget_target', confidence: 0.9, parameters: { amount: 50 } })),
      dispatch: jest.fn().mockResolvedValue(successResult),
    };

    const outcome = await runAssistant('set budget to 50', {}, deps);

    expect(outcome.type).toBeUndefined();
    expect(deps.dispatch).toHaveBeenCalled();
  });

  test('6. Phase 5.3: "set budget" with no amount reaches the REAL dispatcher, which asks a real, merge-capable follow-up', async () => {
    // Unlike Phase 4.2's original version of this test, this intent no
    // longer gets blocked upstream by clarificationPolicy — it PROCEEDs
    // (see clarificationPolicy.ts's Phase 5.3 comment) and
    // dispatchSetBudgetTarget itself asks the real question, exactly
    // like meal_plan's own mealCount follow-up.
    const dispatchSpy = jest.fn(dispatchIntent);
    const deps: AssistantServiceDependencies = {
      resolveIntent: jest.fn().mockResolvedValue(makeIntent({ type: 'set_budget_target', confidence: 0.9, parameters: {} })),
      dispatch: dispatchSpy,
    };

    const outcome = await runAssistant('set budget', {}, deps);

    expect(outcome.type).toBe('clarification_required');
    expect(outcome.clarification?.message.toLowerCase()).toContain('budget');
    expect(dispatchSpy).toHaveBeenCalled();
  });

  test('9. A clarification-required outcome (no item at all) never bypasses the dispatcher, under any circumstance', async () => {
    const dispatchSpy = jest.fn(dispatchIntent);
    const deps: AssistantServiceDependencies = {
      resolveIntent: jest.fn().mockResolvedValue(makeIntent({ type: 'remove_from_cart', confidence: 0.8, parameters: {} })),
      dispatch: dispatchSpy,
    };

    const outcome = await runAssistant('remove something', { cartSize: 5 }, deps);

    expect(outcome.type).toBe('clarification_required');
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  test('a clarification-required outcome registers a real PendingClarification in the store', async () => {
    const deps: AssistantServiceDependencies = {
      resolveIntent: jest.fn().mockResolvedValue(makeIntent({ type: 'add_to_cart', confidence: 0.8, parameters: {} })),
      dispatch: jest.fn(),
    };

    expect(getPendingClarification()).toBeUndefined();
    await runAssistant('add something', {}, deps);

    const pending = getPendingClarification();
    expect(pending).toBeTruthy();
    expect(pending?.originalText).toBe('add something');
    expect(pending?.intentCandidate.type).toBe('add_to_cart');
  });

  test('a successfully dispatched intent does NOT leave a pending clarification behind', async () => {
    const deps: AssistantServiceDependencies = {
      resolveIntent: jest.fn().mockResolvedValue(makeIntent({ type: 'search', confidence: 0.8, parameters: { query: 'milk' } })),
      dispatch: jest.fn().mockResolvedValue(makeResult({ success: true })),
    };

    await runAssistant('find milk', {}, deps);

    expect(getPendingClarification()).toBeUndefined();
  });
});

describe('runAssistant — product selection & confirmation follow-ups (Phase 4.3)', () => {
  const originalIntent = makeIntent({ type: 'add_to_cart', confidence: 0.85, parameters: { item: 'milk' } });
  const organic = makeProduct('organic', 'Organic Whole Milk');
  const storeBrand = makeProduct('store-brand', 'Store Brand Whole Milk');

  test('9. "add milk" -> "the organic one" selects the matching candidate and asks for confirmation, without dispatching', async () => {
    createPendingProductSelection({ originalIntent, query: 'milk', candidates: [organic, storeBrand] });
    const dispatchSpy = jest.fn();
    const deps: AssistantServiceDependencies = { resolveIntent: jest.fn(), dispatch: dispatchSpy };

    const outcome = await runAssistant('the organic one', {}, deps);

    expect(dispatchSpy).not.toHaveBeenCalled(); // selecting a candidate never itself dispatches
    expect(outcome.type).toBe('confirmation_required');
    const confirmation = getPendingCartMutationConfirmation();
    expect(confirmation?.product.id).toBe('organic');
    expect(confirmation?.action).toBe('add_to_cart');
    expect(getPendingProductSelection()).toBeUndefined(); // selection consumed
  });

  test('an unmatched follow-up drops the stale selection rather than guessing', async () => {
    createPendingProductSelection({ originalIntent, query: 'milk', candidates: [organic, storeBrand] });
    const deps: AssistantServiceDependencies = {
      resolveIntent: jest.fn().mockResolvedValue(makeIntent({ type: 'unknown', confidence: 0, parameters: {} })),
      dispatch: jest.fn(),
    };

    await runAssistant('completely unrelated gibberish', {}, deps);

    expect(getPendingProductSelection()).toBeUndefined();
    expect(getPendingCartMutationConfirmation()).toBeUndefined();
  });

  test('10. A resolved single product still requires confirmation before dispatch executes — never automatic', async () => {
    // Simulated by dispatchAddToCart itself (see assistantDispatcher.test.ts)
    // — this test confirms runAssistant's own normal-pipeline path
    // surfaces that pendingType correctly and never calls dispatch again
    // on its own initiative.
    const deps: AssistantServiceDependencies = {
      resolveIntent: jest.fn().mockResolvedValue(originalIntent),
      dispatch: jest.fn().mockResolvedValue({
        success: false,
        intent: originalIntent,
        pendingType: 'confirmation_required',
        data: { action: 'confirmation_required', mutationAction: 'add_to_cart', product: organic },
      }),
    };

    const outcome = await runAssistant('add milk', { activeQuery: 'milk' }, deps);

    expect(outcome.type).toBe('confirmation_required');
    expect(outcome.success).toBe(false);
  });

  test('11. "yes add it" after a pending confirmation re-dispatches the ORIGINAL intent and executes the real mutation', async () => {
    createPendingCartMutationConfirmation({ action: 'add_to_cart', product: organic, originalIntent });
    const dispatchSpy = jest.fn().mockResolvedValue({
      success: true,
      intent: originalIntent,
      data: { action: 'added_to_cart', product: organic },
    });
    const deps: AssistantServiceDependencies = { resolveIntent: jest.fn(), dispatch: dispatchSpy };

    const outcome = await runAssistant('yes add it', {}, deps);

    expect(dispatchSpy).toHaveBeenCalledWith(originalIntent, {});
    expect(outcome.success).toBe(true);
    expect(deps.resolveIntent).not.toHaveBeenCalled(); // "yes add it" is never re-classified as a fresh intent
  });

  test('declining ("no") clears the pending confirmation and never dispatches', async () => {
    createPendingCartMutationConfirmation({ action: 'add_to_cart', product: organic, originalIntent });
    const dispatchSpy = jest.fn();
    const deps: AssistantServiceDependencies = { resolveIntent: jest.fn(), dispatch: dispatchSpy };

    const outcome = await runAssistant('no, cancel that', {}, deps);

    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(outcome.success).toBe(false);
    expect(getPendingCartMutationConfirmation()).toBeUndefined();
  });

  test('an unclear response to a pending confirmation never assumes yes, and clears the stale confirmation', async () => {
    createPendingCartMutationConfirmation({ action: 'add_to_cart', product: organic, originalIntent });
    const dispatchSpy = jest.fn();
    const deps: AssistantServiceDependencies = {
      resolveIntent: jest.fn().mockResolvedValue(makeIntent({ type: 'unknown', confidence: 0, parameters: {} })),
      dispatch: dispatchSpy,
    };

    await runAssistant('what time is it', {}, deps);

    expect(dispatchSpy).not.toHaveBeenCalled(); // never treated as an implicit "yes"
    expect(getPendingCartMutationConfirmation()).toBeUndefined();
  });

  test('7. A selected product always originates from the real candidates list, never fabricated', async () => {
    createPendingProductSelection({ originalIntent, query: 'milk', candidates: [organic, storeBrand] });
    const deps: AssistantServiceDependencies = { resolveIntent: jest.fn(), dispatch: jest.fn() };

    await runAssistant('store brand please', {}, deps);

    const confirmation = getPendingCartMutationConfirmation();
    expect([organic.id, storeBrand.id]).toContain(confirmation?.product.id);
    expect(confirmation?.product).toBe(storeBrand); // exact same object reference from the original candidates array
  });

  test('8. An expired pending product selection is rejected — treated as if it never existed', async () => {
    const realNow = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(realNow);
    createPendingProductSelection({ originalIntent, query: 'milk', candidates: [organic, storeBrand] });

    jest.spyOn(Date, 'now').mockReturnValue(realNow + 10 * 60 * 1000); // well past the TTL

    const deps: AssistantServiceDependencies = {
      resolveIntent: jest.fn().mockResolvedValue(makeIntent({ type: 'unknown', confidence: 0, parameters: {} })),
      dispatch: jest.fn(),
    };
    await runAssistant('the organic one', {}, deps);

    // Treated as a brand-new, unrelated request — resolveIntent WAS
    // called this time, unlike the live-selection case above.
    expect(deps.resolveIntent).toHaveBeenCalled();

    jest.restoreAllMocks();
  });

  test('12. Existing (non-cart) assistant flows are entirely unaffected by any of this pending state', async () => {
    const deps: AssistantServiceDependencies = {
      resolveIntent: jest.fn().mockResolvedValue(makeIntent({ type: 'search', confidence: 0.8, parameters: { query: 'milk' } })),
      dispatch: jest.fn().mockResolvedValue(makeResult({ success: true, data: { products: [], storeStatuses: [] } })),
    };

    const outcome = await runAssistant('find milk', {}, deps);

    expect(outcome.success).toBe(true);
    expect(getPendingProductSelection()).toBeUndefined();
    expect(getPendingCartMutationConfirmation()).toBeUndefined();
  });
});

describe('runAssistant — multi-turn conversation follow-ups (Phase 5.0)', () => {
  test('"Plan dinners for this week" (no mealCount) asks a real follow-up question and never reaches dispatch again on its own', async () => {
    const dispatchSpy = jest.fn(dispatchIntent);
    const deps: AssistantServiceDependencies = {
      resolveIntent: jest.fn().mockResolvedValue(makeIntent({ type: 'meal_plan', confidence: 0.8, parameters: { mealType: 'dinner' } })),
      dispatch: dispatchSpy,
    };

    const outcome = await runAssistant('Plan dinners for this week', {}, deps);

    expect(outcome.success).toBe(false);
    expect(outcome.type).toBe('clarification_required');
    expect(outcome.clarification?.message).toBe('How many meals should I plan for?');
    expect(dispatchSpy).toHaveBeenCalledTimes(1); // the real dispatcher IS called once (and creates the pending conversation)
    expect(getPendingConversation()?.missingField).toBe('mealCount');
    expect(getPendingConversation()?.collectedParameters.mealType).toBe('dinner');
  });

  test('a follow-up answer ("5 dinners") is merged into the ORIGINAL intent and re-dispatched — never re-classified from scratch', async () => {
    const pendingIntent = makeIntent({ type: 'meal_plan', confidence: 0.8, parameters: { mealType: 'dinner' } });
    const dispatchSpy = jest.fn().mockResolvedValue(
      makeResult({ success: true, intent: pendingIntent, data: { action: 'meal_plan_result', meals: [], groceryItems: [], pantryAdditions: [] } }),
    );
    const resolveIntentSpy = jest.fn();
    const deps: AssistantServiceDependencies = { resolveIntent: resolveIntentSpy, dispatch: dispatchSpy };

    // Real dispatcher run creates the pending conversation (mirrors what
    // the previous test verified in isolation) — this test focuses on the
    // merge step itself using a fake dispatch to inspect exactly what
    // gets passed to it.
    createPendingConversation({
      pendingIntent, pendingQuestion: 'How many meals should I plan for?',
      collectedParameters: { mealType: 'dinner' }, missingField: 'mealCount',
    });

    const outcome = await runAssistant('5 dinners', {}, deps);

    expect(resolveIntentSpy).not.toHaveBeenCalled(); // never re-classified
    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'meal_plan', parameters: { mealType: 'dinner', mealCount: 5 } }),
      {},
    );
    expect(outcome.success).toBe(true);
    expect(getPendingConversation()).toBeUndefined(); // consumed, not left behind
  });

  test('Phase 5.1: "Help me save money this week" -> "Save money" -> "Yes" -> real items completes a full shopping session', async () => {
    // Uses the REAL dispatchIntent -> dispatchStartShoppingSession chain
    // throughout (same DI convention as voiceAssistantService.test.ts's
    // own "add milk" safety test) — only leaf I/O (search/network/zipcode)
    // is faked.
    const candidate: PlanCandidate = {
      id: 'cheapest', label: 'Cheapest', storeAssignments: [], totalCost: 40, estimatedGasCost: 2,
      estimatedSavings: 8.42, totalDriveMinutes: 12, totalDriveMiles: 5, storeCount: 2, itemsFound: 3, itemsTotal: 3,
      tripPlan: { origin: { latitude: 0, longitude: 0 }, totalDurationMinutes: 12, totalDistanceMiles: 5, routeGeometry: { type: 'LineString', coordinates: [] }, stops: [] },
    };
    const planResponse: ShoppingPlanResponse = { candidates: [candidate], recommendedId: 'cheapest', unresolvedItems: [] };
    const optimizeCartSpy = jest.fn().mockResolvedValue(planResponse);
    const dispatch = (intent: Intent, context?: AssistantSessionContext) =>
      dispatchIntent(intent, context, {
        search: jest.fn(),
        optimizeCart: optimizeCartSpy,
        getZipcode: () => '78701',
        getCartItems: () => [],
        addToCart: jest.fn(),
        removeFromCart: jest.fn(),
        generateMealPlan: jest.fn(),
        getLowStockItems: jest.fn().mockResolvedValue([]),
        getOwnerEmail: () => 'shopper@example.com',
      });

    const turn1 = await runAssistant('Help me save money this week', {}, {
      resolveIntent: jest.fn().mockResolvedValue(makeIntent({ type: 'start_shopping_session', confidence: 0.8, parameters: {} })),
      dispatch,
    });
    expect(turn1.type).toBe('clarification_required');
    expect(turn1.clarification?.message).toContain('optimize');
    expect(turn1.missingField).toBe('goal');

    const turn2 = await runAssistant('Save money', {}, { resolveIntent: jest.fn(), dispatch });
    expect(turn2.missingField).toBe('hasList');

    const turn3 = await runAssistant('Yes', {}, { resolveIntent: jest.fn(), dispatch });
    expect(turn3.missingField).toBe('items');

    const turn4 = await runAssistant('milk, eggs, bread', {}, { resolveIntent: jest.fn(), dispatch });
    expect(turn4.success).toBe(true);
    expect(optimizeCartSpy).toHaveBeenCalledTimes(1);
    const data = turn4.data as { action: string; goal: string; explanation: string };
    expect(data.action).toBe('shopping_session_plan');
    expect(data.goal).toBe('save_money');
    expect(data.explanation).toContain('Cheapest');
  });

  test('Phase 5.1: an explicit budget statement ("keep groceries under $100") is never guessed — it is only ever the real, extracted number', async () => {
    const dispatchSpy = jest.fn(dispatchIntent);
    const deps: AssistantServiceDependencies = {
      resolveIntent: jest.fn().mockResolvedValue(makeIntent({ type: 'start_shopping_session', confidence: 0.8, parameters: { budgetTarget: 100 } })),
      dispatch: dispatchSpy,
    };

    const outcome = await runAssistant('keep groceries under $100', {}, deps);

    // Still asks for goal first — a stated budget never skips the real,
    // explicit questions this flow requires.
    expect(outcome.missingField).toBe('goal');
    expect(getPendingConversation()?.collectedParameters.budgetTarget).toBe(100);
  });

  test('a follow-up that cannot be parsed for the missing field asks the same question again, never guessing', async () => {
    const pendingIntent = makeIntent({ type: 'meal_plan', confidence: 0.8, parameters: { mealType: 'dinner' } });
    createPendingConversation({
      pendingIntent, pendingQuestion: 'How many meals should I plan for?',
      collectedParameters: { mealType: 'dinner' }, missingField: 'mealCount',
    });
    const dispatchSpy = jest.fn();
    const deps: AssistantServiceDependencies = { resolveIntent: jest.fn(), dispatch: dispatchSpy };

    const outcome = await runAssistant('not sure yet', {}, deps);

    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(outcome.type).toBe('clarification_required');
    expect(outcome.clarification?.message).toBe('How many meals should I plan for?');
    expect(getPendingConversation()).toBeTruthy(); // kept, not dropped — a real chance to answer remains
  });
});

describe('runAssistant — update_preferences safety (Phase 5.2)', () => {
  test('"Remember I prefer Aldi" goes end-to-end through the REAL dispatcher and never calls addToCart/removeFromCart/optimizeCart', async () => {
    const addToCartSpy = jest.fn();
    const removeFromCartSpy = jest.fn();
    const optimizeCartSpy = jest.fn();
    const deps: AssistantServiceDependencies = {
      resolveIntent: jest.fn().mockResolvedValue(makeIntent({ type: 'update_preferences', confidence: 0.7, parameters: { field: 'preferredStores', value: 'Aldi' } })),
      dispatch: (intent, context) => dispatchIntent(intent, context, {
        search: jest.fn(),
        optimizeCart: optimizeCartSpy,
        getZipcode: () => '78701',
        getCartItems: () => [],
        addToCart: addToCartSpy,
        removeFromCart: removeFromCartSpy,
        generateMealPlan: jest.fn(),
        getLowStockItems: jest.fn().mockResolvedValue([]),
        getOwnerEmail: () => 'shopper@example.com',
      }),
    };

    const outcome = await runAssistant('Remember I prefer Aldi', {}, deps);

    expect(outcome.success).toBe(true);
    expect(addToCartSpy).not.toHaveBeenCalled();
    expect(removeFromCartSpy).not.toHaveBeenCalled();
    expect(optimizeCartSpy).not.toHaveBeenCalled();
  });
});

describe('runAssistant — conversation update extraction, targeted only (Phase 5.3 Part 4)', () => {
  test('"What would you like to set your budget to?" -> "under $100" resolves the ACTIVE pending field correctly', async () => {
    const pendingIntent = makeIntent({ type: 'set_budget_target', confidence: 0.9, parameters: {} });
    createPendingConversation({
      pendingIntent, pendingQuestion: 'What would you like to set your budget to?',
      collectedParameters: {}, missingField: 'amount',
    });
    const dispatchSpy = jest.fn().mockResolvedValue(makeResult({ success: true }));
    const deps: AssistantServiceDependencies = { resolveIntent: jest.fn(), dispatch: dispatchSpy };

    await runAssistant('under $100', {}, deps);

    expect(dispatchSpy).toHaveBeenCalledWith(expect.objectContaining({ parameters: { amount: 100 } }), {});
  });

  test('a compound reply ("Actually keep it under $100 and use Aldi") only ever updates the ACTIVE pending field — never an unrelated preference change', async () => {
    const pendingIntent = makeIntent({ type: 'set_budget_target', confidence: 0.9, parameters: {} });
    createPendingConversation({
      pendingIntent, pendingQuestion: 'What would you like to set your budget to?',
      collectedParameters: {}, missingField: 'amount',
    });
    const dispatchSpy = jest.fn().mockResolvedValue(makeResult({ success: true }));
    const deps: AssistantServiceDependencies = { resolveIntent: jest.fn(), dispatch: dispatchSpy };

    await runAssistant('Actually keep it under $100 and use Aldi', {}, deps);

    // Only `amount` was ever merged in — "and use Aldi" was never
    // inspected for a store preference, and resolveIntent (the only
    // path that could ever classify a fresh update_preferences intent)
    // was never even called.
    expect(dispatchSpy).toHaveBeenCalledWith(expect.objectContaining({ parameters: { amount: 100 } }), {});
    expect(deps.resolveIntent).not.toHaveBeenCalled();
  });

  test('while "items" is the active pending field, a phrase that would otherwise match update_preferences ("I like Aldi") is taken literally as item text, never as a preference change', async () => {
    const pendingIntent = makeIntent({ type: 'start_shopping_session', confidence: 0.8, parameters: { goal: 'save_money', hasList: true } });
    createPendingConversation({
      pendingIntent, pendingQuestion: 'Go ahead and enter your items.',
      collectedParameters: { goal: 'save_money', hasList: true }, missingField: 'items',
    });
    const dispatchSpy = jest.fn().mockResolvedValue(makeResult({ success: true }));
    const deps: AssistantServiceDependencies = { resolveIntent: jest.fn(), dispatch: dispatchSpy };

    await runAssistant('I like Aldi', {}, deps);

    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ parameters: { goal: 'save_money', hasList: true, items: 'I like Aldi' } }),
      {},
    );
    expect(deps.resolveIntent).not.toHaveBeenCalled(); // never re-classified as a fresh update_preferences statement
  });

  test('existing cart-confirmation and product-selection flows are entirely unaffected by the new conversation-merge case', async () => {
    // Regression guard: adding the 'amount' case to extractParameterValue
    // must not change how 'yes'/'no' or candidate-name follow-ups are
    // handled for the pre-existing pending states.
    const originalIntent = makeIntent({ type: 'add_to_cart', confidence: 0.85, parameters: { item: 'milk' } });
    const organic = makeProduct('organic', 'Organic Whole Milk');
    createPendingCartMutationConfirmation({ action: 'add_to_cart', product: organic, originalIntent });
    const dispatchSpy = jest.fn().mockResolvedValue({ success: true, intent: originalIntent, data: { action: 'added_to_cart', product: organic } });
    const deps: AssistantServiceDependencies = { resolveIntent: jest.fn(), dispatch: dispatchSpy };

    const outcome = await runAssistant('yes add it', {}, deps);

    expect(dispatchSpy).toHaveBeenCalledWith(originalIntent, {});
    expect(outcome.success).toBe(true);
  });
});

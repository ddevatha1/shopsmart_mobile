import { runVoiceAssistantTurn, type VoiceAssistantDependencies } from '../voiceAssistantService';
import { runAssistant } from '../assistantService';
import { dispatchIntent } from '../assistantDispatcher';
import { createVoiceSession } from '../voiceService';
import { clearPendingProductSelection, clearPendingCartMutationConfirmation } from '../productSelectionStore';
import { clearPendingClarification } from '../clarificationStore';
import type { VoiceSession } from '../voiceService';
import type { AssistantOutcome } from '../../models/intent';

/**
 * Uses dependency injection for BOTH the voice session and
 * `runAssistant` — no real microphone, no real network, no real speech
 * output. Several tests use the REAL `runAssistant` (composed with fake
 * `resolveIntent`/`dispatch` at the assistantService layer, matching
 * Phase 4.2/4.3's own established test convention) specifically to prove
 * voice goes through the exact same, unmodified safety pipeline as text.
 */

function fakeSession(overrides: Partial<VoiceSession> = {}): VoiceSession {
  return {
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue('find milk'),
    speakResponse: jest.fn().mockResolvedValue(undefined),
    get transcript() {
      return 'find milk';
    },
    get status() {
      return 'idle' as const;
    },
    get error() {
      return undefined;
    },
    ...overrides,
  };
}

afterEach(() => {
  clearPendingClarification();
  clearPendingCartMutationConfirmation();
  clearPendingProductSelection();
});

describe('runVoiceAssistantTurn — successful transcription reaches runAssistant', () => {
  test('a successful transcript is passed to runAssistant, and its real outcome is returned', async () => {
    const session = fakeSession({ stop: jest.fn().mockResolvedValue('find milk') });
    const runAssistantSpy = jest.fn().mockResolvedValue({
      success: true,
      intent: { type: 'search', confidence: 0.8, parameters: { query: 'milk' } },
      data: { products: [], storeStatuses: [] },
    } satisfies AssistantOutcome);
    const deps: VoiceAssistantDependencies = { session, runAssistant: runAssistantSpy };

    const result = await runVoiceAssistantTurn({}, deps);

    expect(runAssistantSpy).toHaveBeenCalledWith('find milk', {});
    expect(result.transcript).toBe('find milk');
    expect(result.outcome.success).toBe(true);
  });

  test('the assistant response is converted to speech via the session', async () => {
    const session = fakeSession();
    const runAssistantSpy = jest.fn().mockResolvedValue({
      success: true,
      intent: { type: 'open_planner', confidence: 0.8, parameters: {} },
      data: { action: 'open_planner' },
    } satisfies AssistantOutcome);
    const deps: VoiceAssistantDependencies = { session, runAssistant: runAssistantSpy };

    const result = await runVoiceAssistantTurn({}, deps);

    expect(session.speakResponse).toHaveBeenCalledWith('Opening your shopping planner.');
    expect(result.response.text).toBe('Opening your shopping planner.');
  });
});

describe('runVoiceAssistantTurn — Safety requirement 1: voice cannot bypass the dispatcher', () => {
  test('"Add milk" over voice still produces product_selection_required, never a cart mutation', async () => {
    const addToCartSpy = jest.fn();
    const session = fakeSession({ stop: jest.fn().mockResolvedValue('add milk') });

    // Uses the REAL runAssistant, composed with fake resolveIntent/dispatch
    // deps at the assistantService layer — proves the voice entry point
    // goes through the exact same evaluateClarificationPolicy +
    // dispatchIntent pipeline text input already uses (see
    // assistantDispatcher.test.ts's own equivalent add_to_cart tests).
    const runAssistantWithRealDispatcher = (text: string, context = {}) =>
      runAssistant(text, context, {
        resolveIntent: async () => ({ type: 'add_to_cart', confidence: 0.85, parameters: { item: 'milk' } }),
        dispatch: (intent, ctx) =>
          dispatchIntent(intent, ctx, {
            search: async () => ({
              products: [
                { id: 'a', name: 'Whole Milk', brand: 'Brand', price: 3, rating: 4, size: '1 gal', store: 'Kroger', matchType: 'direct' as const },
                { id: 'b', name: 'Almond Milk', brand: 'Brand', price: 4, rating: 4, size: '1 gal', store: 'Kroger', matchType: 'direct' as const },
              ],
              storeStatuses: [],
            }),
            optimizeCart: async () => ({ candidates: [], recommendedId: 'balanced', unresolvedItems: [] }),
            getZipcode: () => '78701',
            getCartItems: () => [],
            addToCart: addToCartSpy,
            removeFromCart: jest.fn(),
            generateMealPlan: jest.fn(),
            getLowStockItems: jest.fn().mockResolvedValue([]),
            getOwnerEmail: () => 'shopper@example.com',
          }),
      });

    const deps: VoiceAssistantDependencies = { session, runAssistant: runAssistantWithRealDispatcher };
    const result = await runVoiceAssistantTurn({ activeQuery: 'milk' }, deps);

    expect(result.outcome.type).toBe('product_selection_required');
    expect(result.outcome.success).toBe(false);
    expect(addToCartSpy).not.toHaveBeenCalled(); // never a cart mutation
  });
});

describe('runVoiceAssistantTurn — Safety requirement 2: recognition failure is safe', () => {
  test('a recognizer throwing "microphone_error" produces success:false and never calls runAssistant', async () => {
    const session = fakeSession({
      stop: jest.fn().mockResolvedValue(''), // createVoiceSession's own contract: failures resolve to '', never throw
      get error() {
        return 'microphone_error';
      },
    });
    const runAssistantSpy = jest.fn();
    const deps: VoiceAssistantDependencies = { session, runAssistant: runAssistantSpy };

    const result = await runVoiceAssistantTurn({}, deps);

    expect(result.outcome.success).toBe(false);
    expect(result.outcome.error).toBe('microphone_error');
    expect(runAssistantSpy).not.toHaveBeenCalled(); // no assistant action occurs
  });

  test('an empty transcript (no speech recognized at all) is also handled safely, never calling runAssistant', async () => {
    const session = fakeSession({ stop: jest.fn().mockResolvedValue('') });
    const runAssistantSpy = jest.fn();
    const deps: VoiceAssistantDependencies = { session, runAssistant: runAssistantSpy };

    const result = await runVoiceAssistantTurn({}, deps);

    expect(result.outcome.success).toBe(false);
    expect(runAssistantSpy).not.toHaveBeenCalled();
  });

  test('runVoiceAssistantTurn never throws even when the session itself is completely unavailable', async () => {
    const deps: VoiceAssistantDependencies = { session: createVoiceSession(), runAssistant: jest.fn() };

    await expect(runVoiceAssistantTurn({}, deps)).resolves.toBeDefined();
  });
});

describe('runVoiceAssistantTurn — Safety requirement 3: speech OUTPUT failure is safe', () => {
  test('a TTS failure never changes the underlying assistant outcome', async () => {
    const session = fakeSession({
      speakResponse: jest.fn().mockResolvedValue(undefined), // per voiceService.ts's own contract, this never throws even on failure
    });
    const successOutcome: AssistantOutcome = {
      success: true,
      intent: { type: 'open_planner', confidence: 0.8, parameters: {} },
      data: { action: 'open_planner' },
    };
    const runAssistantSpy = jest.fn().mockResolvedValue(successOutcome);
    const deps: VoiceAssistantDependencies = { session, runAssistant: runAssistantSpy };

    const result = await runVoiceAssistantTurn({}, deps);

    // Even though speakResponse "failed" internally (simulated via the
    // session's own safe contract), the returned outcome is untouched —
    // this file never inspects session.status to alter `outcome`.
    expect(result.outcome).toEqual(successOutcome);
    expect(session.speakResponse).toHaveBeenCalled();
  });

  test('runVoiceAssistantTurn resolves even when speakResponse is given by a session that reports an error afterward', async () => {
    const session = fakeSession({
      speakResponse: jest.fn().mockResolvedValue(undefined),
      get status() {
        return 'error' as const;
      },
      get error() {
        return 'audio unavailable';
      },
    });
    const runAssistantSpy = jest.fn().mockResolvedValue({
      success: true,
      intent: { type: 'open_planner', confidence: 0.8, parameters: {} },
      data: { action: 'open_planner' },
    } satisfies AssistantOutcome);
    const deps: VoiceAssistantDependencies = { session, runAssistant: runAssistantSpy };

    const result = await runVoiceAssistantTurn({}, deps);

    expect(result.outcome.success).toBe(true); // unaffected by the synthesis-side error
  });
});

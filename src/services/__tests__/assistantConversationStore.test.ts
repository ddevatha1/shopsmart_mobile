import { createPendingConversation, getPendingConversation, clearPendingConversation } from '../assistantConversationStore';
import type { Intent } from '../../models/intent';

function makeIntent(overrides: Partial<Intent> = {}): Intent {
  return { type: 'meal_plan', confidence: 0.8, parameters: {}, ...overrides };
}

afterEach(() => {
  clearPendingConversation();
});

test('returns undefined when nothing is pending', () => {
  expect(getPendingConversation()).toBeUndefined();
});

test('a created pending conversation is returned by a subsequent read', () => {
  const intent = makeIntent({ parameters: { mealType: 'dinner' } });
  createPendingConversation({
    pendingIntent: intent, pendingQuestion: 'How many meals should I plan for?',
    collectedParameters: intent.parameters, missingField: 'mealCount',
  });

  const pending = getPendingConversation();
  expect(pending?.pendingIntent).toBe(intent);
  expect(pending?.missingField).toBe('mealCount');
  expect(pending?.pendingQuestion).toBe('How many meals should I plan for?');
});

test('a new call replaces whatever was pending before — single slot, never a stack', () => {
  const first = makeIntent({ parameters: { mealType: 'dinner' } });
  const second = makeIntent({ parameters: { mealType: 'breakfast' } });
  createPendingConversation({ pendingIntent: first, pendingQuestion: 'q1', collectedParameters: {}, missingField: 'mealCount' });
  createPendingConversation({ pendingIntent: second, pendingQuestion: 'q2', collectedParameters: {}, missingField: 'mealCount' });

  expect(getPendingConversation()?.pendingIntent).toBe(second);
});

test('clearPendingConversation removes it, and is a safe no-op when nothing is pending', () => {
  createPendingConversation({ pendingIntent: makeIntent(), pendingQuestion: 'q', collectedParameters: {}, missingField: 'mealCount' });
  clearPendingConversation();
  expect(getPendingConversation()).toBeUndefined();
  expect(() => clearPendingConversation()).not.toThrow();
});

test('an expired pending conversation is treated as if it never existed, and is pruned on read', () => {
  const realNow = Date.now();
  jest.spyOn(Date, 'now').mockReturnValue(realNow);
  createPendingConversation({ pendingIntent: makeIntent(), pendingQuestion: 'q', collectedParameters: {}, missingField: 'mealCount' });

  jest.spyOn(Date, 'now').mockReturnValue(realNow + 10 * 60 * 1000); // well past the TTL
  expect(getPendingConversation()).toBeUndefined();

  jest.restoreAllMocks();
});

import { createPendingClarification, getPendingClarification, clearPendingClarification } from '../clarificationStore';
import type { Intent } from '../../models/intent';

function makeIntent(overrides: Partial<Intent> = {}): Intent {
  return { type: 'add_to_cart', confidence: 0.8, parameters: { item: 'milk' }, ...overrides };
}

describe('clarificationStore', () => {
  afterEach(() => {
    clearPendingClarification();
    jest.restoreAllMocks();
  });

  test('7. A pending clarification can be created, retrieved, and cleared', () => {
    expect(getPendingClarification()).toBeUndefined();

    const created = createPendingClarification({
      originalText: 'add milk',
      intentCandidate: makeIntent(),
      missingFields: ['productId'],
      question: 'Which product would you like to add?',
    });
    expect(created.id).toBeTruthy();
    expect(created.originalText).toBe('add milk');

    const retrieved = getPendingClarification();
    expect(retrieved).toEqual(created);

    clearPendingClarification();
    expect(getPendingClarification()).toBeUndefined();
  });

  test('creating a new pending clarification replaces any previous one — one slot, never a stack', () => {
    createPendingClarification({ originalText: 'add milk', intentCandidate: makeIntent(), missingFields: ['productId'], question: 'Q1' });
    const second = createPendingClarification({
      originalText: 'remove eggs',
      intentCandidate: makeIntent({ type: 'remove_from_cart', parameters: { item: 'eggs' } }),
      missingFields: ['productId'],
      question: 'Q2',
    });

    const retrieved = getPendingClarification();
    expect(retrieved).toEqual(second);
    expect(retrieved?.originalText).toBe('remove eggs');
  });

  test('8. An expired pending clarification is rejected (treated as none) and cleared on read', () => {
    const realNow = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(realNow);

    createPendingClarification({ originalText: 'add milk', intentCandidate: makeIntent(), missingFields: ['productId'], question: 'Q' });
    expect(getPendingClarification()).toBeTruthy();

    // Advance well past the store's TTL.
    jest.spyOn(Date, 'now').mockReturnValue(realNow + 10 * 60 * 1000);

    expect(getPendingClarification()).toBeUndefined();
    // And it stays gone — expiry isn't a one-time read glitch.
    expect(getPendingClarification()).toBeUndefined();
  });

  test('a clarification just inside its TTL is still returned', () => {
    const realNow = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(realNow);
    createPendingClarification({ originalText: 'add milk', intentCandidate: makeIntent(), missingFields: ['productId'], question: 'Q' });

    jest.spyOn(Date, 'now').mockReturnValue(realNow + 60 * 1000); // 1 minute later, well under TTL
    expect(getPendingClarification()).toBeTruthy();
  });

  test('clearPendingClarification is a safe no-op when nothing is pending', () => {
    expect(() => clearPendingClarification()).not.toThrow();
    expect(getPendingClarification()).toBeUndefined();
  });
});

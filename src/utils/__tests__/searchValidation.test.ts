import { validateSearchQuery } from '../searchValidation';

describe('validateSearchQuery', () => {
  test('allows normal grocery queries', () => {
    for (const q of ['milk', 'organic oat milk', 'chicken breast', 'tahini', 'xanthan gum']) {
      expect(validateSearchQuery(q)).toEqual({ valid: true });
    }
  });

  test('allows an empty query (nothing to reject)', () => {
    expect(validateSearchQuery('')).toEqual({ valid: true });
    expect(validateSearchQuery('   ')).toEqual({ valid: true });
  });

  test('rejects an unambiguous non-grocery product term', () => {
    const result = validateSearchQuery('iphone');
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('unrelated');
  });

  test('rejects singular/plural non-grocery terms alike', () => {
    expect(validateSearchQuery('tire').valid).toBe(false);
    expect(validateSearchQuery('tires').valid).toBe(false);
  });

  test('rejects multi-word non-grocery phrases even when individual words are ambiguous', () => {
    expect(validateSearchQuery('vacuum cleaner').valid).toBe(false);
    // "vacuum" alone is deliberately NOT blocked (vacuum-sealed bags are groceries).
    expect(validateSearchQuery('vacuum sealed bags').valid).toBe(true);
  });

  test('rejects inappropriate language', () => {
    const result = validateSearchQuery('shit milk');
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('inappropriate');
  });

  test('is case-insensitive', () => {
    expect(validateSearchQuery('IPHONE').valid).toBe(false);
    expect(validateSearchQuery('MILK').valid).toBe(true);
  });

  test('does not false-positive on a grocery item containing a blocked substring', () => {
    // "tire" is blocked, but this checks word-boundary tokenization doesn't
    // accidentally match unrelated compound words.
    expect(validateSearchQuery('entire wheat bread').valid).toBe(true);
  });
});

import { correctQuery, normalizeQuery } from '../queryCorrection';

describe('normalizeQuery', () => {
  test('trims and collapses internal whitespace', () => {
    expect(normalizeQuery('  organic   milk  ')).toBe('organic milk');
  });

  test('strips stray punctuation but keeps intra-word hyphens and apostrophes', () => {
    expect(normalizeQuery('organic milk!! @#$')).toBe('organic milk');
    expect(normalizeQuery("trader joe's extra-virgin oil")).toBe("trader joe's extra-virgin oil");
  });
});

describe('correctQuery', () => {
  test('leaves an already-correct query untouched (level "none", confidence 1)', () => {
    const result = correctQuery('milk');
    expect(result.level).toBe('none');
    expect(result.corrected).toBe('milk');
    expect(result.confidence).toBe(1);
  });

  test('corrects a clear single-letter-swap typo with high confidence', () => {
    const result = correctQuery('chikcen');
    expect(result.corrected).toBe('chicken');
    expect(result.level).toBe('high');
  });

  test('corrects a doubled-letter typo', () => {
    const result = correctQuery('bananna');
    expect(result.corrected).toBe('banana');
    expect(result.level).toBe('high');
  });

  test('never fabricates a correction for unrecognized gibberish', () => {
    const result = correctQuery('xqz123');
    expect(result.level).toBe('none');
    expect(result.corrected).toBe('xqz123');
  });

  test('is a pure function — the same input always produces the same result', () => {
    expect(correctQuery('chikcen')).toEqual(correctQuery('chikcen'));
  });

  test('handles an empty query without throwing', () => {
    const result = correctQuery('');
    expect(result.level).toBe('none');
    expect(result.corrected).toBe('');
  });
});

import { parseListInput, analyzeItems, applyAmbiguityAnswers } from '../plannerAmbiguityService';

describe('parseListInput', () => {
  test('splits on newlines and commas', () => {
    expect(parseListInput('milk\neggs, bread')).toEqual(['milk', 'eggs', 'bread']);
  });

  test('trims whitespace and drops empty lines', () => {
    expect(parseListInput('  milk  \n\n  eggs \n')).toEqual(['milk', 'eggs']);
  });

  test('dedupes case-insensitively, keeping the first occurrence', () => {
    expect(parseListInput('Milk\nmilk\nMILK')).toEqual(['Milk']);
  });

  test('returns an empty array for blank input', () => {
    expect(parseListInput('   \n  ')).toEqual([]);
  });
});

describe('analyzeItems', () => {
  test('an item with no taxonomy entry resolves immediately with no prompt', () => {
    const { resolved, prompts } = analyzeItems(['some random item xyz'], {});
    expect(prompts).toHaveLength(0);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].taxonomyEntryId).toBeUndefined();
  });

  test('"milk" has no default subtype and genuinely needs a clarifying prompt', () => {
    const { resolved, prompts } = analyzeItems(['milk'], {});
    expect(prompts).toHaveLength(1);
    expect(prompts[0].taxonomyEntryId).toBe('milk');
    expect(prompts[0].options.length).toBeGreaterThan(1);
    expect(resolved[0].subtypeId).toBeUndefined();
  });

  test('"bananas" has a majority default and resolves without a prompt', () => {
    const { resolved, prompts } = analyzeItems(['bananas'], {});
    expect(prompts).toHaveLength(0);
    expect(resolved[0].taxonomyEntryId).toBe('bananas');
    expect(resolved[0].subtypeId).toBe('conventional');
  });

  test('a remembered preference resolves without a prompt, even for an entry with no default', () => {
    const { resolved, prompts } = analyzeItems(['milk'], { milk: 'whole' });
    expect(prompts).toHaveLength(0);
    expect(resolved[0].subtypeId).toBe('whole');
  });

  test('a remembered "no-preference" resolves to a null subtypeId', () => {
    const { resolved, prompts } = analyzeItems(['milk'], { milk: 'no-preference' });
    expect(prompts).toHaveLength(0);
    expect(resolved[0].subtypeId).toBeNull();
  });

  test('multiple list items sharing the same ambiguous taxonomy entry collapse into one prompt', () => {
    const { prompts } = analyzeItems(['milk', '2% milk please'], {});
    expect(prompts).toHaveLength(1);
    expect(prompts[0].listItemIds).toHaveLength(2);
  });
});

describe('applyAmbiguityAnswers', () => {
  test('applies the chosen subtype to every item sharing that taxonomy entry', () => {
    const { resolved } = analyzeItems(['milk', 'whole milk'], {});
    const withAnswers = applyAmbiguityAnswers(resolved, { milk: 'skim' });
    expect(withAnswers.every((item) => item.subtypeId === 'skim')).toBe(true);
  });

  test('leaves items with no taxonomyEntryId (or no matching answer) untouched', () => {
    const { resolved } = analyzeItems(['some random item xyz'], {});
    const withAnswers = applyAmbiguityAnswers(resolved, { milk: 'skim' });
    expect(withAnswers).toEqual(resolved);
  });
});

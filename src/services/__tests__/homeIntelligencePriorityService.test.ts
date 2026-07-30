import { selectHomeIntelligenceSurface } from '../homeIntelligencePriorityService';

describe('selectHomeIntelligenceSurface', () => {
  test('the insights strip wins whenever it has real content, regardless of what else is available', () => {
    expect(selectHomeIntelligenceSurface({
      insightsStripHasContent: true, pantryHasContent: true, advisorHasContent: true,
    })).toBe('insights_strip');
  });

  test('pantry wins when the strip has nothing but pantry does', () => {
    expect(selectHomeIntelligenceSurface({
      insightsStripHasContent: false, pantryHasContent: true, advisorHasContent: true,
    })).toBe('pantry_check_in');
  });

  test('advisor wins when neither the strip nor pantry has anything', () => {
    expect(selectHomeIntelligenceSurface({
      insightsStripHasContent: false, pantryHasContent: false, advisorHasContent: true,
    })).toBe('advisor');
  });

  test('the assistant-discovery hint is the last resort when nothing else has real content', () => {
    expect(selectHomeIntelligenceSurface({
      insightsStripHasContent: false, pantryHasContent: false, advisorHasContent: false,
    })).toBe('assistant_hint');
  });
});

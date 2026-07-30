import { explainProductSelection, explainRecommendation, flattenExplanationReasons, getWhyChosenBadges } from '../recommendationExplanationService';
import type { ApiProduct, PlanCandidate, PlanStoreAssignment } from '../../models/types';

function makeProduct(overrides: Partial<ApiProduct> = {}): ApiProduct {
  return {
    id: `p-${Math.random()}`,
    name: 'Whole Milk',
    brand: 'Test Brand',
    price: 3.99,
    rating: 4.5,
    size: '1 gal',
    store: 'Aldi',
    ...overrides,
  };
}

function makeStoreAssignment(store: PlanStoreAssignment['store']): PlanStoreAssignment {
  return { store, location: { name: store, address: '1 Main St', city: 'Austin', state: 'TX', zip: '78701' }, items: [], subtotal: 10 };
}

function makeCandidate(overrides: Partial<PlanCandidate> = {}): PlanCandidate {
  return {
    id: 'balanced', label: 'Balanced', storeAssignments: [makeStoreAssignment('Kroger'), makeStoreAssignment('Sprouts')],
    totalCost: 50, estimatedGasCost: 3, estimatedSavings: 0, totalDriveMinutes: 15, totalDriveMiles: 6,
    storeCount: 2, itemsFound: 6, itemsTotal: 6,
    tripPlan: { origin: { latitude: 0, longitude: 0 }, totalDurationMinutes: 15, totalDistanceMiles: 6, routeGeometry: { type: 'LineString', coordinates: [] }, stops: [] },
    ...overrides,
  };
}

describe('explainRecommendation — budget evidence', () => {
  test('a real, positive estimatedSavings produces a savings reason with real evidence', () => {
    const explanation = explainRecommendation(makeCandidate({ estimatedSavings: 12.4 }));
    expect(explanation.savingsReasons?.[0].message).toBe('Saved $12.40 compared with the most expensive option.');
    expect(explanation.savingsReasons?.[0].evidence).toEqual({ sourceField: 'estimatedSavings', value: 12.4 });
  });

  test('a real, present budgetAnalysis under budget produces a budget reason', () => {
    const explanation = explainRecommendation(makeCandidate({ budgetAnalysis: { target: 100, actual: 82, difference: 18, status: 'under' } }));
    const reason = explanation.savingsReasons?.find((r) => r.message.includes('budget'));
    expect(reason?.message).toBe('Fits within your $100.00 budget — estimated total is $82.00.');
    expect(reason?.evidence.sourceField).toBe('budgetAnalysis');
  });

  test('an over-budget candidate never gets a budget reason claiming it fits', () => {
    const explanation = explainRecommendation(makeCandidate({ budgetAnalysis: { target: 100, actual: 120, difference: -20, status: 'over' } }));
    expect(explanation.savingsReasons?.some((r) => r.message.toLowerCase().includes('fits'))).toBeFalsy();
  });

  test('zero savings never produces a fabricated "saved $0.00" reason', () => {
    const explanation = explainRecommendation(makeCandidate({ estimatedSavings: 0 }));
    expect(explanation.savingsReasons).toBeUndefined();
  });
});

describe('explainRecommendation — nutrition evidence', () => {
  test('a real nutrition score produces a health reason, converted to a 0-100 display scale', () => {
    const explanation = explainRecommendation(makeCandidate({
      nutritionScore: { score: 0.78, confidence: 'high', productsEvaluated: 6, productsMissingNutrition: 0 },
    }));
    expect(explanation.healthReasons?.[0].message).toBe('Has a nutrition score of 78 out of 100.');
    expect(explanation.healthReasons?.[0].evidence.sourceField).toBe('nutritionScore');
  });

  test('no nutrition score at all produces no health reason — never "probably healthier"', () => {
    const explanation = explainRecommendation(makeCandidate());
    expect(explanation.healthReasons).toBeUndefined();
  });
});

describe('explainRecommendation — preference evidence', () => {
  test('a preferred store that genuinely appears in this candidate\'s own assignments produces a preference reason', () => {
    const explanation = explainRecommendation(
      makeCandidate({ storeAssignments: [makeStoreAssignment('Aldi')] }),
      { stores: ['Aldi'] },
    );
    expect(explanation.preferenceReasons?.[0].message).toBe('Selected Aldi because it matches your preferred stores.');
    expect(explanation.preferenceReasons?.[0].evidence).toEqual({ sourceField: 'preferredStores', value: ['Aldi'] });
  });

  test('a preferred store NOT in this candidate produces no preference reason — never a false match', () => {
    const explanation = explainRecommendation(
      makeCandidate({ storeAssignments: [makeStoreAssignment('Kroger')] }),
      { stores: ['Aldi'] },
    );
    expect(explanation.preferenceReasons).toBeUndefined();
  });

  test('optimizationPreference literally matching this candidate\'s own id produces a reason', () => {
    const explanation = explainRecommendation(makeCandidate({ id: 'cheapest', label: 'Cheapest' }), { optimizationPreference: 'cheapest' });
    expect(explanation.preferenceReasons?.some((r) => r.message.includes('cheapest'))).toBe(true);
  });

  test('"Aldi was ranked higher" is never claimed unless the optimizer\'s own candidate.id actually matches', () => {
    const explanation = explainRecommendation(makeCandidate({ id: 'balanced', label: 'Balanced' }), { optimizationPreference: 'cheapest' });
    expect(explanation.preferenceReasons).toBeUndefined();
  });
});

describe('explainRecommendation — fabricated explanations rejected', () => {
  test('a candidate with no real savings, no nutrition data, no preference match, and nothing convenience-worthy produces an empty explanation', () => {
    const explanation = explainRecommendation(makeCandidate());
    expect(explanation).toEqual({});
  });

  test('flattening an empty explanation yields an empty list, never placeholder reasons', () => {
    expect(flattenExplanationReasons(explainRecommendation(makeCandidate()))).toEqual([]);
  });
});

describe('explainRecommendation — convenience evidence', () => {
  test('a single-store candidate gets a real convenience reason', () => {
    const explanation = explainRecommendation(makeCandidate({ storeAssignments: [makeStoreAssignment('Kroger')], storeCount: 1, totalDriveMinutes: 8 }));
    expect(explanation.convenienceReasons?.[0].message).toContain('1 store');
  });

  test('a plain multi-store "balanced" candidate with nothing special gets no manufactured convenience reason', () => {
    const explanation = explainRecommendation(makeCandidate({ id: 'balanced', storeCount: 2 }));
    expect(explanation.convenienceReasons).toBeUndefined();
  });
});

describe('flattenExplanationReasons', () => {
  test('flattens every populated bucket in a stable order', () => {
    const explanation = explainRecommendation(
      makeCandidate({ estimatedSavings: 5, storeAssignments: [makeStoreAssignment('Aldi')] }),
      { stores: ['Aldi'] },
    );
    const flat = flattenExplanationReasons(explanation);
    expect(flat.length).toBe(2);
    expect(flat[0].type).toBe('budget');
    expect(flat[1].type).toBe('preference');
  });
});

// ─── explainProductSelection (Phase 5.5 Part 4) ─────────────────────────────

describe('explainProductSelection — preference evidence', () => {
  test('a product at a preferred store gets a real store-preference reason', () => {
    const explanation = explainProductSelection(makeProduct({ store: 'Aldi' }), { preferredStores: ['Aldi', 'Kroger'] });
    expect(explanation.preferenceReasons?.[0].message).toBe('Matches your preferred store (Aldi).');
    expect(explanation.preferenceReasons?.[0].evidence.sourceField).toBe('preferredStores');
  });

  test('a product at a non-preferred store gets no store-preference reason', () => {
    const explanation = explainProductSelection(makeProduct({ store: 'Sprouts' }), { preferredStores: ['Aldi'] });
    expect(explanation.preferenceReasons).toBeUndefined();
  });

  test('a real matching certification produces a dietary-preference reason', () => {
    const explanation = explainProductSelection(
      makeProduct({ certifications: ['Gluten-Free', 'Non-GMO'] }),
      { dietaryPreferences: ['gluten-free'] },
    );
    expect(explanation.preferenceReasons?.[0].message).toBe('Matches your gluten-free preference (certified Gluten-Free).');
    expect(explanation.preferenceReasons?.[0].evidence.sourceField).toBe('certifications');
  });

  test('a stated dietary preference with no matching real certification produces no reason — never inferred from the name', () => {
    const explanation = explainProductSelection(
      makeProduct({ name: 'Gluten Free Style Crackers', certifications: undefined }),
      { dietaryPreferences: ['gluten-free'] },
    );
    expect(explanation.preferenceReasons).toBeUndefined();
  });
});

describe('explainProductSelection — history evidence', () => {
  test('a real, strictly lower current price than the previous purchase produces a history reason', () => {
    const explanation = explainProductSelection(makeProduct({ price: 2.99 }), { previousPurchase: { price: 3.99 } });
    expect(explanation.historyReasons?.[0].message).toBe('Lower price than your previous purchase ($2.99 vs $3.99).');
    expect(explanation.historyReasons?.[0].evidence.sourceField).toBe('previousPurchase');
  });

  test('an equal or higher current price than the previous purchase produces no reason — never spun as an improvement', () => {
    const explanation = explainProductSelection(makeProduct({ price: 3.99 }), { previousPurchase: { price: 3.99 } });
    expect(explanation.historyReasons).toBeUndefined();
  });

  test('no previous purchase at all produces no history reason', () => {
    const explanation = explainProductSelection(makeProduct());
    expect(explanation.historyReasons).toBeUndefined();
  });
});

describe('explainProductSelection — nutrition evidence', () => {
  const openFoodFactsBase = { source: 'open_food_facts' as const, completeness: 'complete' as const };

  test('strictly higher real protein than every real comparable produces a nutrition reason', () => {
    const product = makeProduct({ nutrition: { ...openFoodFactsBase, proteinGPer100g: 12 } });
    const comparableProducts = [
      makeProduct({ id: 'other-1', nutrition: { ...openFoodFactsBase, proteinGPer100g: 8 } }),
      makeProduct({ id: 'other-2', nutrition: { ...openFoodFactsBase, proteinGPer100g: 6 } }),
    ];
    const explanation = explainProductSelection(product, { comparableProducts });
    expect(explanation.healthReasons?.[0].message).toBe('Higher protein than similar options (12g vs 8g per 100g).');
  });

  test('protein no higher than the best real comparable produces no nutrition reason', () => {
    const product = makeProduct({ nutrition: { ...openFoodFactsBase, proteinGPer100g: 5 } });
    const comparableProducts = [makeProduct({ id: 'other-1', nutrition: { ...openFoodFactsBase, proteinGPer100g: 8 } })];
    const explanation = explainProductSelection(product, { comparableProducts });
    expect(explanation.healthReasons).toBeUndefined();
  });

  test('a product with no real nutrition data gets no nutrition reason, regardless of comparables', () => {
    const comparableProducts = [makeProduct({ id: 'other-1', nutrition: { ...openFoodFactsBase, proteinGPer100g: 1 } })];
    const explanation = explainProductSelection(makeProduct({ nutrition: undefined }), { comparableProducts });
    expect(explanation.healthReasons).toBeUndefined();
  });

  test('comparables with no real protein data at all never produce a fabricated comparison', () => {
    const product = makeProduct({ nutrition: { ...openFoodFactsBase, proteinGPer100g: 12 } });
    const comparableProducts = [makeProduct({ id: 'other-1', nutrition: { ...openFoodFactsBase, proteinGPer100g: undefined } })];
    const explanation = explainProductSelection(product, { comparableProducts });
    expect(explanation.healthReasons).toBeUndefined();
  });
});

describe('explainProductSelection — fabricated explanations rejected', () => {
  test('a product with no preference match, no purchase history, and no standout nutrition produces an empty explanation', () => {
    expect(explainProductSelection(makeProduct())).toEqual({});
  });
});

// ─── getWhyChosenBadges (Phase 6 Part 5 — ProductCard badges) ───────────────

describe('getWhyChosenBadges', () => {
  test('real evidence produces real badge strings, in the same order flattenExplanationReasons uses', () => {
    const badges = getWhyChosenBadges(makeProduct({ price: 2.99, store: 'Aldi' }), {
      preferredStores: ['Aldi'],
      previousPurchase: { price: 3.99 },
    });
    expect(badges).toEqual([
      'Matches your preferred store (Aldi).',
      'Lower price than your previous purchase ($2.99 vs $3.99).',
    ]);
  });

  test('no real evidence at all returns undefined, never an empty array a caller might render as an empty row', () => {
    expect(getWhyChosenBadges(makeProduct())).toBeUndefined();
  });

  test('unsupported/unmatched context (wrong store, no cheaper history, no standout nutrition) returns undefined — badges are never fabricated to fill space', () => {
    const badges = getWhyChosenBadges(makeProduct({ store: 'Sprouts', price: 3.99 }), {
      preferredStores: ['Aldi'],
      previousPurchase: { price: 3.99 },
    });
    expect(badges).toBeUndefined();
  });
});

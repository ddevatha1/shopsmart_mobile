import { explainCandidate, explainShoppingOptions, explainPreferenceMatch } from '../assistantExplanationService';
import type { PlanCandidate, PlanStoreAssignment } from '../../models/types';

function makeStoreAssignment(store: PlanStoreAssignment['store']): PlanStoreAssignment {
  return { store, location: { name: store, address: '1 Main St', city: 'Austin', state: 'TX', zip: '78701' }, items: [], subtotal: 10 };
}

function makeCandidate(overrides: Partial<PlanCandidate> = {}): PlanCandidate {
  return {
    id: 'balanced', label: 'Balanced', storeAssignments: [], totalCost: 50, estimatedGasCost: 3,
    estimatedSavings: 0, totalDriveMinutes: 15, totalDriveMiles: 6, storeCount: 2, itemsFound: 6, itemsTotal: 6,
    tripPlan: { origin: { latitude: 0, longitude: 0 }, totalDurationMinutes: 15, totalDistanceMiles: 6, routeGeometry: { type: 'LineString', coordinates: [] }, stops: [] },
    ...overrides,
  };
}

describe('explainCandidate', () => {
  test('cheapest with real savings names the exact real savings figure and store count', () => {
    const text = explainCandidate(makeCandidate({ id: 'cheapest', label: 'Cheapest', estimatedSavings: 8.42, storeCount: 2 }));
    expect(text).toContain('Cheapest');
    expect(text).toContain('$8.42');
    expect(text).toContain('2 stores');
  });

  test('cheapest with NO real savings never claims an unsupported saving — falls back to real total cost', () => {
    const text = explainCandidate(makeCandidate({ id: 'cheapest', label: 'Cheapest', estimatedSavings: 0, totalCost: 61.5 }));
    expect(text).not.toContain('saves $0.00');
    expect(text).toContain('$61.50');
  });

  test('fastest names real drive time and store count, never a fabricated number', () => {
    const text = explainCandidate(makeCandidate({ id: 'fastest', label: 'Fastest', totalDriveMinutes: 12.7, storeCount: 1 }));
    expect(text).toContain('13 minute');
    expect(text).toContain('1 store');
  });

  test('healthiest with a real nutrition score names it', () => {
    const text = explainCandidate(makeCandidate({
      id: 'healthiest', label: 'Healthiest',
      nutritionScore: { score: 78, confidence: 'high', productsEvaluated: 6, productsMissingNutrition: 0 },
    }));
    expect(text).toContain('nutrition score of 78');
  });

  test('healthiest with NO real nutrition score never invents one — falls back to real total cost', () => {
    const text = explainCandidate(makeCandidate({ id: 'healthiest', label: 'Healthiest', totalCost: 44 }));
    expect(text).not.toContain('nutrition score');
    expect(text).toContain('$44.00');
  });

  test('a present budgetAnalysis is explained; an absent one is never mentioned', () => {
    const under = explainCandidate(makeCandidate({ budgetAnalysis: { target: 100, actual: 80, difference: 20, status: 'under' } }));
    expect(under).toContain('under your budget');

    const over = explainCandidate(makeCandidate({ budgetAnalysis: { target: 100, actual: 120, difference: -20, status: 'over' } }));
    expect(over).toContain('over your budget');

    const none = explainCandidate(makeCandidate());
    expect(none).not.toContain('budget');
  });
});

describe('explainShoppingOptions', () => {
  test('summarizes every real candidate given, never inventing an option that was not passed in', () => {
    const cheapest = makeCandidate({ id: 'cheapest', label: 'Cheapest', estimatedSavings: 8.42 });
    const fastest = makeCandidate({ id: 'fastest', label: 'Fastest', totalDriveMinutes: 10 });
    const text = explainShoppingOptions([cheapest, fastest]);

    expect(text).toContain('2 ways');
    expect(text).toContain('Cheapest');
    expect(text).toContain('Fastest');
  });

  test('an empty candidate list gets an honest message, never a fabricated summary', () => {
    expect(explainShoppingOptions([])).not.toContain('found');
  });
});

describe('explainPreferenceMatch — Phase 5.2 Part 5, evidence-gated only', () => {
  test('a real preferred store that actually appears in this candidate\'s own assignments is explained', () => {
    const candidate = makeCandidate({ storeAssignments: [makeStoreAssignment('Aldi'), makeStoreAssignment('Kroger')] });
    const text = explainPreferenceMatch(candidate, { stores: ['Aldi'] });
    expect(text).toBe('Your preferred Aldi option was included.');
  });

  test('a preferred store that does NOT appear in this candidate produces no explanation — never claim a match that is not real', () => {
    const candidate = makeCandidate({ storeAssignments: [makeStoreAssignment('Kroger')] });
    expect(explainPreferenceMatch(candidate, { stores: ['Aldi'] })).toBeUndefined();
  });

  test('a matching optimizationPreference (candidate.id equals the stated preference) is explained', () => {
    const candidate = makeCandidate({ id: 'cheapest', label: 'Cheapest' });
    const text = explainPreferenceMatch(candidate, { optimizationPreference: 'cheapest' });
    expect(text).toBe('This matches your preference for the cheapest option.');
  });

  test('a non-matching optimizationPreference produces no explanation', () => {
    const candidate = makeCandidate({ id: 'balanced', label: 'Balanced' });
    expect(explainPreferenceMatch(candidate, { optimizationPreference: 'cheapest' })).toBeUndefined();
  });

  test('no preferencesUsed at all, or no candidate at all, produces no explanation — never invented from nothing', () => {
    const candidate = makeCandidate();
    expect(explainPreferenceMatch(candidate, undefined)).toBeUndefined();
    expect(explainPreferenceMatch(undefined, { stores: ['Aldi'] })).toBeUndefined();
  });
});

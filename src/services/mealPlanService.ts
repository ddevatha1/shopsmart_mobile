import type { MealPlanGenerationRequest, MealPlanGenerationResult } from '../models/types';
import { apiClient, ApiError } from './apiClient';

/** Posts a meal-plan request to this app's backend /api/meal-plan —
 * mirrors plannerService.ts's `generateShoppingPlan` exactly (same
 * fetch/ApiError pattern, same "backend owns the real domain logic,
 * mobile is a thin wrapper" split). See
 * backend/src/services/mealPlanService.ts: deterministic, curated
 * templates only, no AI, no prices. */
export async function requestMealPlan(request: MealPlanGenerationRequest): Promise<MealPlanGenerationResult> {
  const res = await fetch(`${apiClient.baseUrl}/api/meal-plan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(body?.error ?? `Server returned ${res.status}`);
  }
  return body as MealPlanGenerationResult;
}

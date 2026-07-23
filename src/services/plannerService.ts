import type { PlannerListItem, ShoppingPlanResponse } from '../models/types';
import { apiClient, ApiError } from './apiClient';

/** Posts already-resolved list items to this app's backend /api/planner —
 * mirrors apiClient's other methods (search/planTrip). Reuses apiClient's
 * own baseUrl/ApiError rather than a second HTTP client. */
export async function generateShoppingPlan(
  items: PlannerListItem[],
  zipcode: string,
): Promise<ShoppingPlanResponse> {
  const res = await fetch(`${apiClient.baseUrl}/api/planner`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items, zipcode }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(body?.error ?? `Server returned ${res.status}`);
  }
  return body as ShoppingPlanResponse;
}

import { apiClient } from './apiClient';
import { getCurrentCoordinates } from './locationService';
import type { StoreLocation, TripOrigin, TripPlan } from '../models/types';

/**
 * The frontend "RoutingService" — resolves where the trip should start
 * (real GPS if the shopper has granted permission, the ZIP-code center
 * otherwise — never a fabricated default) and hands that plus the
 * deduplicated store stops to the backend's real routing engine. The
 * actual trip optimization happens server-side (see
 * backend/src/services/tripPlanner.ts); this is purely the "where do we
 * start from" concern, kept out of the Route screen itself. The returned
 * `TripPlan.origin` carries the resolved coordinates either way, so the
 * caller never needs to know which path was taken.
 */
export async function planShoppingTrip(
  stops: StoreLocation[],
  fallbackZipcode: string,
): Promise<TripPlan> {
  const coords = await getCurrentCoordinates();
  const origin: TripOrigin = coords
    ? { latitude: coords.latitude, longitude: coords.longitude }
    : { zipcode: fallbackZipcode };

  return apiClient.planTrip(origin, stops);
}

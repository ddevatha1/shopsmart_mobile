import type { StoreLocation, TripOrigin, TripPlan, TripStop } from '../types/index.ts';
import { geocodeAddress, geocodeZip } from '../utils/geocode.ts';
import { planOptimizedTrip, describeManeuver } from './routingService.ts';

const METERS_PER_MILE = 1609.34;

/** One stop per physical store — collapses duplicate StoreLocations (same
 * store, sent more than once) so a shopper is never routed to the same
 * address twice, matching how groupCartByStore.ts already groups on the
 * frontend; this is the defensive backend-side guarantee of the same rule. */
function dedupeStops(stops: StoreLocation[]): StoreLocation[] {
  const seen = new Set<string>();
  const result: StoreLocation[] = [];
  for (const stop of stops) {
    const key = `${stop.storeId ?? ''}|${stop.address}|${stop.city}|${stop.state}|${stop.zip}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(stop);
  }
  return result;
}

async function resolveOriginCoords(
  origin: TripOrigin,
): Promise<{ latitude: number; longitude: number } | null> {
  if (origin.latitude != null && origin.longitude != null) {
    return { latitude: origin.latitude, longitude: origin.longitude };
  }
  if (origin.zipcode) {
    const geo = await geocodeZip(origin.zipcode);
    if (geo) return { latitude: geo.latitude, longitude: geo.longitude };
  }
  return null;
}

async function resolveStopCoords(stop: StoreLocation): Promise<StoreLocation> {
  if (stop.latitude != null && stop.longitude != null) return stop;
  const coords = await geocodeAddress(`${stop.address}, ${stop.city}, ${stop.state} ${stop.zip}`);
  if (!coords) return stop;
  return { ...stop, latitude: coords.latitude, longitude: coords.longitude };
}

/**
 * The TripOptimizer/RoutePlanner: given a shopper's starting point and one
 * StoreLocation per store their cart needs, produces a real, engine-solved
 * visit order and driving route (see routingService.ts for the OSRM call
 * itself). This is where "store selection" (deduped stops) meets "trip
 * optimization" (OSRM) and hands off a plain result for the route to
 * render — it has no knowledge of carts, products, or UI.
 */
export async function planTrip(origin: TripOrigin, rawStops: StoreLocation[]): Promise<TripPlan> {
  const stops = dedupeStops(rawStops);
  if (stops.length === 0) {
    throw new Error('No store stops to route to.');
  }

  const originCoords = await resolveOriginCoords(origin);
  if (!originCoords) {
    throw new Error('Could not determine a starting location for the route.');
  }

  const resolvedStops = await Promise.all(stops.map(resolveStopCoords));
  const validStops = resolvedStops.filter(
    (s): s is StoreLocation & { latitude: number; longitude: number } =>
      s.latitude != null && s.longitude != null,
  );
  // A store the requester sent but whose coordinates never resolved (no
  // lat/lng from the store's own API, and its address didn't geocode
  // either) — reported back explicitly rather than just vanishing from
  // `stops`, so the frontend can name the specific store/products that
  // couldn't be routed to instead of the trip silently being one stop short.
  const unresolvedStops = resolvedStops.filter(s => s.latitude == null || s.longitude == null);
  if (validStops.length === 0) {
    throw new Error('Could not determine coordinates for any store in this trip.');
  }

  const coordinates: [number, number][] = [
    [originCoords.longitude, originCoords.latitude],
    ...validStops.map((s): [number, number] => [s.longitude, s.latitude]),
  ];

  const { trip, visitOrderByInputIndex } = await planOptimizedTrip(coordinates);

  // Invert "input index -> visit position" into "visit position -> input
  // index", so we can walk the optimized sequence in order.
  const inputIndexByVisitOrder: number[] = [];
  visitOrderByInputIndex.forEach((visitPos, inputIdx) => {
    inputIndexByVisitOrder[visitPos] = inputIdx;
  });
  // Position 0 is always the origin (source=first pins it) — everything
  // after that is a store, in optimized order. Convert back to validStops
  // indices (input index 0 is the origin, so stop k is input index k+1).
  const orderedStopIndices = inputIndexByVisitOrder.slice(1).map(inputIdx => inputIdx - 1);

  let cumulativeMinutes = 0;
  const orderedStops: TripStop[] = orderedStopIndices.map((stopIdx, legIdx) => {
    const leg = trip.legs[legIdx];
    const legDurationMinutes = leg.duration / 60;
    cumulativeMinutes += legDurationMinutes;
    return {
      location: validStops[stopIdx],
      legDurationMinutes,
      legDistanceMiles: leg.distance / METERS_PER_MILE,
      cumulativeEtaMinutes: cumulativeMinutes,
      nextManeuver: describeManeuver(leg.steps[0]),
    };
  });

  return {
    origin: originCoords,
    totalDurationMinutes: trip.duration / 60,
    totalDistanceMiles: trip.distance / METERS_PER_MILE,
    routeGeometry: trip.geometry,
    stops: orderedStops,
    ...(unresolvedStops.length > 0 ? { unresolvedStops } : {}),
  };
}

import type { Request, Response } from 'express';
import type { StoreLocation, TripOrigin, TripRequest } from '../types/index.ts';
import { planTrip } from '../services/tripPlanner.ts';

function isStoreLocation(value: unknown): value is StoreLocation {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.name === 'string' &&
    typeof v.address === 'string' &&
    typeof v.city === 'string' &&
    typeof v.state === 'string' &&
    typeof v.zip === 'string'
  );
}

export async function handleTrip(req: Request, res: Response): Promise<void> {
  const body = req.body as Partial<TripRequest>;

  const origin = body.origin as TripOrigin | undefined;
  const hasCoords = origin?.latitude != null && origin?.longitude != null;
  const hasZip = !!origin?.zipcode;
  if (!origin || (!hasCoords && !hasZip)) {
    res.status(400).json({ error: '`origin` must include latitude/longitude or a zipcode.' });
    return;
  }

  if (!Array.isArray(body.stops) || body.stops.length === 0 || !body.stops.every(isStoreLocation)) {
    res.status(400).json({ error: '`stops` must be a non-empty array of StoreLocation objects.' });
    return;
  }

  try {
    const plan = await planTrip(origin, body.stops);
    res.json(plan);
  } catch (err) {
    console.warn('[Trip] planning failed:', err);
    res.status(502).json({ error: err instanceof Error ? err.message : 'Route planning failed.' });
  }
}

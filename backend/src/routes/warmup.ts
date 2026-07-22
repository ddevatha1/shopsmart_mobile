/**
 * POST /api/warmup — called once per app-open (see App.tsx / warmupStore.ts)
 * with the shopper's saved zip, if any. Runs in the background from the
 * client's perspective (fire-and-forget fetch, never blocks the UI); this
 * handler itself awaits full completion so it can return real per-store
 * timings for instrumentation, but a slow/failed warm-up here has no effect
 * on search — see warmupService.ts's doc comment.
 */
import type { Request, Response } from 'express';
import { runWarmup } from '../services/warmupService.ts';

export async function handleWarmup(req: Request, res: Response): Promise<void> {
  const body = req.body as { zipcode?: string };
  const zipcode = body.zipcode?.trim();

  if (zipcode && !/^\d{5}$/.test(zipcode)) {
    res.status(400).json({ error: '`zipcode` must be a 5-digit US zip code.' });
    return;
  }

  const result = await runWarmup(zipcode || undefined);
  res.json(result);
}

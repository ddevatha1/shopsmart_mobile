/**
 * POST /api/warmup — "is the backend alive and ready to accept searches?"
 * Called at app launch and once a shopper's zip is known (see App.tsx /
 * warmupStore.ts). MUST respond fast (single-digit ms on a warm server) —
 * it exists to let a client find out whether to wait a moment before its
 * first real search, which only works if asking is itself cheap.
 *
 * Root cause of a real, confirmed bug (client logs: `/api/warmup` taking
 * several seconds and the client's own request timeout firing): this
 * handler used to `await runWarmup(zipcode)` directly, so the HTTP
 * response itself was blocked on the full warm-up cycle completing (every
 * store's session/token/location bootstrap, unbounded). The fix is this
 * file: never await the actual warm-up work. `ensureWarmupStarted` kicks
 * it off (or, via warmupService.ts's own `inFlight` dedup, reuses an
 * already-running cycle) fully in the background; this handler's only job
 * is reporting the CURRENT real readiness state, synchronously, right
 * away. A second, real bug this used to have on top of that: once a
 * cycle completed, the very next call would restart a brand new one from
 * scratch — see warmupService.ts's own `READY_COOLDOWN_MS`.
 */
import type { Request, Response } from 'express';
import { ensureWarmupStarted, getBackendReadiness } from '../services/warmupService.ts';
import { getStoreStatus } from '../services/storeReadiness.ts';
import { perfLog } from '../utils/perfLog.ts';

export function handleWarmup(req: Request, res: Response): void {
  const receivedAt = Date.now();
  const body = req.body as { zipcode?: string };
  const zipcode = body.zipcode?.trim();
  perfLog('warmup:request-received', { zipcode });

  if (zipcode && !/^\d{5}$/.test(zipcode)) {
    res.status(400).json({ error: '`zipcode` must be a 5-digit US zip code.' });
    return;
  }

  // Fire-and-forget — see this file's own header comment. Never awaited.
  ensureWarmupStarted(zipcode);

  // Scoped to THIS request's own zipcode — see warmupService.ts's
  // `stateByKey` comment for why this must never read a shared global
  // flag (a concurrent, different shopper's in-progress or just-finished
  // cycle must never make this response falsely 'warming' or, worse,
  // falsely 'ready' for a zip that hasn't actually been warmed itself).
  const readiness = getBackendReadiness(zipcode);
  res.json({
    status: readiness.status,
    searchReady: readiness.searchReady,
    uptimeMs: readiness.uptimeMs,
    zipcode,
    stores: readiness.lastResult?.stores,
    // Per-store ready/warming state (storeReadiness.ts) — independent of
    // `status` above, which only reflects whether a whole warm-up CYCLE has
    // run. A shopper's client can use this to show which specific store is
    // still bootstrapping rather than just "ready" or not.
    storeStatus: getStoreStatus(),
  });
  perfLog('warmup:response-sent', { zipcode, status: readiness.status, handlerMs: Date.now() - receivedAt });
}

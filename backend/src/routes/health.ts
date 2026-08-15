/**
 * GET /api/health — the cheapest possible "is the process up" check:
 * no body parsing, no zip validation, no warm-up side effect. Exists so
 * an external uptime monitor (UptimeRobot, cron-job.org, a Render Cron
 * Job hitting this on a schedule, ...) has something to ping every few
 * minutes to keep a free/starter-tier Render service from spinning down
 * to begin with — nothing running *inside* this process can prevent
 * Render from suspending it when idle. Deliberately separate from
 * /api/warmup: this route never triggers warm-up work, so a keep-alive
 * pinger can't accidentally cause repeated, pointless re-warming.
 *
 * `getBackendReadiness()` is a synchronous, in-memory snapshot read (see
 * warmupService.ts) — no network calls, no store calls, no awaiting
 * anything. Always responds 200 regardless of the current readiness
 * status: an uptime monitor/Render health check only needs to know the
 * process itself is alive and accepting connections, not that every store
 * integration has finished warming.
 */
import type { Request, Response } from 'express';
import { getBackendReadiness } from '../services/warmupService.ts';

export function handleHealth(_req: Request, res: Response): void {
  const readiness = getBackendReadiness();
  res.json({ status: 'ok', backendStatus: readiness.status, uptimeMs: readiness.uptimeMs });
}

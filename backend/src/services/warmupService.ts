/**
 * Orchestrates app-startup warm-up: moves the one-time initialization costs
 * that used to be paid by whichever request happened to arrive first
 * (Kroger's OAuth2 token, Aldi/Sprouts' anonymous session cookies, Trader
 * Joe's browser session + store directory, and — once a zip is known —
 * each store's nearest-location lookup) out of the search path entirely.
 *
 * Two call sites use this:
 *   - index.ts calls `runWarmup()` with no zip at server boot, fire-and-
 *     forget, to pre-warm everything that doesn't depend on a shopper's
 *     location before any request arrives.
 *   - routes/warmup.ts calls `runWarmup(zipcode)` per app-open, once the
 *     app knows (or the shopper has previously saved) a zip, to also warm
 *     the per-store nearest-location caches for that specific area.
 */
import { warmKroger } from './krogerLiveScraper.ts';
import { warmAldi } from './aldiLiveScraper.ts';
import { warmSprouts } from './sproutsLiveScraper.ts';
import { warmTraderJoes } from './traderJoesLiveScraper.ts';
import { perfLog } from '../utils/perfLog.ts';

export interface WarmupStoreResult {
  store: string;
  ok: boolean;
  ms: number;
  error?: string;
}

export interface WarmupResult {
  startedAt: number;
  completedAt: number;
  totalMs: number;
  zipcode?: string;
  stores: WarmupStoreResult[];
}

interface WarmupTask {
  store: string;
  run: () => Promise<void>;
}

/**
 * Runs every task in parallel, times each one individually, and never lets
 * one task's failure affect another's — a warm-up is pure optimization, so
 * a store whose session/token fetch fails here just means that store pays
 * its normal lazy-init cost on its own first real search instead, exactly
 * like before this feature existed. Pulled out of `runWarmup` (which also
 * owns the real store list + dedup singleton) so this aggregation/timing
 * logic is unit-testable against fake tasks, without hitting real network.
 */
export async function warmAll(tasks: WarmupTask[]): Promise<WarmupStoreResult[]> {
  return Promise.all(
    tasks.map(async ({ store, run }) => {
      const start = Date.now();
      try {
        await run();
        const ms = Date.now() - start;
        perfLog('warmup:store-complete', { store, ok: true, ms });
        return { store, ok: true, ms };
      } catch (err) {
        const ms = Date.now() - start;
        const error = err instanceof Error ? err.message : String(err);
        perfLog('warmup:store-complete', { store, ok: false, ms, error });
        return { store, ok: false, ms, error };
      }
    }),
  );
}

function buildTasks(zipcode?: string): WarmupTask[] {
  return [
    { store: "Trader Joe's", run: () => warmTraderJoes(zipcode) },
    { store: 'Sprouts', run: () => warmSprouts(zipcode) },
    { store: 'Kroger', run: () => warmKroger(zipcode) },
    { store: 'Aldi', run: () => warmAldi(zipcode) },
  ];
}

// A warm-up already in flight is shared rather than duplicated — guards
// against the server-boot self-warm and an app-open /api/warmup call
// overlapping, and against duplicate app-open calls (app reload, component
// remount, a shopper backgrounding/reopening quickly). Keyed by zipcode so
// a *different* zip still triggers its own (zip-specific) locator warm-up
// rather than silently reusing another zip's in-flight result; the
// zip-independent pieces (token/session/directory) are already deduped one
// level down by each store's own module-level cache regardless.
const inFlight = new Map<string, Promise<WarmupResult>>();

export function runWarmup(zipcode?: string): Promise<WarmupResult> {
  const key = zipcode ?? '';
  const existing = inFlight.get(key);
  if (existing) return existing;

  const startedAt = Date.now();
  perfLog('warmup:start', { zipcode });

  const promise = warmAll(buildTasks(zipcode)).then((stores) => {
    const completedAt = Date.now();
    const result: WarmupResult = {
      startedAt,
      completedAt,
      totalMs: completedAt - startedAt,
      zipcode,
      stores,
    };
    const okCount = stores.filter((s) => s.ok).length;
    perfLog('warmup:complete', { zipcode, totalMs: result.totalMs, ok: `${okCount}/${stores.length}` });
    return result;
  });

  inFlight.set(key, promise);
  // Once settled, let a later call retry (e.g. after a transient network
  // failure) instead of permanently caching a failed attempt's promise.
  promise.finally(() => inFlight.delete(key));
  return promise;
}

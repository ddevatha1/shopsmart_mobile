// setInterval/setTimeout's delay is a 32-bit signed int internally — a
// delay above ~24.8 days silently overflows, and Node clamps it to 1ms
// instead (with a `TimeoutOverflowWarning`) rather than throwing. A
// consumer here really does use a 30-day TTL (traderJoesLocator.ts's
// store-detail cache), which — before this cap — turned the sweep below
// into a runaway 1ms-interval loop scanning the whole store on every
// tick, real, observed damage: it single-handedly stalled the event loop
// long enough to make one live search take 27s instead of ~1.5s. Sweeping
// more often than a cache's own TTL is harmless (just extra, cheap scans
// of what's usually a small Map) — this exists purely to keep the actual
// `setInterval` delay representable, never to change eviction semantics.
const MAX_SWEEP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

// Minimal in-memory TTL cache used by every live store integration to avoid
// re-fetching the same query from an upstream API/scraper within a short window.
export class TtlCache<T> {
  private store = new Map<string, { ts: number; value: T }>();
  private ttlMs: number;
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(ttlMs: number) {
    this.ttlMs = ttlMs;
  }

  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.ts >= this.ttlMs) {
      // Evict on read too, not just via the periodic sweep below — makes
      // a just-expired key immediately reusable without waiting for the
      // next sweep tick.
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T): void {
    this.store.set(key, { ts: Date.now(), value });
    this.scheduleSweep();
  }

  // Bounds memory in a long-running process: a key that's never looked up
  // again after it expires (e.g. a one-off search query no shopper
  // repeats) would otherwise sit in `store` forever — `get()` above only
  // reclaims a stale entry when that exact key is read again, which a
  // never-repeated key never triggers. A periodic sweep, running at most
  // once per `ttlMs`, is what actually reclaims those. Lazily started on
  // first `set()` (an idle/unused cache never runs a timer) and
  // `unref()`'d so it can never keep the Node process alive on its own —
  // e.g. during tests or a graceful shutdown.
  private scheduleSweep(): void {
    if (this.sweepTimer) return;
    const interval = Math.min(this.ttlMs, MAX_SWEEP_INTERVAL_MS);
    const timer = setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of this.store) {
        if (now - entry.ts >= this.ttlMs) this.store.delete(key);
      }
    }, interval);
    timer.unref?.();
    this.sweepTimer = timer;
  }
}

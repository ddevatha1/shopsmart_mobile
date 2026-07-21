// Minimal in-memory TTL cache used by every live store integration to avoid
// re-fetching the same query from an upstream API/scraper within a short window.
export class TtlCache<T> {
  private store = new Map<string, { ts: number; value: T }>();
  private ttlMs: number;

  constructor(ttlMs: number) {
    this.ttlMs = ttlMs;
  }

  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry || Date.now() - entry.ts >= this.ttlMs) return undefined;
    return entry.value;
  }

  set(key: string, value: T): void {
    this.store.set(key, { ts: Date.now(), value });
  }
}

// Coalesces concurrent calls for the same key into a single in-flight
// promise, rather than letting each caller kick off its own redundant async
// work — the exact gap that let app-startup warm-up and a racing shopper's
// first real search independently re-fetch the same OAuth token, session
// cookie, or store-location lookup at the same time. Same pattern as
// warmupService.ts's own `inFlight` map, made reusable across every store
// integration's token/session/locator getters.
const inFlight = new Map<string, Promise<unknown>>();

export function dedupeInFlight<T>(key: string, run: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key);
  if (existing) return existing as Promise<T>;

  const promise = run().finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}

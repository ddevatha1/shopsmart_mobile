// Lightweight timestamped instrumentation for comparing "cold" (first
// search before warm-up existed) vs "warm" (after startup warm-up) search
// latency — every line is prefixed `[Perf]` so it's trivially greppable out
// of the mixed `[Kroger]`/`[Aldi]`/... server logs. `+Nms` is elapsed time
// since this module first loaded, i.e. since the server process booted —
// the same reference point every event in a given process log shares, so
// "warmup:start" vs "first-search:start" deltas are directly comparable.
const processStart = Date.now();

export function perfLog(event: string, meta?: Record<string, unknown>): void {
  const elapsedMs = Date.now() - processStart;
  const suffix = meta ? ` ${JSON.stringify(meta)}` : '';
  console.log(`[Perf] ${event} +${elapsedMs}ms${suffix}`);
}

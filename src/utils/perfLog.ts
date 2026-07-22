// Lightweight timestamped instrumentation for comparing first-search
// latency before vs. after warm-up — every line is prefixed `[Perf]` so
// it's trivially greppable out of the rest of the app's logs. `+Nms` is
// elapsed time since this module first loaded, i.e. since the JS bundle
// started executing (effectively app open) — the same reference point
// every event in a given app session shares, so "warmup:start" vs
// "first-search:start" deltas are directly comparable.
const appStart = Date.now();

export function perfLog(event: string, meta?: Record<string, unknown>): void {
  const elapsedMs = Date.now() - appStart;
  const suffix = meta ? ` ${JSON.stringify(meta)}` : '';
  console.log(`[Perf] ${event} +${elapsedMs}ms${suffix}`);
}

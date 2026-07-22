import { create } from 'zustand';
import { apiClient, type WarmupResult } from '../services/apiClient';
import { perfLog } from '../utils/perfLog';

export type WarmupStatus = 'idle' | 'warming' | 'ready' | 'error';

interface WarmupState {
  status: WarmupStatus;
  result: WarmupResult | null;
  /** Guards markFirstSearchStart/markFirstSearchComplete so only the very
   * first search of this app session gets the extra `[Perf] first-search:*`
   * logging — every later search is expected (and unremarkable) to be
   * fast, warm-up or not. */
  firstSearchStarted: boolean;
  firstSearchLogged: boolean;
  /** Fire-and-forget background warm-up, called once at app open (see
   * App.tsx). Never blocks the caller and never throws — a failed warm-up
   * just means search pays its normal lazy-init cost on the first request,
   * exactly like before this feature existed. Deduped: a second call while
   * one is already in flight (app reload, component remount, a shopper
   * backgrounding/reopening quickly) reuses the same in-flight attempt
   * rather than starting a redundant one. */
  warmup: (zipcode?: string) => Promise<void>;
  /** Called once by the search flow, right before the very first search of
   * the app session fires — logs a `[Perf] first-search:start` line and,
   * if warm-up is still in progress, notes that the search is racing it. */
  markFirstSearchStart: () => void;
  markFirstSearchComplete: () => void;
}

let inFlight: Promise<void> | null = null;

export const useWarmupStore = create<WarmupState>((set, get) => ({
  status: 'idle',
  result: null,
  firstSearchStarted: false,
  firstSearchLogged: false,

  warmup: async (zipcode) => {
    if (inFlight) return inFlight;
    if (get().status === 'ready' && get().result?.zipcode === zipcode) return;

    set({ status: 'warming' });
    perfLog('warmup:start', { zipcode });

    const run = (async () => {
      const result = await apiClient.warmup(zipcode);
      if (result) {
        const okCount = result.stores.filter((s) => s.ok).length;
        perfLog('warmup:complete', { zipcode, totalMs: result.totalMs, ok: `${okCount}/${result.stores.length}` });
        set({ status: 'ready', result });
      } else {
        // Best-effort only — search still works, it just won't have had
        // the benefit of warm-up. Never surfaced as a user-facing error.
        perfLog('warmup:failed', { zipcode });
        set({ status: 'error' });
      }
    })();

    inFlight = run;
    try {
      await run;
    } finally {
      inFlight = null;
    }
  },

  markFirstSearchStart: () => {
    if (get().firstSearchStarted) return;
    set({ firstSearchStarted: true });
    perfLog('first-search:start', { warmupStatus: get().status });
  },

  markFirstSearchComplete: () => {
    if (get().firstSearchLogged) return;
    perfLog('first-search:complete', { warmupStatus: get().status });
    set({ firstSearchLogged: true });
  },
}));

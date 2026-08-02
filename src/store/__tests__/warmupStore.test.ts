import { apiClient, type WarmupResult } from '../../services/apiClient';
import { getCachedOrFetchSearch } from '../../services/searchCacheService';
import { useWarmupStore } from '../warmupStore';

jest.mock('../../services/apiClient', () => ({
  apiClient: { warmup: jest.fn() },
}));
jest.mock('../../services/searchCacheService', () => ({
  getCachedOrFetchSearch: jest.fn(),
}));

const mockedWarmup = apiClient.warmup as jest.Mock;
const mockedSearch = getCachedOrFetchSearch as jest.Mock;

function makeReady(overrides: Partial<WarmupResult> = {}): WarmupResult {
  return { status: 'ready', searchReady: true, uptimeMs: 1, stores: [{ store: 'Aldi', ok: true, ms: 1 }], ...overrides };
}

function makeWarming(overrides: Partial<WarmupResult> = {}): WarmupResult {
  return { status: 'warming', searchReady: false, uptimeMs: 1, ...overrides };
}

function resetStore() {
  useWarmupStore.setState({
    status: 'idle',
    result: null,
    backgroundSearchDone: false,
    firstSearchStarted: false,
    firstSearchLogged: false,
  });
}

describe('useWarmupStore', () => {
  beforeEach(() => {
    resetStore();
    mockedWarmup.mockReset();
    mockedSearch.mockReset();
    mockedSearch.mockResolvedValue({ response: { products: [], storeStatuses: [] }, cacheHit: false });
  });

  test('status becomes ready only after both the backend reporting "ready" AND the dummy search settle', async () => {
    mockedWarmup.mockResolvedValue(makeReady());
    const promise = useWarmupStore.getState().warmup('90210');

    // Not ready yet — still resolving inside the async IIFE.
    await Promise.resolve();
    expect(useWarmupStore.getState().status).toBe('warming');

    await promise;
    expect(useWarmupStore.getState().status).toBe('ready');
    expect(mockedSearch).toHaveBeenCalledWith('milk', '90210', { noCorrect: true });
  });

  test('polls again (rather than giving up) while the backend reports "warming", until it reports "ready"', async () => {
    jest.useFakeTimers();
    try {
      mockedWarmup
        .mockResolvedValueOnce(makeWarming())
        .mockResolvedValueOnce(makeWarming())
        .mockResolvedValueOnce(makeReady({ zipcode: '90210' }));

      const promise = useWarmupStore.getState().warmup('90210');
      await jest.advanceTimersByTimeAsync(1500);
      await jest.advanceTimersByTimeAsync(1500);
      await promise;

      expect(mockedWarmup).toHaveBeenCalledTimes(3);
      expect(useWarmupStore.getState().status).toBe('ready');
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  test('a zip-specific call does not silently reuse a still-in-flight zip-less attempt', async () => {
    let resolveZipless!: (v: unknown) => void;
    mockedWarmup.mockImplementation((zipcode?: string) => {
      if (!zipcode) return new Promise((resolve) => { resolveZipless = resolve; });
      return Promise.resolve(makeReady({ zipcode }));
    });

    const ziplessPromise = useWarmupStore.getState().warmup(); // no zip — stays pending
    const zipSpecificPromise = useWarmupStore.getState().warmup('90210'); // should NOT reuse the pending zip-less call

    await zipSpecificPromise;
    expect(mockedWarmup).toHaveBeenCalledWith('90210');
    expect(mockedWarmup).toHaveBeenCalledWith(undefined);
    expect(mockedSearch).toHaveBeenCalledWith('milk', '90210', { noCorrect: true });

    resolveZipless(makeReady());
    await ziplessPromise;
  });

  test('a second call with the exact same in-flight zip key reuses the same attempt', async () => {
    let resolveWarmup!: (v: unknown) => void;
    mockedWarmup.mockReturnValue(new Promise((resolve) => { resolveWarmup = resolve; }));

    const first = useWarmupStore.getState().warmup('90210');
    const second = useWarmupStore.getState().warmup('90210');

    resolveWarmup(makeReady({ zipcode: '90210' }));
    await Promise.all([first, second]);

    expect(mockedWarmup).toHaveBeenCalledTimes(1);
  });

  test('waitForWarmup resolves once the latest attempt settles, and is a no-op before any warm-up starts', async () => {
    await expect(useWarmupStore.getState().waitForWarmup()).resolves.toBeUndefined();

    let resolveWarmup!: (v: unknown) => void;
    mockedWarmup.mockReturnValue(new Promise((resolve) => { resolveWarmup = resolve; }));
    const warmupPromise = useWarmupStore.getState().warmup('90210');

    let waited = false;
    const waitPromise = useWarmupStore.getState().waitForWarmup().then(() => { waited = true; });

    expect(waited).toBe(false);
    resolveWarmup(makeReady({ zipcode: '90210' }));
    await warmupPromise;
    await waitPromise;
    expect(waited).toBe(true);
    expect(useWarmupStore.getState().status).toBe('ready');
  });

  test('status becomes error (not "warming") when the backend is genuinely unreachable, but waitForWarmup still resolves', async () => {
    // A failed attempt schedules a background retry (see runWarmupAttempt's
    // RETRY_DELAYS_MS) — fake timers keep that setTimeout from leaking past
    // this test as a real, still-pending OS timer.
    jest.useFakeTimers();
    try {
      mockedWarmup.mockResolvedValue(null);
      await useWarmupStore.getState().warmup('90210');
      expect(useWarmupStore.getState().status).toBe('error');
      await expect(useWarmupStore.getState().waitForWarmup()).resolves.toBeUndefined();
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  test('an unreachable attempt retries in the background and can still succeed', async () => {
    jest.useFakeTimers();
    try {
      mockedWarmup.mockResolvedValueOnce(null).mockResolvedValueOnce(makeReady({ zipcode: '90210' }));
      await useWarmupStore.getState().warmup('90210');
      expect(useWarmupStore.getState().status).toBe('error');
      expect(mockedWarmup).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(3000);
      expect(mockedWarmup).toHaveBeenCalledTimes(2);
      expect(useWarmupStore.getState().status).toBe('ready');
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  test('exhausting the poll budget while still "warming" (a real, ongoing cold start) keeps status "warming", never "error", and retries in the background', async () => {
    jest.useFakeTimers();
    try {
      // Every poll within the first attempt reports "warming" — never
      // unreachable, never ready. POLL_MAX_ATTEMPTS is 4, so 4 calls,
      // 3 inter-poll delays, before this attempt gives up and schedules
      // a background retry.
      mockedWarmup.mockResolvedValue(makeWarming());
      const promise = useWarmupStore.getState().warmup('90210');

      await jest.advanceTimersByTimeAsync(1500);
      await jest.advanceTimersByTimeAsync(1500);
      await jest.advanceTimersByTimeAsync(1500);
      await promise;

      expect(mockedWarmup).toHaveBeenCalledTimes(4);
      // The honest status — the backend is alive and working, just not
      // done yet. Never reported as an error.
      expect(useWarmupStore.getState().status).toBe('warming');

      // The background retry (scheduled the same as an unreachable
      // failure) can still bring it to ready.
      mockedWarmup.mockResolvedValue(makeReady({ zipcode: '90210' }));
      await jest.advanceTimersByTimeAsync(3000);
      expect(useWarmupStore.getState().status).toBe('ready');
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });
});

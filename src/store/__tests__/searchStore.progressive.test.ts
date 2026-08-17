import { useSearchStore } from '../searchStore';
import { searchRepository } from '../../repositories/searchRepository';
import type { SearchResponse, ApiProduct } from '../../models/types';

// Irrelevant to what's under test here (progressive results/polling/stale-
// search guarding) and both touch device storage in ways this test doesn't
// need to exercise — stubbed out so this stays a fast, hermetic unit test.
jest.mock('../../services/priceHistoryService', () => ({ recordObservations: jest.fn() }));
jest.mock('../../store/guestZipStore', () => ({
  useGuestZipStore: { getState: () => ({ resolveZipcode: jest.fn().mockResolvedValue('75035') }) },
}));
jest.mock('../../store/guestSearchHistoryStore', () => ({
  useGuestSearchHistoryStore: { getState: () => ({ track: jest.fn() }) },
}));
jest.mock('../../store/warmupStore', () => ({
  useWarmupStore: { getState: () => ({ markFirstSearchStart: jest.fn(), markFirstSearchComplete: jest.fn() }) },
}));

jest.mock('../../repositories/searchRepository', () => ({
  searchRepository: { search: jest.fn(), status: jest.fn() },
}));

const mockedSearch = searchRepository.search as jest.Mock;
const mockedStatus = searchRepository.status as jest.Mock;

function product(id: string, store: ApiProduct['store']): ApiProduct {
  return { id, name: `Product ${id}`, brand: 'Brand', price: 3, rating: 4, size: '1 ea', store };
}

function response(overrides: Partial<SearchResponse>): SearchResponse {
  return {
    products: [],
    storeStatuses: [
      { store: "Trader Joe's", status: 'success', count: 0 },
      { store: 'Sprouts', status: 'success', count: 0 },
      { store: 'Kroger', status: 'success', count: 0 },
      { store: 'Aldi', status: 'success', count: 0 },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  useSearchStore.setState({
    hasSearched: false, loading: false, error: null, products: [], storeStatuses: [],
    activeQuery: '', activeZip: '', needsLocation: false, correction: null,
  });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('searchStore progressive results', () => {
  test('an initial response with no pending stores never starts polling', async () => {
    mockedSearch.mockResolvedValue(response({
      products: [product('k1', 'Kroger')],
      searchId: 'abc123',
    }));

    await useSearchStore.getState().search('milk');

    expect(useSearchStore.getState().loading).toBe(false);
    expect(useSearchStore.getState().products).toHaveLength(1);
    // Advancing time well past the poll interval must never call status() —
    // there was nothing pending to poll for.
    await jest.advanceTimersByTimeAsync(5000);
    expect(mockedStatus).not.toHaveBeenCalled();
  });

  test('a pending store in the initial response is polled and merged in once it resolves', async () => {
    mockedSearch.mockResolvedValue(response({
      products: [product('k1', 'Kroger')],
      storeStatuses: [
        { store: "Trader Joe's", status: 'pending', count: 0 },
        { store: 'Sprouts', status: 'success', count: 0 },
        { store: 'Kroger', status: 'success', count: 1 },
        { store: 'Aldi', status: 'success', count: 0 },
      ],
      searchId: 'poll-me',
    }));
    mockedStatus.mockResolvedValue(response({
      products: [product('k1', 'Kroger'), product('tj1', "Trader Joe's")],
      storeStatuses: [
        { store: "Trader Joe's", status: 'success', count: 1 },
        { store: 'Sprouts', status: 'success', count: 0 },
        { store: 'Kroger', status: 'success', count: 1 },
        { store: 'Aldi', status: 'success', count: 0 },
      ],
      searchId: 'poll-me',
    }));

    await useSearchStore.getState().search('chicken');
    // loading comes down immediately from the initial (partial) response —
    // the shopper isn't stuck on a spinner while Trader Joe's is pending.
    expect(useSearchStore.getState().loading).toBe(false);
    expect(useSearchStore.getState().products).toHaveLength(1);

    // Let the poll loop's first tick fire and resolve.
    await jest.advanceTimersByTimeAsync(1000);
    await Promise.resolve();
    await Promise.resolve();

    expect(mockedStatus).toHaveBeenCalledWith('poll-me');
    expect(useSearchStore.getState().products).toHaveLength(2);
    expect(useSearchStore.getState().storeStatuses.find(s => s.store === "Trader Joe's")?.status).toBe('success');
  });

  test('a newer search discards a stale poll result from the previous search', async () => {
    mockedSearch.mockResolvedValueOnce(response({
      products: [product('k1', 'Kroger')],
      storeStatuses: [
        { store: "Trader Joe's", status: 'pending', count: 0 },
        { store: 'Sprouts', status: 'success', count: 0 },
        { store: 'Kroger', status: 'success', count: 1 },
        { store: 'Aldi', status: 'success', count: 0 },
      ],
      searchId: 'chicken-search',
    }));
    // Simulate the late poll for the FIRST ("chicken") search never
    // resolving quickly — it should simply never be applied once a second
    // search has started.
    mockedStatus.mockImplementation(() => new Promise(() => {}));

    await useSearchStore.getState().search('chicken');
    expect(useSearchStore.getState().products).toHaveLength(1);

    // Second search supersedes the first before its poll loop ever ticks.
    mockedSearch.mockResolvedValueOnce(response({
      products: [product('m1', 'Aldi')],
      searchId: 'milk-search',
    }));
    await useSearchStore.getState().search('milk');

    expect(useSearchStore.getState().activeQuery).toBe('milk');
    expect(useSearchStore.getState().products.map(p => p.id)).toEqual(['m1']);

    // Even after the poll interval elapses, nothing from the superseded
    // 'chicken' search's poll loop should ever land — the loop itself
    // checks the generation before applying anything.
    await jest.advanceTimersByTimeAsync(2000);
    expect(useSearchStore.getState().activeQuery).toBe('milk');
    expect(useSearchStore.getState().products.map(p => p.id)).toEqual(['m1']);
  });

  test('polling stops once every store reaches a terminal status', async () => {
    mockedSearch.mockResolvedValue(response({
      storeStatuses: [
        { store: "Trader Joe's", status: 'pending', count: 0 },
        { store: 'Sprouts', status: 'success', count: 0 },
        { store: 'Kroger', status: 'success', count: 0 },
        { store: 'Aldi', status: 'success', count: 0 },
      ],
      searchId: 'settles-fast',
    }));
    mockedStatus.mockResolvedValue(response({
      storeStatuses: [
        { store: "Trader Joe's", status: 'error', count: 0, error: 'boom' },
        { store: 'Sprouts', status: 'success', count: 0 },
        { store: 'Kroger', status: 'success', count: 0 },
        { store: 'Aldi', status: 'success', count: 0 },
      ],
      searchId: 'settles-fast',
    }));

    await useSearchStore.getState().search('eggs');
    await jest.advanceTimersByTimeAsync(1000);
    await Promise.resolve();
    await Promise.resolve();
    expect(mockedStatus).toHaveBeenCalledTimes(1);

    // No store is 'pending' anymore (Trader Joe's settled to 'error') — a
    // further tick must not poll again.
    await jest.advanceTimersByTimeAsync(3000);
    expect(mockedStatus).toHaveBeenCalledTimes(1);
  });
});

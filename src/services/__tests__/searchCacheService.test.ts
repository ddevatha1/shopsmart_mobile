import { searchRepository } from '../../repositories/searchRepository';
import { getCachedOrFetchSearch, clearSearchCacheForTests } from '../searchCacheService';
import type { SearchResponse } from '../../models/types';

jest.mock('../../repositories/searchRepository', () => ({
  searchRepository: { search: jest.fn() },
}));

const mockedSearch = searchRepository.search as jest.Mock;

function makeResponse(overrides: Partial<SearchResponse> = {}): SearchResponse {
  return { products: [], storeStatuses: [], ...overrides };
}

describe('getCachedOrFetchSearch', () => {
  beforeEach(() => {
    clearSearchCacheForTests();
    mockedSearch.mockReset();
  });

  test('a cache miss calls the repository and reports cacheHit: false', async () => {
    const response = makeResponse();
    mockedSearch.mockResolvedValue(response);

    const result = await getCachedOrFetchSearch('milk', '90210');

    expect(mockedSearch).toHaveBeenCalledTimes(1);
    expect(result.cacheHit).toBe(false);
    expect(result.response).toBe(response);
  });

  test('an identical repeat search resolves from cache without a second network call', async () => {
    mockedSearch.mockResolvedValue(makeResponse());

    await getCachedOrFetchSearch('milk', '90210');
    const second = await getCachedOrFetchSearch('milk', '90210');

    expect(mockedSearch).toHaveBeenCalledTimes(1);
    expect(second.cacheHit).toBe(true);
  });

  test('a different query, zipcode, or noCorrect flag is treated as a distinct cache entry', async () => {
    mockedSearch.mockResolvedValue(makeResponse());

    await getCachedOrFetchSearch('milk', '90210');
    await getCachedOrFetchSearch('eggs', '90210');
    await getCachedOrFetchSearch('milk', '10001');
    await getCachedOrFetchSearch('milk', '90210', { noCorrect: true });

    expect(mockedSearch).toHaveBeenCalledTimes(4);
  });

  test('two concurrent identical requests share one in-flight network call', async () => {
    let resolveSearch!: (response: SearchResponse) => void;
    mockedSearch.mockReturnValue(new Promise((resolve) => { resolveSearch = resolve; }));

    const first = getCachedOrFetchSearch('milk', '90210');
    const second = getCachedOrFetchSearch('milk', '90210');
    resolveSearch(makeResponse());
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(mockedSearch).toHaveBeenCalledTimes(1);
    expect(firstResult.response).toBe(secondResult.response);
  });

  test('a failed search is never cached — the next attempt retries for real', async () => {
    mockedSearch.mockRejectedValueOnce(new Error('network down'));
    mockedSearch.mockResolvedValueOnce(makeResponse());

    await expect(getCachedOrFetchSearch('milk', '90210')).rejects.toThrow('network down');
    const result = await getCachedOrFetchSearch('milk', '90210');

    expect(mockedSearch).toHaveBeenCalledTimes(2);
    expect(result.cacheHit).toBe(false);
  });

  test('coordinates are rounded so ordinary GPS jitter still hits the same cache entry', async () => {
    mockedSearch.mockResolvedValue(makeResponse());

    await getCachedOrFetchSearch('milk', '90210', { latitude: 34.0522001, longitude: -118.2437001 });
    const second = await getCachedOrFetchSearch('milk', '90210', { latitude: 34.0522009, longitude: -118.2437009 });

    expect(mockedSearch).toHaveBeenCalledTimes(1);
    expect(second.cacheHit).toBe(true);
  });
});

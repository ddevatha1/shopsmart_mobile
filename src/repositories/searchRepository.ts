import { apiClient } from '../services/apiClient';
import type { SearchResponse } from '../models/types';

/**
 * Deliberately thin — all search business logic (relevance ranking, food
 * filtering, per-store price handling, store fan-out) lives server-side in
 * this app's own backend/ (an Express server independent of shopsmart_web,
 * ported from its /api/search route). This repository exists only so
 * screens don't call fetch() directly, matching the project's layering
 * convention.
 */
export const searchRepository = {
  search(query: string, zipcode: string, options?: { noCorrect?: boolean }): Promise<SearchResponse> {
    return apiClient.search(query, zipcode, options);
  },
};

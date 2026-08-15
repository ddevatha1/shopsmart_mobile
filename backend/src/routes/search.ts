/**
 * POST /api/search — thin Express wrapper around startProgressiveSearch
 * (see services/searchService.ts). Uses the progressive path, not
 * `performSearch` directly, so this HTTP route returns as soon as the
 * first store has a real result instead of waiting for every store —
 * `performSearch` itself is unchanged and still used as-is by other
 * server-side code (the Smart Shopping Planner's optimizer), which needs a
 * single complete-as-possible result per grocery-list item rather than a
 * fast-but-partial one. Mirrors shopsmart_web's app/api/search/route.ts.
 */
import type { Request, Response } from 'express';
import { startProgressiveSearch, getSearchSnapshot } from '../services/searchService.ts';

export async function handleSearch(req: Request, res: Response): Promise<void> {
  const body = req.body as { query?: string; zipcode?: string; noCorrect?: boolean };

  const rawQuery = body.query?.trim();
  const zipcode = body.zipcode?.trim();

  if (!rawQuery || !zipcode) {
    res.status(400).json({ error: '`query` and `zipcode` are required.' });
    return;
  }

  if (!/^\d{5}$/.test(zipcode)) {
    res.status(400).json({ error: '`zipcode` must be a 5-digit US zip code.' });
    return;
  }

  try {
    const response = await startProgressiveSearch(rawQuery, zipcode, { noCorrect: body.noCorrect });
    res.json(response);
  } catch (err) {
    console.warn('[Search] search failed:', err);
    res.status(502).json({ error: err instanceof Error ? err.message : 'Could not complete the search.' });
  }
}

/**
 * GET /api/search/:searchId — polled by the client to pick up whichever
 * stores were still 'pending' in the original /api/search response, as
 * they finish. Never re-issues or restarts any store's search — this is a
 * pure read of state that `startProgressiveSearch` already kicked off
 * exactly once (see getSearchSnapshot's own comment). 404 for an unknown
 * or expired searchId (the client's poll loop stops on any non-2xx), never
 * a fabricated empty result.
 */
export function handleSearchStatus(req: Request, res: Response): void {
  const rawSearchId = req.params.searchId;
  const searchId = typeof rawSearchId === 'string' ? rawSearchId.trim() : '';
  if (!searchId) {
    res.status(400).json({ error: '`searchId` is required.' });
    return;
  }

  const response = getSearchSnapshot(searchId);
  if (!response) {
    res.status(404).json({ error: 'Unknown or expired searchId.' });
    return;
  }

  res.json(response);
}

/**
 * POST /api/search — thin Express wrapper around performSearch (see
 * services/searchService.ts, which holds the actual pipeline). Split out so
 * other server-side code (the Smart Shopping Planner's optimizer) can call
 * performSearch directly instead of issuing an HTTP request back to this
 * same server. Mirrors shopsmart_web's app/api/search/route.ts.
 */
import type { Request, Response } from 'express';
import { performSearch } from '../services/searchService.ts';

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
    const response = await performSearch(rawQuery, zipcode, { noCorrect: body.noCorrect });
    res.json(response);
  } catch (err) {
    console.warn('[Search] search failed:', err);
    res.status(502).json({ error: err instanceof Error ? err.message : 'Could not complete the search.' });
  }
}

/**
 * POST /api/planner — Smart Shopping Planner. Body items are already
 * ambiguity-resolved on the client (see src/services/plannerAmbiguityService.ts)
 * before this is ever called — this route only runs the optimizer. Mirrors
 * shopsmart_web's app/api/planner/route.ts.
 */
import type { Request, Response } from 'express';
import type { PlannerListItem, ShoppingPlanRequest } from '../types/index.ts';
import { buildShoppingPlan } from '../services/shoppingPlanOptimizer.ts';

function isPlannerListItem(value: unknown): value is PlannerListItem {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === 'string' && typeof v.rawText === 'string';
}

export async function handlePlanner(req: Request, res: Response): Promise<void> {
  const body = req.body as Partial<ShoppingPlanRequest>;

  const zipcode = body.zipcode?.trim();
  if (!zipcode || !/^\d{5}$/.test(zipcode)) {
    res.status(400).json({ error: '`zipcode` must be a 5-digit US zip code.' });
    return;
  }

  if (!Array.isArray(body.items) || body.items.length === 0 || !body.items.every(isPlannerListItem)) {
    res.status(400).json({ error: '`items` must be a non-empty array of resolved list items.' });
    return;
  }

  try {
    const plan = await buildShoppingPlan(body.items, zipcode);
    res.json(plan);
  } catch (err) {
    console.warn('[Planner] plan generation failed:', err);
    res.status(502).json({ error: err instanceof Error ? err.message : 'Could not build a shopping plan.' });
  }
}

/**
 * POST /api/meal-plan — Meal Planner v1 (Phase 5.0). A domain service
 * endpoint, exactly like /api/planner or /api/search: NOT part of the
 * Assistant Boundary's classification-only surface (/api/assistant/intent).
 * This route only ever runs the deterministic template generator (see
 * services/mealPlanService.ts) — no AI, no prices, no cart mutation, no
 * side effects of any kind.
 */
import type { Request, Response } from 'express';
import type { MealPlanGenerationRequest } from '../types/index.ts';
import { generateMealPlan } from '../services/mealPlanService.ts';

const MAX_MEAL_COUNT = 14;

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

export function handleMealPlan(req: Request, res: Response): void {
  const body = req.body as Partial<MealPlanGenerationRequest>;

  if (typeof body.mealCount !== 'number' || !Number.isFinite(body.mealCount) || body.mealCount < 1) {
    res.status(400).json({ error: '`mealCount` must be a positive number.' });
    return;
  }

  if (body.mealType !== undefined && body.mealType !== 'breakfast' && body.mealType !== 'dinner') {
    res.status(400).json({ error: '`mealType`, when present, must be "breakfast" or "dinner".' });
    return;
  }

  if (body.lowStockItems !== undefined && !isStringArray(body.lowStockItems)) {
    res.status(400).json({ error: '`lowStockItems`, when present, must be an array of strings.' });
    return;
  }

  const result = generateMealPlan({
    mealCount: Math.min(body.mealCount, MAX_MEAL_COUNT),
    mealType: body.mealType ?? 'dinner',
    lowStockItems: body.lowStockItems,
  });
  res.json(result);
}

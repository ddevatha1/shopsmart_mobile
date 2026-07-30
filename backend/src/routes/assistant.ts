/**
 * POST /api/assistant/intent — resolves free-form text to a closed-
 * vocabulary Intent (see services/intentRouterService.ts's
 * resolveHybridIntent — Phase 4.1's hybrid, tiered classifier). This
 * route is deliberately thin and does exactly ONE thing: classification.
 * It does NOT execute a search, modify a cart, call the planner, or
 * generate any response text — those all happen later, on the mobile
 * side, only after the mobile app's own policy layer
 * (src/services/intentPolicy.ts's evaluateIntent/validateSessionContext)
 * has separately reviewed the returned Intent (see
 * docs/assistant_architecture.md for why classification and execution
 * are deliberately split across the network boundary this way). This
 * stays true whether tier 1 (deterministic rules) or tier 2 (an LLM
 * classifier) actually produced the Intent — see
 * docs/assistant_ai_integration_review.md §1/§6: neither tier has any
 * path to a domain service, only to this one, inert JSON shape.
 *
 * `context.currentScreen` is accepted and validated here but not yet
 * threaded into `resolveHybridIntent` — the field exists in the contract
 * now so the mobile side already has somewhere real to put it, not
 * because anything reads it today.
 */
import type { Request, Response } from 'express';
import type { AssistantIntentRequest } from '../types/index.ts';
import { resolveHybridIntent } from '../services/intentRouterService.ts';

export async function handleAssistantIntent(req: Request, res: Response): Promise<void> {
  const body = req.body as Partial<AssistantIntentRequest>;

  if (typeof body.text !== 'string') {
    res.status(400).json({ error: '`text` must be a string.' });
    return;
  }

  if (body.context !== undefined) {
    if (typeof body.context !== 'object' || body.context === null) {
      res.status(400).json({ error: '`context`, when present, must be an object.' });
      return;
    }
    if (body.context.currentScreen !== undefined && typeof body.context.currentScreen !== 'string') {
      res.status(400).json({ error: '`context.currentScreen`, when present, must be a string.' });
      return;
    }
  }

  // resolveHybridIntent never throws — every internal failure mode
  // (LLM timeout, malformed output, provider error) already falls back
  // to a safe Intent internally (see intentRouterService.ts), so there's
  // no try/catch needed here, same as the old synchronous resolveIntent.
  const intent = await resolveHybridIntent(body.text);
  res.json({ intent });
}

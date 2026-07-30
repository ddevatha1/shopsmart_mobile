import type { Intent } from '../models/intent';
import { apiClient, ApiError } from './apiClient';

/**
 * The one place that calls POST /api/assistant/intent — mirrors
 * plannerService.ts's own pattern (reuses apiClient's baseUrl/ApiError,
 * no separate HTTP client, no new dependency). Returns the resolved
 * `Intent` only: this file does not dispatch, execute, validate, or act
 * on it in any way — see assistantService.ts for what happens next, and
 * intentPolicy.ts for the policy check that must run before anything
 * this Intent describes is allowed to happen.
 */
export async function resolveAssistantIntent(text: string, context?: { currentScreen?: string }): Promise<Intent> {
  const res = await fetch(`${apiClient.baseUrl}/api/assistant/intent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      ...(context !== undefined && { context }),
    }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(body?.error ?? `Server returned ${res.status}`);
  }
  return body.intent as Intent;
}

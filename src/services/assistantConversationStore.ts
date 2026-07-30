import type { AssistantConversationState, Intent } from '../models/intent';

/**
 * The Assistant Conversation Layer (Phase 5.0) — see
 * docs/assistant_phase5_roadmap.md §5 and models/intent.ts's
 * `AssistantConversationState` doc comment for why this is separate from
 * clarificationStore.ts's `PendingClarification`. Same "simplest safe
 * implementation" as every other pending-state store in this app
 * (clarificationStore.ts, productSelectionStore.ts): a single, in-memory,
 * TTL-bound slot — never persisted to AsyncStorage, never a conversation
 * log, never keyed per-user. A new call to `createPendingConversation`
 * always replaces whatever was there before.
 */

const TTL_MS = 3 * 60 * 1000; // matches every other pending-state store's window

let pending: AssistantConversationState | null = null;
let nextId = 1;

export interface CreatePendingConversationInput {
  pendingIntent: Intent;
  pendingQuestion: string;
  collectedParameters: Record<string, string | number | boolean | undefined>;
  missingField: string;
}

export function createPendingConversation(input: CreatePendingConversationInput): AssistantConversationState {
  const now = Date.now();
  pending = {
    id: `conversation-${nextId++}`,
    pendingIntent: input.pendingIntent,
    pendingQuestion: input.pendingQuestion,
    collectedParameters: input.collectedParameters,
    missingField: input.missingField,
    lastAssistantResponse: input.pendingQuestion,
    createdAt: now,
    expiresAt: now + TTL_MS,
  };
  return pending;
}

/** Returns the current pending conversation state, or `undefined` if
 * there isn't one or it has expired — same check-on-read, prune-eagerly
 * pattern every other pending-state store in this app uses. */
export function getPendingConversation(): AssistantConversationState | undefined {
  if (!pending) return undefined;
  if (Date.now() >= pending.expiresAt) {
    pending = null;
    return undefined;
  }
  return pending;
}

/** Clears the pending conversation unconditionally — e.g. once a
 * follow-up answer has been merged and re-dispatched, or the request
 * completes/fails outright. A no-op when nothing is pending. */
export function clearPendingConversation(): void {
  pending = null;
}

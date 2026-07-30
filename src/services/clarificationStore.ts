import type { Intent, PendingClarification } from '../models/intent';

/**
 * The simplest safe implementation of "we asked the user something,
 * waiting for their answer" — see
 * docs/assistant_ai_integration_review.md §5 ("one slot, not a stack...
 * in-memory only, never persisted to AsyncStorage"). No auth, no cloud
 * storage, no per-user keying: this mobile app has exactly one active
 * session at a time, so a single, unkeyed, process-lifetime slot is the
 * right amount of infrastructure for this phase — not a shortcut, a
 * deliberate match for what this app actually needs right now.
 *
 * NOT a conversation log — matches `AssistantSessionContext`'s own "no
 * history" rule in models/intent.ts. This holds AT MOST ONE pending
 * clarification; a new call to `createPendingClarification` always
 * replaces whatever was there before, it never queues or stacks.
 */

// Matches the design review's suggested 2–5 minute window — long enough
// for a real follow-up, short enough that a stale question never gets
// silently resumed against app state that's since changed.
const CLARIFICATION_TTL_MS = 3 * 60 * 1000;

let pending: PendingClarification | null = null;
let nextId = 1;

export interface CreatePendingClarificationInput {
  originalText: string;
  intentCandidate: Intent;
  missingFields: string[];
  question: string;
}

/** Stores a new pending clarification, replacing any previous one — see
 * this file's header comment on why a fresh request always supersedes a
 * stale question rather than queuing behind it. */
export function createPendingClarification(input: CreatePendingClarificationInput): PendingClarification {
  const now = Date.now();
  pending = {
    id: `clarification-${nextId++}`,
    originalText: input.originalText,
    intentCandidate: input.intentCandidate,
    missingFields: input.missingFields,
    question: input.question,
    createdAt: now,
    expiresAt: now + CLARIFICATION_TTL_MS,
  };
  return pending;
}

/** Returns the current pending clarification, or `undefined` if there
 * isn't one OR it has expired — an expired entry is treated exactly
 * like "none," and is opportunistically cleared here too (same
 * check-on-read, prune-eagerly pattern dismissalStore.ts already uses
 * for its own cooldown expiry). */
export function getPendingClarification(): PendingClarification | undefined {
  if (!pending) return undefined;
  if (Date.now() >= pending.expiresAt) {
    pending = null;
    return undefined;
  }
  return pending;
}

/** Clears the pending clarification unconditionally — e.g. once a
 * follow-up answer has been merged and dispatched, or a fresh, unrelated
 * request is starting. A no-op when nothing is pending. */
export function clearPendingClarification(): void {
  pending = null;
}

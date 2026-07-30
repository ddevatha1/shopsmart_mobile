import type { ApiProduct } from '../models/types';
import type { Intent, PendingCartMutationConfirmation, PendingProductSelection } from '../models/intent';

/**
 * Phase 4.3 — the same "simplest safe implementation" as
 * clarificationStore.ts (see that file's own header comment and
 * docs/assistant_ai_integration_review.md §5): in-memory only, never
 * persisted, no auth, no per-user keying. Two SEPARATE single slots —
 * one for "which product did you mean" (`PendingProductSelection`), one
 * for "are you sure about this one" (`PendingCartMutationConfirmation`)
 * — because they represent genuinely different stages of the same flow,
 * not because either needs to hold more than one thing at a time.
 *
 * The two slots are kept mutually exclusive: creating one clears the
 * other, so this app is never simultaneously "waiting to hear which
 * product" and "waiting to hear yes/no" — a follow-up always resolves
 * against exactly one pending state, never an ambiguous mix of both.
 */

const TTL_MS = 3 * 60 * 1000; // matches clarificationStore.ts's own window

let pendingSelection: PendingProductSelection | null = null;
let pendingConfirmation: PendingCartMutationConfirmation | null = null;
let nextSelectionId = 1;
let nextConfirmationId = 1;

// ─── Product selection ──────────────────────────────────────────────────

export interface CreatePendingProductSelectionInput {
  originalIntent: Intent;
  query: string;
  candidates: ApiProduct[];
}

/** Stores a new pending product selection, replacing any previous one —
 * and clearing any pending confirmation too (see this file's header
 * comment on why the two slots are mutually exclusive). */
export function createPendingProductSelection(input: CreatePendingProductSelectionInput): PendingProductSelection {
  const now = Date.now();
  pendingSelection = {
    id: `selection-${nextSelectionId++}`,
    originalIntent: input.originalIntent,
    query: input.query,
    candidates: input.candidates,
    createdAt: now,
    expiresAt: now + TTL_MS,
  };
  pendingConfirmation = null;
  return pendingSelection;
}

/** Returns the current pending product selection, or `undefined` if
 * there isn't one or it has expired (cleared on read, same pattern as
 * clarificationStore.ts). */
export function getPendingProductSelection(): PendingProductSelection | undefined {
  if (!pendingSelection) return undefined;
  if (Date.now() >= pendingSelection.expiresAt) {
    pendingSelection = null;
    return undefined;
  }
  return pendingSelection;
}

export function clearPendingProductSelection(): void {
  pendingSelection = null;
}

// ─── Cart mutation confirmation ─────────────────────────────────────────

export interface CreatePendingCartMutationConfirmationInput {
  action: 'add_to_cart' | 'remove_from_cart';
  product: ApiProduct;
  originalIntent: Intent;
  requestedQuantity?: number;
}

/** Stores a new pending confirmation, replacing any previous one — and
 * clearing any pending product selection too (see this file's header
 * comment). */
export function createPendingCartMutationConfirmation(
  input: CreatePendingCartMutationConfirmationInput,
): PendingCartMutationConfirmation {
  const now = Date.now();
  pendingConfirmation = {
    id: `confirmation-${nextConfirmationId++}`,
    action: input.action,
    product: input.product,
    originalIntent: input.originalIntent,
    createdAt: now,
    expiresAt: now + TTL_MS,
    requestedQuantity: input.requestedQuantity,
  };
  pendingSelection = null;
  return pendingConfirmation;
}

/** Returns the current pending confirmation, or `undefined` if there
 * isn't one or it has expired (cleared on read). This is the ONLY thing
 * `dispatchAddToCart`/`dispatchRemoveFromCart` (see assistantDispatcher.ts)
 * ever treat as a verified "the shopper confirmed this exact product" —
 * never an intent's own `parameters`. */
export function getPendingCartMutationConfirmation(): PendingCartMutationConfirmation | undefined {
  if (!pendingConfirmation) return undefined;
  if (Date.now() >= pendingConfirmation.expiresAt) {
    pendingConfirmation = null;
    return undefined;
  }
  return pendingConfirmation;
}

export function clearPendingCartMutationConfirmation(): void {
  pendingConfirmation = null;
}

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { AssistantShoppingSession, AssistantShoppingSessionConstraints, ShoppingGoal, ShoppingSessionHistory } from '../models/intent';
import type { PlannerListItem } from '../models/types';

/**
 * Local, on-device persistence for completed `AssistantShoppingSession`
 * records (Phase 5.1 Part 1) — mirrors plannerPreferenceRepository.ts's
 * exact AsyncStorage pattern (scoped per signed-in account, JSON-
 * serialized, silently a no-op for a signed-out shopper). Explicitly
 * "local storage only, no database yet" per this sprint's own brief: this
 * never talks to the backend, and the backend has no knowledge of this
 * shape at all.
 *
 * A session is written here EXACTLY ONCE, only once every required field
 * has been explicitly, separately confirmed by the shopper (see
 * assistantDispatcher.ts's `dispatchStartShoppingSession`) — never a
 * partial/in-progress draft. In-flight, not-yet-complete conversation
 * state (which field is still missing, what's been answered so far) lives
 * entirely in assistantConversationStore.ts's existing, ephemeral,
 * TTL-bound slot — this file only ever sees the FINISHED result.
 */

const keyFor = (ownerEmail: string) => `CartIQ_assistant_sessions_${ownerEmail}`;
const MAX_STORED_SESSIONS = 20;

let nextId = 1;

async function loadAll(ownerEmail: string): Promise<AssistantShoppingSession[]> {
  if (!ownerEmail) return [];
  const raw = await AsyncStorage.getItem(keyFor(ownerEmail));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as AssistantShoppingSession[]) : [];
  } catch {
    return [];
  }
}

async function saveAll(ownerEmail: string, sessions: AssistantShoppingSession[]): Promise<void> {
  if (!ownerEmail) return;
  await AsyncStorage.setItem(keyFor(ownerEmail), JSON.stringify(sessions.slice(-MAX_STORED_SESSIONS)));
}

export interface CreateSessionInput {
  goal: ShoppingGoal;
  items: PlannerListItem[];
  constraints: AssistantShoppingSessionConstraints;
  /** Phase 5.2 Part 4 — informational only, see models/intent.ts's own
   * doc comment on `AssistantShoppingSession.preferencesUsed`. */
  preferencesUsed?: AssistantShoppingSession['preferencesUsed'];
  /** Phase 5.3 Part 5 — the REAL recommended candidate's own
   * `estimatedSavings`/store list at the moment this session's plan was
   * generated (see assistantDispatcher.ts's `dispatchStartShoppingSession`)
   * — never recomputed or estimated later; a session's history entry
   * always reflects exactly what the optimizer actually returned that day. */
  estimatedSavings?: number;
  storesUsed?: string[];
}

/** Persists a new, complete session and returns it. A signed-out shopper
 * (`ownerEmail` empty) gets a real, valid, in-memory-only session object
 * back — the conversation still completes normally — it just isn't
 * written anywhere, matching plannerPreferenceRepository.ts's own
 * signed-out degradation. */
export async function createSession(ownerEmail: string, input: CreateSessionInput): Promise<AssistantShoppingSession> {
  const session: AssistantShoppingSession = {
    id: `session-${nextId++}`,
    createdAt: Date.now(),
    goal: input.goal,
    items: input.items,
    constraints: input.constraints,
    preferences: {},
    status: 'active',
    ...(input.preferencesUsed ? { preferencesUsed: input.preferencesUsed } : {}),
    ...(input.estimatedSavings != null ? { estimatedSavings: input.estimatedSavings } : {}),
    ...(input.storesUsed ? { storesUsed: input.storesUsed } : {}),
  };
  const existing = await loadAll(ownerEmail);
  await saveAll(ownerEmail, [...existing, session]);
  return session;
}

/** The most recently created session still marked `'active'`, or
 * `undefined` if there isn't one — the closest thing to "resume where I
 * left off" this foundation supports; nothing yet surfaces this in the
 * UI (see this phase's own report for why that's a deliberate limit). */
export async function getActiveSession(ownerEmail: string): Promise<AssistantShoppingSession | undefined> {
  const sessions = await loadAll(ownerEmail);
  return sessions.filter((s) => s.status === 'active').slice(-1)[0];
}

export async function listSessions(ownerEmail: string): Promise<AssistantShoppingSession[]> {
  return loadAll(ownerEmail);
}

export async function clearAllSessions(ownerEmail: string): Promise<void> {
  if (!ownerEmail) return;
  await AsyncStorage.removeItem(keyFor(ownerEmail));
}

// ── Shopping Session History (Phase 5.3 Part 5) ─────────────────────────

function toSessionHistory(session: AssistantShoppingSession): ShoppingSessionHistory {
  return {
    id: session.id,
    createdAt: session.createdAt,
    goal: session.goal,
    itemCount: session.items.length,
    optimizationPreference: session.preferencesUsed?.optimizationPreference,
    estimatedSavings: session.estimatedSavings,
    storesUsed: session.storesUsed,
  };
}

/**
 * "Show my previous shopping sessions" / "How did my shopping improve?"
 * (see assistantDispatcher.ts's `dispatchStartShoppingSession`) — a pure
 * projection over real, already-persisted sessions, most recent first.
 * Every stored session already reached full completion before it was
 * ever written (see `createSession`'s own doc comment) — there is no
 * "incomplete session" this can accidentally surface, since none are
 * ever persisted in the first place.
 */
export async function getSessionHistory(ownerEmail: string): Promise<ShoppingSessionHistory[]> {
  const sessions = await loadAll(ownerEmail);
  return sessions.slice().reverse().map(toSessionHistory);
}

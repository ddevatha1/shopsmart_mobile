import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Dismissal memory for the Smart Shopping Advisor (see advisorService.ts)
 * — the missing piece that made a dismissed suggestion reappear on the
 * very next render with unchanged inputs. One AsyncStorage list per
 * account, same pattern as purchaseHistoryService.ts, keyed by an
 * insight kind + a caller-chosen subject (a product id, a store's
 * location key, or just the kind itself when nothing more specific
 * applies — see advisorService.ts's `dismissalKey`).
 *
 * Nothing in this app calls `dismissInsight` yet — that requires a
 * dismiss affordance on AdvisorCard, which is a UI change outside this
 * change's scope. This is the storage + filtering half only; wiring a
 * real "Ignore" button to call it is a small, separate follow-up.
 */
const keyFor = (ownerEmail: string) => `CartIQ_dismissals_${ownerEmail}`;
const DEFAULT_COOLDOWN_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

interface DismissalRecord {
  /** `${insightKind}:${subjectKey}` — see advisorService.ts's `dismissalKey`. */
  key: string;
  dismissedAt: number;
  cooldownDays: number;
}

async function loadActive(ownerEmail: string): Promise<DismissalRecord[]> {
  const raw = await AsyncStorage.getItem(keyFor(ownerEmail));
  if (!raw) return [];
  let records: DismissalRecord[];
  try {
    records = JSON.parse(raw) as DismissalRecord[];
  } catch {
    return [];
  }

  const now = Date.now();
  const active = records.filter((r) => now - r.dismissedAt < r.cooldownDays * DAY_MS);
  // Opportunistically prune expired entries back to storage — otherwise
  // this list only ever grows, since nothing else revisits an expired
  // dismissal once its cooldown has passed.
  if (active.length !== records.length) {
    await AsyncStorage.setItem(keyFor(ownerEmail), JSON.stringify(active));
  }
  return active;
}

/** Dismiss one insight (by its composite key) for `cooldownDays` — after
 * that window, the exact same candidate is eligible to be surfaced again. */
export async function dismissInsight(
  ownerEmail: string,
  key: string,
  cooldownDays: number = DEFAULT_COOLDOWN_DAYS,
): Promise<void> {
  if (!ownerEmail) return;
  const active = await loadActive(ownerEmail);
  const next = [...active.filter((r) => r.key !== key), { key, dismissedAt: Date.now(), cooldownDays }];
  await AsyncStorage.setItem(keyFor(ownerEmail), JSON.stringify(next));
}

/** The set of composite keys currently within their dismissal cooldown —
 * one storage read, checked in-memory against every insight candidate,
 * rather than one read per candidate. */
export async function getActiveDismissals(ownerEmail: string): Promise<Set<string>> {
  if (!ownerEmail) return new Set();
  const active = await loadActive(ownerEmail);
  return new Set(active.map((r) => r.key));
}

/**
 * Store Reliability Foundation (v1) — deterministic, synchronous, no
 * external calls, no AI. This module only reads whatever `WeeklyHours` a
 * `StoreLocation` already carries (see backend/src/types/index.ts) and
 * answers one question: is this specific store open RIGHT NOW. It never
 * fetches hours itself and never guesses at missing or malformed data —
 * see `isStoreOpenNow`'s own contract below, which is this whole sprint's
 * point: make the app safer (never confidently recommend a known-closed
 * store) without making it "smarter" (no scoring, no penalizing a store
 * just because its hours are unknown).
 */
import type { DayHours, StoreLocation, WeeklyHours } from '../types/index.ts';

type DayKey = keyof WeeklyHours;

// Date.getDay(): 0=Sunday, 1=Monday, ... 6=Saturday — indexing directly by
// that value avoids a separate remap table going out of sync with it.
const DAY_KEYS_BY_JS_INDEX: DayKey[] = [
  'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday',
];

const HH_MM_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

function isValidTime(value: unknown): value is string {
  return typeof value === 'string' && HH_MM_PATTERN.test(value);
}

function toMinutesSinceMidnight(time: string): number {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

/**
 * Three-valued, on purpose:
 *
 * - `true` — confirmed open right now, per a well-formed hours window for
 *   today.
 * - `false` — confirmed closed right now: either an explicit
 *   `DayHours.closed: true` for today, or a well-formed today's window
 *   that the current time falls outside of.
 * - `undefined` — UNKNOWN: no `hours` at all, no entry for today, or
 *   malformed/unusable open/close data (bad format, wrong type, or a
 *   close time that isn't after open, which this module doesn't attempt
 *   to interpret as an overnight window). Never thrown — every one of
 *   these cases resolves to `undefined` instead of a crash.
 *
 * Callers MUST treat `undefined` the same as `true` (never exclude or
 * penalize a store just because its hours are unknown) — see
 * `isKnownClosed` below and shoppingPlanOptimizer.ts's
 * `excludeKnownClosedStores`, the only place this asymmetry is acted on.
 */
export function isStoreOpenNow(store: StoreLocation, currentDate: Date = new Date()): boolean | undefined {
  const hours = store.hours;
  if (!hours) return undefined;

  const dayKey = DAY_KEYS_BY_JS_INDEX[currentDate.getDay()];
  const day: DayHours | undefined = hours[dayKey];
  if (!day) return undefined;

  if (day.closed === true) return false;

  if (!isValidTime(day.open) || !isValidTime(day.close)) return undefined;

  const openMinutes = toMinutesSinceMidnight(day.open);
  const closeMinutes = toMinutesSinceMidnight(day.close);
  // An overnight window (close <= open, e.g. open "22:00" close "02:00")
  // isn't modeled — grocery stores don't realistically operate this way,
  // and guessing at wraparound semantics for genuinely malformed/unusual
  // data would risk a wrong, confident answer. Unknown is always safer
  // than a guess here.
  if (closeMinutes <= openMinutes) return undefined;

  const nowMinutes = currentDate.getHours() * 60 + currentDate.getMinutes();
  return nowMinutes >= openMinutes && nowMinutes < closeMinutes;
}

/** The one predicate a caller actually acts on — see `isStoreOpenNow`'s
 * doc comment for why `undefined` (unknown) deliberately returns `false`
 * here, i.e. is NOT treated as closed. */
export function isKnownClosed(store: StoreLocation, currentDate: Date = new Date()): boolean {
  return isStoreOpenNow(store, currentDate) === false;
}

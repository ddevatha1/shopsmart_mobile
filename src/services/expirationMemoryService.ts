import AsyncStorage from '@react-native-async-storage/async-storage';
import { normalizeProductName } from './priceHistoryService';

/**
 * Optional Expiration Tracking (Feature 2) — a real, on-device log of
 * expiration dates the AI Product Quality Scanner (Feature 1) happened to
 * read off a product's packaging, scoped per signed-in account (same
 * pattern as purchaseHistoryService.ts). Never asked for separately —
 * see productQualityService.ts/visionQualityService.ts: this only ever
 * gets a real entry when a quality-check photo genuinely had a visible
 * date on it. One record per product (by normalized name); a later scan
 * of the same product replaces the earlier date rather than accumulating
 * duplicates.
 *
 * "Upcoming" reminders (`getUpcomingExpirations`) require the raw string
 * the model returned to actually parse as a real date — a string like
 * "Aug 5" that JS's own `Date.parse` can't resolve is stored (so the raw
 * text is never lost) but simply never surfaces a reminder, the same
 * "silence over a guess" rule this app's other intelligence features
 * already follow.
 */
const keyFor = (ownerEmail: string) => `CartIQ_expirations_${ownerEmail}`;
const MAX_RECORDS = 200;
const DEFAULT_REMINDER_WINDOW_DAYS = 3;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface ExpirationRecord {
  normalizedName: string;
  displayName: string;
  /** Exactly as the vision model read it off the packaging — never
   * reformatted or re-parsed before storage. */
  expirationDateRaw: string;
  recordedAt: number;
}

export interface UpcomingExpiration {
  normalizedName: string;
  displayName: string;
  expirationDateRaw: string;
  daysUntilExpiration: number;
}

async function loadRecords(ownerEmail: string): Promise<ExpirationRecord[]> {
  const raw = await AsyncStorage.getItem(keyFor(ownerEmail));
  if (!raw) return [];
  try {
    return JSON.parse(raw) as ExpirationRecord[];
  } catch {
    return [];
  }
}

async function saveRecords(ownerEmail: string, records: ExpirationRecord[]): Promise<void> {
  await AsyncStorage.setItem(keyFor(ownerEmail), JSON.stringify(records.slice(-MAX_RECORDS)));
}

/** Records (or replaces, for the same normalized product name) a real
 * expiration date. A no-op for a signed-out shopper (no account to scope
 * the record to) — never written to a shared/anonymous key. */
export async function recordExpiration(
  ownerEmail: string,
  displayName: string,
  expirationDateRaw: string,
): Promise<void> {
  if (!ownerEmail || !displayName.trim() || !expirationDateRaw.trim()) return;
  const normalizedName = normalizeProductName(displayName);
  const records = await loadRecords(ownerEmail);
  const next = [
    ...records.filter((r) => r.normalizedName !== normalizedName),
    { normalizedName, displayName, expirationDateRaw, recordedAt: Date.now() },
  ];
  await saveRecords(ownerEmail, next);
}

/** Real, parseable, upcoming expirations only — see this file's header
 * comment on why an unparseable raw date never produces a reminder.
 * `withinDays` is inclusive on both ends: an item expiring today (0) or
 * up to `withinDays` from now both qualify; an item that already expired
 * does not (this feature reminds ahead of expiration, not after it). */
export async function getUpcomingExpirations(
  ownerEmail: string,
  withinDays: number = DEFAULT_REMINDER_WINDOW_DAYS,
): Promise<UpcomingExpiration[]> {
  if (!ownerEmail) return [];
  const records = await loadRecords(ownerEmail);
  const now = Date.now();

  const upcoming: UpcomingExpiration[] = [];
  for (const record of records) {
    const parsed = Date.parse(record.expirationDateRaw);
    if (Number.isNaN(parsed)) continue;
    const daysUntilExpiration = Math.ceil((parsed - now) / MS_PER_DAY);
    if (daysUntilExpiration >= 0 && daysUntilExpiration <= withinDays) {
      upcoming.push({
        normalizedName: record.normalizedName,
        displayName: record.displayName,
        expirationDateRaw: record.expirationDateRaw,
        daysUntilExpiration,
      });
    }
  }
  return upcoming.sort((a, b) => a.daysUntilExpiration - b.daysUntilExpiration);
}

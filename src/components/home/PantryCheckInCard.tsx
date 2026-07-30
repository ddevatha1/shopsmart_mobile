import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { AnimatedPressable } from '../AnimatedPressable';
import { getPantryReminders, type PantryReminder } from '../../services/purchaseHistoryService';
import { colors } from '../../theme/colors';
import { typography } from '../../theme/typography';
import { spacing, radius, surfaces } from '../../theme/metrics';

const MAX_REMINDERS = 3;

/**
 * Pantry Check-In (Phase 6 Part 6, stretch — Option A). A pull-based,
 * in-app "daily companion" surface: real, already-computed pantry
 * reminders (see purchaseHistoryService.ts's `getPantryReminders`, this
 * component's only data source), shown when Home is opened — never a
 * push/scheduled notification (explicitly out of scope this phase; there
 * is no `expo-notifications` dependency anywhere in this app). Every
 * reminder already cleared `getPantryReminders`'s own bar (a real
 * ≥2-purchase interval this shopper set themselves) before reaching this
 * component — nothing here loosens that, and a shopper with no such
 * history sees nothing, not a placeholder.
 *
 * "Add to list" reuses the exact same non-mutating pattern
 * MealPlanCard.tsx/SuggestionCard.tsx already use — it only pre-fills
 * the Planner's text box with the real item name; nothing here ever
 * touches the cart on its own.
 *
 * `onAvailabilityChange`/`suppressedBy` (Phase 6.1 Part 1) — this
 * component still always fetches and still always knows for itself
 * whether it has real reminders; `onAvailabilityChange` just reports
 * that fact upward (see homeIntelligencePriorityService.ts), and
 * `suppressedBy` lets a higher-priority surface (HomeInsightsStrip)
 * hide this one without preventing it from fetching/reporting — never
 * a second, looser content check of its own.
 *
 * Phase 7.1 — flat panelBg surface, no border, matching AdvisorCard's
 * own treatment (the other real alternate for this same homepage slot)
 * so the two feel like one consistent "ambient insight" visual
 * language rather than two differently-styled widgets that happen to
 * take turns.
 */
export function PantryCheckInCard({
  ownerEmail, onAddToList, onAvailabilityChange, suppressedBy = false,
}: {
  ownerEmail: string;
  onAddToList: (displayName: string) => void;
  onAvailabilityChange?: (available: boolean) => void;
  suppressedBy?: boolean;
}) {
  const [reminders, setReminders] = useState<PantryReminder[]>([]);

  useEffect(() => {
    let cancelled = false;
    if (!ownerEmail) {
      setReminders([]);
      onAvailabilityChange?.(false);
      return;
    }
    getPantryReminders(ownerEmail).then((r) => {
      if (cancelled) return;
      const capped = r.slice(0, MAX_REMINDERS);
      setReminders(capped);
      onAvailabilityChange?.(capped.length > 0);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownerEmail]);

  if (reminders.length === 0 || suppressedBy) return null;

  return (
    <View style={styles.card}>
      <View style={styles.titleRow}>
        <Ionicons name="basket" size={12} color={colors.green} />
        <Text style={styles.title}>Pantry check-in</Text>
      </View>

      {reminders.map((reminder, i) => (
        <View key={reminder.normalizedName} style={[styles.row, i === 0 && styles.rowFirst]}>
          <View style={{ flex: 1 }}>
            <Text style={styles.itemName}>{reminder.displayName}</Text>
            <Text style={styles.detail}>
              It&apos;s been about {reminder.daysSince} day{reminder.daysSince === 1 ? '' : 's'} — you usually repurchase it every ~{reminder.typicalIntervalDays} days.
            </Text>
          </View>
          <AnimatedPressable onPress={() => onAddToList(reminder.displayName)} style={styles.addButton} scaleTo={0.95}>
            <Text style={styles.addButtonText}>Add to list</Text>
          </AnimatedPressable>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    ...surfaces.flat, padding: spacing.md + 2, marginHorizontal: spacing.lg, marginTop: spacing.sm, gap: spacing.sm,
  },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  title: { ...typography.overline, color: `${colors.charcoal}99`, letterSpacing: 0.4 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingTop: spacing.sm,
    borderTopWidth: 1, borderTopColor: colors.white,
  },
  rowFirst: { borderTopWidth: 0, paddingTop: 0 },
  itemName: { ...typography.bodyMedium, fontSize: 13.5 },
  detail: { color: `${colors.charcoal}99`, fontSize: 11.5, marginTop: 2, lineHeight: 15 },
  addButton: { backgroundColor: colors.mint, borderRadius: radius.pill, paddingHorizontal: spacing.md, paddingVertical: spacing.xs + 2 },
  addButtonText: { color: colors.green, fontSize: 11.5, fontWeight: '700' },
});

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { AnimatedPressable } from '../AnimatedPressable';
import { colors } from '../../theme/colors';
import { typography } from '../../theme/typography';
import { spacing, surfaces } from '../../theme/metrics';
import type { ShopperPreferences } from '../../models/types';

/**
 * "Your shopping preferences" (Phase 5.2 Part 6) — a plain summary of the
 * REAL, already-stored `ShopperPreferences` record (see
 * shopperPreferenceService.ts), never a settings page: there is no form
 * here, only a list of what's already remembered with a remove action per
 * item. "Edit" is intentionally satisfied by remove-then-restate (say
 * "remember I prefer Kroger" again) rather than an inline editable field
 * — see this phase's own report for why that's a deliberate simplicity
 * choice, not an oversight.
 *
 * Phase 7.1 — deliberately flat: no border, no shadow. This is one of
 * several small status summaries stacked in the Assistant's empty state
 * (alongside IntelligenceStatusCard); giving each its own bordered white
 * box made the empty state read as a stack of identical dashboard
 * widgets. A soft background tint is enough to group the content —
 * hierarchy here should come from typography and spacing, not a
 * container fighting for the same visual weight as the actual plan
 * cards this screen renders.
 */
export function PreferenceMemoryCard({
  preferences, onRemoveStore, onRemoveAvoidedStore, onClearOptimizationPreference, onClearBudgetTarget,
}: {
  preferences: ShopperPreferences;
  onRemoveStore: (store: string) => void;
  onRemoveAvoidedStore: (store: string) => void;
  onClearOptimizationPreference: () => void;
  onClearBudgetTarget: () => void;
}) {
  const hasAnything =
    (preferences.preferredStores?.length ?? 0) > 0
    || (preferences.avoidedStores?.length ?? 0) > 0
    || preferences.optimizationPreference != null
    || preferences.defaultBudgetTarget != null;

  if (!hasAnything) return null;

  return (
    <View style={styles.card}>
      <View style={styles.titleRow}>
        <Ionicons name="bookmark" size={12} color={colors.green} />
        <Text style={styles.title}>Your shopping preferences</Text>
      </View>

      {preferences.preferredStores?.map((store) => (
        <PreferenceRow key={`preferred-${store}`} label={`Prefers ${store}`} onRemove={() => onRemoveStore(store)} />
      ))}
      {preferences.avoidedStores?.map((store) => (
        <PreferenceRow key={`avoided-${store}`} label={`Avoids ${store}`} onRemove={() => onRemoveAvoidedStore(store)} />
      ))}
      {preferences.optimizationPreference && (
        <PreferenceRow label={`Optimizes for ${preferences.optimizationPreference}`} onRemove={onClearOptimizationPreference} />
      )}
      {preferences.defaultBudgetTarget != null && (
        <PreferenceRow label={`Budget target: $${preferences.defaultBudgetTarget.toFixed(2)}`} onRemove={onClearBudgetTarget} />
      )}
    </View>
  );
}

function PreferenceRow({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowText}>{label}</Text>
      <AnimatedPressable onPress={onRemove} scaleTo={0.9} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }} accessibilityLabel={`Remove: ${label}`}>
        <Ionicons name="close-circle-outline" size={16} color={`${colors.charcoal}80`} />
      </AnimatedPressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { ...surfaces.flat, padding: spacing.md + 2, gap: spacing.xs },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  title: { ...typography.overline, color: `${colors.charcoal}99`, letterSpacing: 0.4 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 4 },
  rowText: { ...typography.body, fontSize: 13 },
});

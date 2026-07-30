import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../../theme/colors';
import { typography } from '../../theme/typography';
import { spacing, surfaces } from '../../theme/metrics';
import { hasAnyIntelligenceSignal, type IntelligenceSignals } from '../../services/intelligenceStatusService';

/**
 * "CartIQ knows:" (Phase 6 Part 4) — a plain checklist rendering of a
 * real `IntelligenceSignals` record (see intelligenceStatusService.ts,
 * this component's only producer). Every row shown here already passed
 * that service's own real-existence check; this component adds nothing
 * of its own — no row is ever shown for a signal that doesn't actually
 * exist, and a brand-new/signed-out account (all three signals false)
 * renders nothing at all rather than an empty or placeholder card.
 *
 * Phase 7.1 — flat, mint-tinted (not bordered white) so it reads as a
 * distinct, quietly confident "we noticed this" moment rather than
 * another identical dashboard tile next to PreferenceMemoryCard right
 * below it — same flat-surface principle, different tint, so the two
 * status summaries stay visually distinguishable without either one
 * needing a border.
 */
export function IntelligenceStatusCard({ signals }: { signals: IntelligenceSignals }) {
  if (!hasAnyIntelligenceSignal(signals)) return null;

  return (
    <View style={styles.card}>
      <View style={styles.titleRow}>
        <Ionicons name="sparkles" size={12} color={colors.green} />
        <Text style={styles.title}>CartIQ knows</Text>
      </View>

      {signals.preferredStores && <Row label="Preferred stores" />}
      {signals.shoppingHistory && <Row label="Shopping history" />}
      {signals.savingsPatterns && <Row label="Savings patterns" />}
    </View>
  );
}

function Row({ label }: { label: string }) {
  return (
    <View style={styles.row}>
      <Ionicons name="checkmark" size={13} color={colors.green} />
      <Text style={styles.rowText}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { ...surfaces.tinted, padding: spacing.md + 2, gap: spacing.xs },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  title: { ...typography.overline, color: `${colors.green}b3`, letterSpacing: 0.4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, paddingVertical: 2 },
  rowText: { ...typography.bodyMedium, fontSize: 13, color: colors.green },
});

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../../theme/colors';
import { typography } from '../../theme/typography';
import { spacing, surfaces } from '../../theme/metrics';
import type { ShoppingSessionHistory } from '../../models/intent';

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString(undefined, { month: 'long', day: 'numeric' });
}

/**
 * "Recent shopping sessions" (Phase 5.3 Part 6) — a read-only list of
 * real, already-completed sessions (see
 * assistantShoppingSessionStore.ts's `getSessionHistory`). Deliberately
 * has NO action of any kind: no edit, no "reuse this plan" button — per
 * this sprint's own explicit rule ("No editing. No automatic reuse."),
 * this is purely informational.
 *
 * Phase 7.1 — flat panelBg surface (matches SuggestionCard/
 * AssistantMessageBubble's own assistant-bubble color) instead of a
 * bordered white box; row dividers use the same subtle borderGray line,
 * just as internal structure rather than an outer container.
 */
export function ShoppingHistoryCard({ sessions }: { sessions: ShoppingSessionHistory[] }) {
  if (sessions.length === 0) return null;

  return (
    <View style={styles.card}>
      <View style={styles.titleRow}>
        <Ionicons name="time" size={12} color={colors.green} />
        <Text style={styles.title}>Recent shopping sessions</Text>
      </View>

      {sessions.map((session, i) => (
        <View key={session.id} style={[styles.row, i > 0 && styles.rowDivider]}>
          <Text style={styles.date}>{formatDate(session.createdAt)}</Text>
          <Text style={styles.detail}>{session.itemCount} item{session.itemCount === 1 ? '' : 's'}</Text>
          {session.estimatedSavings != null && session.estimatedSavings > 0 && (
            <Text style={styles.savings}>Saved ${session.estimatedSavings.toFixed(2)}</Text>
          )}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { ...surfaces.flat, padding: spacing.md + 2, gap: spacing.xs },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  title: { ...typography.overline, color: `${colors.charcoal}99`, letterSpacing: 0.4 },
  row: { paddingVertical: spacing.xs },
  rowDivider: { borderTopWidth: 1, borderTopColor: colors.borderGray },
  date: { ...typography.cardTitle },
  detail: { ...typography.caption, marginTop: 1 },
  savings: { ...typography.caption, color: colors.green, marginTop: 1, fontWeight: '700' },
});

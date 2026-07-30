import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { AnimatedPressable } from '../AnimatedPressable';
import { colors } from '../../theme/colors';
import { typography } from '../../theme/typography';
import { spacing, radius, surfaces } from '../../theme/metrics';
import type { AssistantSuggestion } from '../../models/types';

/**
 * "Based on your shopping history" (Phase 5.2 Part 6) — renders real
 * `AssistantSuggestion[]` (see assistantSuggestionService.ts), never
 * inventing anything itself: `reason` is displayed verbatim. "Add to
 * list" is the ONLY action offered per suggestion, and — critically —
 * it never adds to the cart; it only ever hands the item name to the
 * caller (see AssistantScreen.tsx, which pre-fills the Planner's text
 * box, the same "review before anything happens" pattern
 * MealPlanCard/ShoppingSessionPlanCard already use). "Ignore" removes it
 * from view AND records a real dismissal (see
 * assistantSuggestionService.ts's `dismissSuggestion`) so it doesn't
 * reappear immediately next time.
 *
 * Phase 7.1 — flat panelBg surface, no border, matching
 * AssistantMessageBubble's own assistant-bubble treatment (same
 * background color) rather than a separate bordered "dashboard card"
 * look — this renders inline in the same conversation thread as plain
 * bubbles, so it should read as a richer reply, not a different kind of
 * object.
 */
export function SuggestionCard({
  suggestions, onAddToList, onAddAllToList, onIgnore,
}: {
  suggestions: AssistantSuggestion[];
  onAddToList: (suggestion: AssistantSuggestion) => void;
  onAddAllToList: (suggestions: AssistantSuggestion[]) => void;
  onIgnore: (suggestion: AssistantSuggestion) => void;
}) {
  if (suggestions.length === 0) return null;

  return (
    <View style={styles.card}>
      <View style={styles.titleRow}>
        <Ionicons name="time" size={12} color={colors.green} />
        <Text style={styles.title}>Based on your shopping history</Text>
      </View>

      {suggestions.map((suggestion, i) => (
        <View key={`${suggestion.type}-${suggestion.itemName}`} style={[styles.suggestionRow, i > 0 && styles.suggestionRowDivider]}>
          <View style={{ flex: 1 }}>
            <Text style={styles.itemName}>{suggestion.itemName}</Text>
            <Text style={styles.reason}>{suggestion.reason}</Text>
          </View>
          <View style={styles.actions}>
            <AnimatedPressable onPress={() => onAddToList(suggestion)} style={styles.addButton} scaleTo={0.95}>
              <Text style={styles.addButtonText}>Add to list</Text>
            </AnimatedPressable>
            <AnimatedPressable onPress={() => onIgnore(suggestion)} scaleTo={0.9} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
              <Text style={styles.ignoreText}>Ignore</Text>
            </AnimatedPressable>
          </View>
        </View>
      ))}

      {suggestions.length > 1 && (
        <AnimatedPressable onPress={() => onAddAllToList(suggestions)} style={styles.addAllButton} scaleTo={0.97}>
          <Text style={styles.addAllButtonText}>Add all to list</Text>
        </AnimatedPressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { ...surfaces.flat, padding: spacing.md + 2, marginBottom: spacing.sm, gap: spacing.xs },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  title: { ...typography.overline, color: `${colors.charcoal}99`, letterSpacing: 0.4 },
  suggestionRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.sm },
  suggestionRowDivider: { borderTopWidth: 1, borderTopColor: colors.borderGray },
  itemName: { ...typography.cardTitle },
  reason: { ...typography.caption, marginTop: 1 },
  actions: { alignItems: 'flex-end', gap: 4 },
  addButton: { backgroundColor: colors.mint, borderRadius: radius.pill, paddingHorizontal: spacing.sm + 2, paddingVertical: 4 },
  addButtonText: { color: colors.green, fontSize: 11.5, fontWeight: '700' },
  ignoreText: { color: `${colors.charcoal}66`, fontSize: 11 },
  addAllButton: {
    backgroundColor: colors.green, borderRadius: radius.md, paddingVertical: spacing.sm + 2,
    alignItems: 'center', marginTop: spacing.xs,
  },
  addAllButtonText: { ...typography.button, color: colors.white },
});

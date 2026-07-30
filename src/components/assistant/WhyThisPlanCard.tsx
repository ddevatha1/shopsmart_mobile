import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../../theme/colors';
import { typography } from '../../theme/typography';
import { spacing, surfaces } from '../../theme/metrics';
import { flattenExplanationReasons, type RecommendationExplanation } from '../../services/recommendationExplanationService';

/**
 * "Why CartIQ chose this" (Phase 5.3 Part 6) — a plain checklist rendering
 * of a real `RecommendationExplanation` (see
 * recommendationExplanationService.ts's `explainRecommendation`), never
 * free-form text generated in this component. Every row shown here
 * already passed that service's own evidence gate — this component adds
 * NOTHING of its own beyond a checkmark icon and layout; there is no
 * code path here that invents or rephrases a reason.
 *
 * Phase 6.1 Part 5 gave this a left accent border so explainability —
 * a real competition differentiator — wouldn't read as quiet fine
 * print. Phase 7.1 keeps that intent but drops the border entirely: a
 * bordered box nested inside `ShoppingSessionPlanCard`'s own now-
 * elevated white card was "excessive containers" (a box inside a box).
 * A solid mint fill communicates "this is a distinct, explained
 * section" using color/weight alone, whether this renders nested (the
 * Assistant) or standalone on a plain background (PlanResultsView).
 */
export function WhyThisPlanCard({ explanation }: { explanation: RecommendationExplanation }) {
  const reasons = flattenExplanationReasons(explanation);
  if (reasons.length === 0) return null;

  return (
    <View style={styles.card}>
      <View style={styles.titleRow}>
        <Ionicons name="sparkles" size={14} color={colors.green} />
        {/* Phase 6.1 Part 6 — "CartIQ", not "we", to match
            ProductDetailScreen's identically-purposed "Why CartIQ
            chose this" block — same explainability feature, same
            branding, at two grains. */}
        <Text style={styles.title}>Why CartIQ chose this</Text>
      </View>

      {reasons.map((reason, i) => (
        <View key={`${reason.type}-${i}`} style={styles.row}>
          <Ionicons name="checkmark" size={14} color={colors.green} style={styles.check} />
          <Text style={styles.rowText}>{reason.message}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { ...surfaces.tinted, padding: spacing.md + 2, marginBottom: spacing.sm, gap: spacing.xs },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  title: { ...typography.h3, fontWeight: '800', color: colors.green },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.xs, paddingVertical: 2 },
  check: { marginTop: 2 },
  rowText: { ...typography.body, fontSize: 13, flex: 1, color: `${colors.green}e6` },
});

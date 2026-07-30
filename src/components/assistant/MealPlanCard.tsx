import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { AnimatedPressable } from '../AnimatedPressable';
import { colors } from '../../theme/colors';
import { typography } from '../../theme/typography';
import { spacing, radius, surfaces } from '../../theme/metrics';
import type { MealPlanResult } from '../../models/intent';

/**
 * Renders a real `MealPlanResult` (Phase 5.0 — see
 * assistantDispatcher.ts's `dispatchMealPlan` and
 * backend/src/services/mealPlanService.ts). Purely presentational: every
 * meal/ingredient shown here came straight from the deterministic
 * generator, never invented in this component. `pantryAdditions` is
 * rendered as an explicit, separate note (never silently folded into the
 * grocery list with no explanation) — see the Part 4 pantry-advisory
 * requirement. "Open in Planner" is the ONLY action this card offers, and
 * it never mutates the cart itself — it hands the grocery items to the
 * existing Smart Shopping Planner as pre-filled TEXT the shopper still
 * has to review and explicitly submit (see PlannerScreen.tsx's
 * `prefillText`).
 *
 * Phase 7.1 — this is the actual result a shopper asked for, so it gets
 * real shadow instead of a flat hairline border — the one visual cue
 * in this thread that says "this is the thing that matters," while the
 * lighter status/info cards around it (PreferenceMemoryCard,
 * SuggestionCard, etc.) stay flat.
 */
export function MealPlanCard({ data, onOpenInPlanner }: { data: MealPlanResult; onOpenInPlanner: () => void }) {
  return (
    <View style={styles.card}>
      <Text style={styles.title}>Suggested meals</Text>
      {data.meals.map((meal) => (
        <View key={meal.id} style={styles.mealRow}>
          <Ionicons name="restaurant-outline" size={15} color={colors.green} />
          <Text style={styles.mealName}>{meal.name}</Text>
        </View>
      ))}

      <Text style={styles.subtitle}>Grocery list</Text>
      <Text style={styles.groceryList}>{data.groceryItems.join(' · ')}</Text>

      {data.pantryAdditions.length > 0 && (
        <View style={styles.pantryNote}>
          <Ionicons name="information-circle-outline" size={14} color={`${colors.charcoal}99`} />
          <Text style={styles.pantryText}>
            You may be running low on {data.pantryAdditions.join(', ')} — I included {data.pantryAdditions.length === 1 ? 'it' : 'them'}.
          </Text>
        </View>
      )}

      <AnimatedPressable onPress={onOpenInPlanner} style={styles.button} scaleTo={0.97}>
        <Text style={styles.buttonText}>Open in Planner</Text>
        <Ionicons name="chevron-forward" size={15} color={colors.white} />
      </AnimatedPressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { ...surfaces.card, padding: spacing.lg, marginBottom: spacing.sm, gap: spacing.xs },
  title: { ...typography.h2, fontSize: 16 },
  mealRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, marginTop: 2 },
  mealName: { ...typography.body, fontSize: 13.5 },
  subtitle: { ...typography.caption, marginTop: spacing.sm, textTransform: 'uppercase' },
  groceryList: { ...typography.body, fontSize: 13, color: `${colors.charcoal}b3` },
  pantryNote: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.xs, marginTop: spacing.xs, backgroundColor: colors.panelBg, borderRadius: radius.sm, padding: spacing.sm },
  pantryText: { ...typography.caption, flex: 1 },
  button: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.xs,
    backgroundColor: colors.green, borderRadius: radius.md, paddingVertical: spacing.sm + 2, marginTop: spacing.sm,
  },
  buttonText: { ...typography.button, color: colors.white },
});

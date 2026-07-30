import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { AnimatedPressable } from '../AnimatedPressable';
import { colors } from '../../theme/colors';
import { typography } from '../../theme/typography';
import { spacing, radius, surfaces } from '../../theme/metrics';

/**
 * Homepage Redesign — "What else can CartIQ help with?" Four clean
 * navigation rows below the search hero, deliberately smaller and
 * quieter than it (no shadow, no color fill — a plain hairline border,
 * the same `surfaces.bordered` tier this app already uses for dense,
 * secondary content). Every destination here is real, existing
 * functionality reached a different way, never a new feature:
 *   - Shopping List → PlannerScreen (unchanged)
 *   - Plan a Whole Meal → the new MealPlannerScreen, itself a thin UI
 *     over the exact same real generator the Assistant already used
 *   - Cart → the existing Cart tab
 *   - Find Savings → the new SavingsScreen, which relocated (not
 *     rebuilt) the real intelligence surfaces that used to render
 *     directly on Home
 */
export function HomeFeatureCards({
  onOpenShoppingList, onOpenMealPlanner, onOpenCart, onOpenSavings,
}: {
  onOpenShoppingList: () => void;
  onOpenMealPlanner: () => void;
  onOpenCart: () => void;
  onOpenSavings: () => void;
}) {
  return (
    <View style={styles.container}>
      <Text style={styles.sectionTitle}>More Actions</Text>

      <FeatureCard
        icon="list-outline"
        iconBg={colors.mint}
        iconColor={colors.green}
        title="Shopping List"
        description="Add your entire grocery list and we'll find the best options."
        helper="Try: milk, eggs, bananas, chicken breast"
        buttonLabel="Create List"
        onPress={onOpenShoppingList}
      />
      <FeatureCard
        icon="restaurant-outline"
        iconBg="#FEF3C7"
        iconColor="#B45309"
        title="Plan a Whole Meal"
        description="Choose a meal goal and CartIQ creates your grocery plan."
        buttonLabel="Plan Meal"
        onPress={onOpenMealPlanner}
      />
      <FeatureCard
        icon="cart-outline"
        iconBg="#E0F2FE"
        iconColor="#0369A1"
        title="Cart"
        description="Review your items, compare prices, and optimize your purchase."
        buttonLabel="Open Cart"
        onPress={onOpenCart}
      />
      <FeatureCard
        icon="cash-outline"
        iconBg="#D1FAE5"
        iconColor="#047857"
        title="Find Savings"
        description="Discover cheaper alternatives and ways to reduce your grocery bill."
        buttonLabel="Find Savings"
        onPress={onOpenSavings}
      />
    </View>
  );
}

function FeatureCard({
  icon, iconBg, iconColor, title, description, helper, buttonLabel, onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  iconBg: string;
  iconColor: string;
  title: string;
  description: string;
  helper?: string;
  buttonLabel: string;
  onPress: () => void;
}) {
  return (
    <AnimatedPressable onPress={onPress} style={styles.card} scaleTo={0.98}>
      <View style={[styles.iconBadge, { backgroundColor: iconBg }]}>
        <Ionicons name={icon} size={22} color={iconColor} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.cardTitle}>{title}</Text>
        <Text style={styles.cardDescription}>{description}</Text>
        {helper && <Text style={styles.cardHelper}>{helper}</Text>}
        <View style={styles.cardButtonRow}>
          <Text style={styles.cardButtonText}>{buttonLabel}</Text>
          <Ionicons name="arrow-forward" size={14} color={colors.green} />
        </View>
      </View>
    </AnimatedPressable>
  );
}

const styles = StyleSheet.create({
  container: { paddingHorizontal: spacing.lg, gap: spacing.md, marginTop: spacing.xl },
  sectionTitle: { ...typography.h3, marginBottom: spacing.xs },
  card: { ...surfaces.bordered, flexDirection: 'row', gap: spacing.md, padding: spacing.lg, alignItems: 'flex-start' },
  iconBadge: { width: 44, height: 44, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  cardTitle: { ...typography.h3, fontSize: 15.5 },
  cardDescription: { ...typography.body, fontSize: 13, color: `${colors.charcoal}99`, marginTop: 2 },
  cardHelper: { ...typography.caption, marginTop: spacing.xs, fontStyle: 'italic' },
  cardButtonRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: spacing.sm },
  cardButtonText: { color: colors.green, fontWeight: '700', fontSize: 13 },
});

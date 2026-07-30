import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { AnimatedPressable } from '../AnimatedPressable';
import { colors } from '../../theme/colors';
import { typography } from '../../theme/typography';
import { spacing, radius, surfaces } from '../../theme/metrics';

/**
 * Navigation Redesign, Issue 2 — replaces the old "More Actions" menu
 * (bland rows: icon, description, helper line, a separate "button label +
 * arrow" row) with "CartIQ can help you..." — a small grid of simple,
 * visually distinct capability tiles. Every destination here is real,
 * already-existing functionality reached a different way, never a new
 * feature or a second nutrition/route/meal-planning system:
 *   - Save Money → SavingsScreen (the real, already-computed intelligence
 *     surfaces that live there)
 *   - Plan Meals → MealPlannerScreen (the same real generator the
 *     Assistant's own "plan my meals" flow already calls)
 *   - Analyze Nutrition → Assistant, pre-filled — there is no second
 *     nutrition dashboard; nutrition analysis is a mode of the one
 *     Assistant (see assistantDispatcher.ts's `nutrition_question`
 *     handling), reused via the same `initialPrompt` param
 *     HomeInsightsStrip already uses
 *   - Ask CartIQ → AssistantScreen directly
 *   - Build Route → RouteScreen (unchanged; handles an empty cart itself)
 *
 * Deliberately no per-card "button label + arrow" row like the old
 * design — the whole tile is the tap target (AnimatedPressable already
 * gives press feedback), one short title, one short sentence. Five tiles
 * in a loose 2-column grid, not five full-width rows: reads as a small
 * set of capabilities, not a menu.
 */
interface Capability {
  key: string;
  icon: keyof typeof Ionicons.glyphMap;
  iconBg: string;
  iconColor: string;
  title: string;
  description: string;
  onPress: () => void;
  /** The odd one out spans the full row alone rather than leaving an
   * awkward half-empty gap next to it. */
  fullWidth?: boolean;
}

export function HomeCapabilityCards({
  onOpenSavings, onOpenMealPlanner, onOpenShoppingList, onOpenAssistant, onOpenRoute,
}: {
  onOpenSavings: () => void;
  onOpenMealPlanner: () => void;
  onOpenShoppingList: () => void;
  onOpenAssistant: () => void;
  onOpenRoute: () => void;
}) {
  const capabilities: Capability[] = [
    {
      key: 'save-money',
      icon: 'cash-outline',
      iconBg: colors.mint,
      iconColor: colors.green,
      title: 'Save Money',
      description: 'Find cheaper alternatives and real savings.',
      onPress: onOpenSavings,
    },
    {
      key: 'plan-meals',
      icon: 'restaurant-outline',
      iconBg: '#FEF3C7',
      iconColor: '#B45309',
      title: 'Plan Meals',
      description: 'Create affordable meal plans in seconds.',
      onPress: onOpenMealPlanner,
    },
    {
      key: 'analyze-nutrition',
      icon: 'nutrition-outline',
      iconBg: '#D1FAE5',
      iconColor: '#047857',
      title: 'Analyze Nutrition',
      description: 'Understand your grocery health.',
      onPress: onOpenAssistant,
    },
    {
      key: 'ask-CartIQ',
      icon: 'sparkles-outline',
      iconBg: '#EDE9FE',
      iconColor: '#6D28D9',
      title: 'Ask CartIQ',
      description: 'Let AI handle your shopping.',
      onPress: onOpenAssistant,
    },
    {
      key: 'build-route',
      icon: 'navigate-outline',
      iconBg: '#E0F2FE',
      iconColor: '#0369A1',
      title: 'Build Route',
      description: 'Optimize your store trip.',
      onPress: onOpenRoute,
      fullWidth: true,
    },
  ];

  return (
    <View style={styles.container}>
      <Text style={styles.sectionTitle}>CartIQ can help you...</Text>
      <View style={styles.grid}>
        {capabilities.map((c) => (
          <CapabilityTile key={c.key} capability={c} />
        ))}
      </View>
      {/* A real, existing destination (the manual shopping-list entry
          point) that doesn't fit this "5 AI capabilities" framing —
          kept as one quiet text link underneath rather than a 6th tile
          competing for the same visual weight. */}
      <AnimatedPressable onPress={onOpenShoppingList} style={styles.shoppingListLink} scaleTo={0.98}>
        <Ionicons name="list-outline" size={14} color={`${colors.charcoal}80`} />
        <Text style={styles.shoppingListLinkText}>Or start from a plain shopping list</Text>
      </AnimatedPressable>
    </View>
  );
}

function CapabilityTile({ capability }: { capability: Capability }) {
  const { icon, iconBg, iconColor, title, description, onPress, fullWidth } = capability;
  return (
    <AnimatedPressable
      onPress={onPress}
      style={[styles.tile, fullWidth && styles.tileFullWidth]}
      scaleTo={0.97}
    >
      <View style={[styles.iconBadge, { backgroundColor: iconBg }]}>
        <Ionicons name={icon} size={20} color={iconColor} />
      </View>
      <View style={fullWidth ? { flex: 1 } : undefined}>
        <Text style={styles.tileTitle} numberOfLines={1}>{title}</Text>
        <Text style={styles.tileDescription} numberOfLines={2}>{description}</Text>
      </View>
    </AnimatedPressable>
  );
}

const styles = StyleSheet.create({
  container: { paddingHorizontal: spacing.lg, marginTop: spacing.xl },
  sectionTitle: { ...typography.h3, marginBottom: spacing.md },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  tile: {
    ...surfaces.bordered,
    width: '48%',
    padding: spacing.md,
    gap: 3,
  },
  tileFullWidth: { width: '100%', flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  iconBadge: { width: 36, height: 36, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  tileTitle: { ...typography.h3, fontSize: 14, marginTop: 2 },
  tileDescription: { ...typography.caption, lineHeight: 15 },
  shoppingListLink: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, marginTop: spacing.md, alignSelf: 'center' },
  shoppingListLinkText: { ...typography.caption, textDecorationLine: 'underline' },
});

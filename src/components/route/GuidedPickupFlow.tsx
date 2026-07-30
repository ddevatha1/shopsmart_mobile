import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import type { CartItem } from '../../models/types';
import { categorizeProduct, type GroceryCategory } from '../../services/groceryCategoryService';
import { StoreLogo } from '../StoreLogo';
import { AnimatedPressable } from '../AnimatedPressable';
import { colors } from '../../theme/colors';
import { typography } from '../../theme/typography';
import { spacing, radius, surfaces, elevation } from '../../theme/metrics';

/**
 * Route Experience Redesign (Issue 3) — replaces the old "every pending
 * item shown in one checklist" rendering (see this file's former sibling,
 * RouteScreen.tsx's now-removed `ChecklistRow`) with a guided, one-item-
 * at-a-time flow: "the route should feel like a personal shopping
 * assistant walking through the store with the user... one item, one
 * decision, one action." Used both by StopCard (Trip Overview — reviewing
 * one stop's items) and NavigationPanel (live Navigation Mode — the
 * active stop) — same component, same behavior, wherever a stop's pickup
 * list is rendered, per this refactor's "one component, not a duplicate
 * system" requirement.
 *
 * Progression is scoped to THIS list (usually one stop's items) — not a
 * new data model: `checklist`/`onToggleItem` are the exact same props
 * this file's items used to receive individually, still backed by
 * routeStore's real, persisted per-product completion tracking. Nothing
 * about *what* is tracked changed, only how it's presented one at a time.
 *
 * Progression rule: the NEXT item is "locked" only in the sense that
 * marking the current one picked up is what advances the flow by
 * default — but a shopper is never actually stuck: "Back" always works,
 * and "Skip for now" moves on without marking anything picked up (the
 * item just stays in the running "X of Y completed" count until they
 * come back to it — see the end-of-list summary below).
 */

const CATEGORY_ICON: Record<GroceryCategory, keyof typeof Ionicons.glyphMap> = {
  Frozen: 'snow-outline',
  Produce: 'leaf-outline',
  'Dairy & Eggs': 'egg-outline',
  'Meat & Seafood': 'fish-outline',
  Bakery: 'restaurant-outline',
  Pantry: 'nutrition-outline',
  Beverages: 'cafe-outline',
  Snacks: 'fast-food-outline',
  Household: 'home-outline',
  Other: 'basket-outline',
};

interface Props {
  items: CartItem[];
  checklist: Record<string, boolean>;
  onToggleItem: (productId: string) => void;
  /** AI Product Quality Scanner (Feature 1) — see this component's own
   * "Check Quality" card. Omitted entirely hides that section, though
   * every real caller today provides it. */
  onCheckQuality?: (productName: string) => void;
}

export function GuidedPickupFlow({ items, checklist, onToggleItem, onCheckQuality }: Props) {
  // Which position in `items` is currently shown — defaults to the first
  // not-yet-picked-up item (or just past the end if everything already
  // is, e.g. re-opening a stop that was fully picked up earlier).
  const firstPendingIndex = items.findIndex((i) => !checklist[i.product.id]);
  const [viewIndex, setViewIndex] = useState(firstPendingIndex === -1 ? items.length : firstPendingIndex);

  // If the checklist changes for a reason OTHER than this component's own
  // actions (e.g. the shopper picks the same trip back up later, or a
  // different stop's items swap in), re-anchor to the real first-pending
  // item rather than a stale index from a previous item set.
  useEffect(() => {
    const next = items.findIndex((i) => !checklist[i.product.id]);
    setViewIndex(next === -1 ? items.length : next);
    // Only when the underlying item SET changes (a different stop, or a
    // different number of items) — not on every checklist tick, which
    // would otherwise fight this component's own optimistic advance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.map((i) => i.product.id).join(',')]);

  const completedCount = items.filter((i) => checklist[i.product.id]).length;

  if (items.length === 0) return null;

  if (viewIndex >= items.length) {
    const remaining = items.filter((i) => !checklist[i.product.id]);
    return (
      <View style={styles.summaryCard}>
        <Ionicons name="checkmark-done-circle" size={32} color={colors.green} />
        <Text style={styles.summaryTitle}>
          {remaining.length === 0 ? "You've picked up everything here!" : 'Almost done here'}
        </Text>
        <Text style={styles.progressText}>{completedCount} of {items.length} items completed</Text>
        {remaining.length > 0 && (
          <View style={styles.remainingList}>
            {remaining.map((item) => (
              <AnimatedPressable
                key={item.product.id}
                onPress={() => setViewIndex(items.findIndex((i) => i.product.id === item.product.id))}
                style={styles.remainingRow}
                scaleTo={0.98}
              >
                <Text style={styles.remainingRowText}>{item.product.name}</Text>
                <Text style={styles.remainingRowAction}>Pick up</Text>
              </AnimatedPressable>
            ))}
          </View>
        )}
      </View>
    );
  }

  const current = items[viewIndex];
  const category = categorizeProduct(current.product);
  const isPickedUp = !!checklist[current.product.id];
  const hasSavings = current.product.discountPercent != null && current.product.discountPercent > 0;

  return (
    <Animated.View key={current.product.id} entering={FadeIn.duration(200)} exiting={FadeOut.duration(120)} style={styles.card}>
      <Text style={styles.progressText}>{completedCount} of {items.length} items completed</Text>

      <View style={styles.itemHeader}>
        <View style={styles.itemIconCircle}>
          <Ionicons name={CATEGORY_ICON[category]} size={22} color={colors.green} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.itemName}>
            {current.product.name}{current.quantity > 1 ? ` × ${current.quantity}` : ''}
          </Text>
          <Text style={styles.itemSubtitle}>Pick up this item</Text>
        </View>
      </View>

      <View style={styles.infoBlock}>
        <View style={styles.infoRow}>
          <Text style={styles.infoLabel}>Recommended</Text>
          <Text style={styles.infoValue} numberOfLines={1}>{current.product.brand ? `${current.product.brand} ` : ''}{current.product.name}</Text>
        </View>
        <View style={styles.infoRow}>
          <Text style={styles.infoLabel}>Best price</Text>
          <View style={styles.priceValueRow}>
            <StoreLogo store={current.product.store} height={14} width={30} />
            <Text style={styles.infoValue}>${current.product.price.toFixed(2)}</Text>
          </View>
        </View>
        {hasSavings && (
          <View style={styles.savingsChip}>
            <Ionicons name="pricetag" size={11} color={colors.green} />
            <Text style={styles.savingsChipText}>
              Save {current.product.discountPercent}%{current.product.originalPrice != null ? ` — usually $${current.product.originalPrice.toFixed(2)}` : ''}
            </Text>
          </View>
        )}
      </View>

      {onCheckQuality && (
        <View style={styles.qualityBlock}>
          <View style={styles.qualityHeaderRow}>
            <Ionicons name="camera" size={16} color={colors.green} />
            <Text style={styles.qualityTitle}>Check Quality</Text>
          </View>
          <Text style={styles.qualitySubtitle}>
            AI checks appearance and detects visible expiration dates.
          </Text>
          <AnimatedPressable
            onPress={() => onCheckQuality(current.product.name)}
            style={styles.qualityButton}
            scaleTo={0.97}
          >
            <Ionicons name="camera-outline" size={16} color={colors.white} />
            <Text style={styles.qualityButtonText}>Take Product Photo</Text>
          </AnimatedPressable>
        </View>
      )}

      <View style={styles.actionsRow}>
        <AnimatedPressable
          onPress={() => setViewIndex((v) => Math.max(0, v - 1))}
          style={[styles.navButton, viewIndex === 0 && styles.navButtonDisabled]}
          disabled={viewIndex === 0}
          scaleTo={0.95}
        >
          <Ionicons name="chevron-back" size={16} color={viewIndex === 0 ? `${colors.charcoal}40` : colors.charcoal} />
        </AnimatedPressable>

        <AnimatedPressable
          onPress={() => setViewIndex((v) => v + 1)}
          style={styles.skipButton}
          scaleTo={0.97}
        >
          <Text style={styles.skipButtonText}>Skip for now</Text>
        </AnimatedPressable>

        <AnimatedPressable
          onPress={() => {
            if (!isPickedUp) onToggleItem(current.product.id);
            setViewIndex((v) => v + 1);
          }}
          style={styles.pickedUpButton}
          scaleTo={0.97}
        >
          <Ionicons name="checkmark" size={16} color={colors.white} />
          <Text style={styles.pickedUpButtonText}>Mark as picked up</Text>
        </AnimatedPressable>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: { ...surfaces.card, padding: spacing.lg, gap: spacing.md, ...elevation.low },
  progressText: { ...typography.caption, textAlign: 'center' },
  itemHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  itemIconCircle: {
    width: 44, height: 44, borderRadius: radius.md, backgroundColor: colors.mint,
    alignItems: 'center', justifyContent: 'center',
  },
  itemName: { ...typography.h3, fontSize: 16 },
  itemSubtitle: { ...typography.caption, marginTop: 1 },
  infoBlock: { backgroundColor: colors.panelBg, borderRadius: radius.md, padding: spacing.md, gap: spacing.xs },
  infoRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  infoLabel: { ...typography.caption, textTransform: 'uppercase' },
  infoValue: { ...typography.body, fontSize: 13, fontWeight: '600', flexShrink: 1, textAlign: 'right' },
  priceValueRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  savingsChip: {
    flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start',
    backgroundColor: colors.mint, borderRadius: radius.sm, paddingHorizontal: spacing.sm, paddingVertical: 3, marginTop: 2,
  },
  savingsChipText: { color: colors.green, fontSize: 11, fontWeight: '700' },
  qualityBlock: { backgroundColor: colors.mint, borderRadius: radius.md, padding: spacing.md, gap: spacing.xs },
  qualityHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  qualityTitle: { ...typography.h3, fontSize: 14, color: colors.green },
  qualitySubtitle: { ...typography.caption, lineHeight: 15 },
  qualityButton: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.xs,
    backgroundColor: colors.green, borderRadius: radius.md, paddingVertical: spacing.sm + 2, marginTop: spacing.xs,
  },
  qualityButtonText: { ...typography.button, color: colors.white, fontSize: 13 },
  actionsRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  navButton: {
    width: 40, height: 40, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: colors.borderGray,
  },
  navButtonDisabled: { opacity: 0.5 },
  skipButton: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm + 2 },
  skipButtonText: { ...typography.caption, fontWeight: '600' },
  pickedUpButton: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.xs,
    backgroundColor: colors.green, borderRadius: radius.md, paddingVertical: spacing.sm + 2,
  },
  pickedUpButtonText: { ...typography.button, color: colors.white, fontSize: 13.5 },
  summaryCard: { ...surfaces.card, padding: spacing.xl, gap: spacing.sm, alignItems: 'center', ...elevation.low },
  summaryTitle: { ...typography.h3, textAlign: 'center' },
  remainingList: { width: '100%', gap: spacing.xs, marginTop: spacing.sm },
  remainingRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: colors.panelBg, borderRadius: radius.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
  },
  remainingRowText: { ...typography.body, fontSize: 13 },
  remainingRowAction: { color: colors.green, fontWeight: '700', fontSize: 12.5 },
});

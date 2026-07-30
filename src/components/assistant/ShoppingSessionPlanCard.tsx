import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { AnimatedPressable } from '../AnimatedPressable';
import { PlanStoreSection } from '../planner/PlanStoreSection';
import { PlanItemProductGrid } from '../planner/PlanItemProductGrid';
import { WhyThisPlanCard } from './WhyThisPlanCard';
import { flattenPlanCandidateItems } from '../../utils/planProducts';
import { colors } from '../../theme/colors';
import { typography } from '../../theme/typography';
import { spacing, radius, surfaces } from '../../theme/metrics';
import type { ShoppingSessionPlanResult } from '../../models/intent';
import type { ApiProduct } from '../../models/types';

/**
 * Renders a real `ShoppingSessionPlanResult` (Phase 5.1, extended Phase
 * 5.4 Part 1/4 — see assistantDispatcher.ts's
 * `dispatchStartShoppingSession`). Purely presentational, same discipline
 * as MealPlanCard.tsx: `explanation` is already real, template-built text
 * (see assistantExplanationService.ts) over the real `plan.candidates` —
 * this component never computes or restates anything itself.
 *
 * "See products" reveals the REAL, resolved products for the recommended
 * candidate, reusing `PlanStoreSection` — the EXACT SAME component
 * PlanResultsView.tsx (the Planner screen) already uses, never a second
 * product-card system. "Open in Planner" remains the only way anything
 * from here reaches the cart, and — exactly like MealPlanCard — it never
 * mutates the cart on its own; it hands the session's own real items to
 * the existing Smart Shopping Planner as pre-filled TEXT the shopper
 * still has to review and explicitly submit. Tapping "Add" on an
 * individual product preview reuses the SAME direct, tap-to-add action
 * every other ProductCard in this app already has — not a new or
 * different cart-mutation path.
 *
 * Section order (Phase 5.4 Part 4, revised Phase 7 P0-2): Summary (this
 * card's own explanation line) → All products in your plan → Store
 * breakdown → Explanation (`WhyThisPlanCard`, evidence-gated — see
 * recommendationExplanationService.ts) → Actions ("Open in Planner").
 *
 * Phase 6 Part 1 — presentation-only demo polish: a compact stats row
 * (stores selected / estimated savings / items found) makes "creates a
 * plan → shows stores selected → shows estimated savings" scannable in
 * one glance instead of buried in `explanation`'s prose.
 *
 * Phase 7 P0-2 — a flattened, item-first product grid (reusing the exact
 * same `PlanItemProductGrid` the store breakdown uses, just fed
 * `flattenPlanCandidateItems(recommended)` instead of one store's items)
 * now renders unconditionally right after the summary — "shows real
 * products" is the very next thing after the numbers, not something a
 * shopper has to expand a store row to find. The store-by-store
 * breakdown is preserved underneath (still collapsible) for trip
 * logistics; this is the same real data shown a second way, not a
 * second resolution pass.
 *
 * Phase 7.1 — real shadow (elevation.medium) instead of a flat hairline
 * border: this is the actual result a shopper asked for, and it was
 * visually indistinguishable from every lightweight status card around
 * it (PreferenceMemoryCard, SuggestionCard, ShoppingHistoryCard — all of
 * which now stay flat). One clear focal point per thread.
 */
export function ShoppingSessionPlanCard({
  data, onOpenInPlanner, onPressProduct, ownerEmail,
}: {
  data: ShoppingSessionPlanResult;
  onOpenInPlanner: () => void;
  onPressProduct?: (product: ApiProduct) => void;
  /** Optional (Phase 6 Part 5) — when provided, real "why chosen" badges
   * (see PlanItemProductGrid.tsx) render on each product card below.
   * Omitted callers just get cards with no badges, exactly as before. */
  ownerEmail?: string;
}) {
  const [showProducts, setShowProducts] = useState(true);
  const recommended = data.plan.candidates.find((c) => c.id === data.plan.recommendedId);
  // Phase 7 P0-2 — see this file's own header comment. Recomputed only
  // when the recommended candidate itself changes.
  const allPlanItems = recommended ? flattenPlanCandidateItems(recommended) : [];

  return (
    <View style={styles.card}>
      <View style={styles.titleRow}>
        <Ionicons name="bag-handle-outline" size={16} color={colors.green} />
        {/* Phase 6.1 Part 6 — renamed from "Shopping options" to match
            the "plan"/"trip" language every other real string on this
            same card already uses (the magic moment banner, the
            Planner's own header, PlanResultsView) — this was a real,
            pre-existing terminology inconsistency. */}
        <Text style={styles.title}>Your optimized shopping plan</Text>
      </View>

      {/* Phase 6.1 Part 4 — reordered to lead with "how much did I save?"
          before "where am I shopping?", matching the requested summary
          hierarchy. Same three real numbers as Phase 6 Part 1, same
          source fields (`recommended`) — order only. */}
      {recommended && (
        <View style={styles.statsRow}>
          <Stat
            icon="cash-outline"
            value={recommended.estimatedSavings > 0 ? `$${recommended.estimatedSavings.toFixed(2)}` : '—'}
            label="Est. savings"
          />
          <Stat icon="storefront-outline" value={`${recommended.storeCount} store${recommended.storeCount !== 1 ? 's' : ''}`} label="Selected" />
          <Stat icon="checkmark-done-outline" value={`${recommended.itemsFound}/${recommended.itemsTotal}`} label="Items found" />
        </View>
      )}

      {/* Phase 5.5 Part 3 — the "Magic Moment" callout. Only ever rendered
          when assistantDispatcher.ts's `dispatchStartShoppingSession`
          attached a real `historyComparison` (see
          shoppingHistoryInsightService.ts) — a real prior average from
          this shopper's own real, previously-completed sessions. No prior
          sessions means no banner at all; this component never says "you
          improved" on its own.
          Phase 6.1 Part 4/5 — given a distinct "hero" treatment (trophy
          icon, bolder border/text) rather than the plain mint box used
          elsewhere, so this app's single strongest differentiator reads
          as the moment it actually is, not just another banner. */}
      {data.historyComparison && (
        <View style={styles.magicMomentBanner}>
          <View style={styles.magicMomentTitleRow}>
            <Ionicons name="trophy" size={16} color={colors.green} />
            <Text style={styles.magicMomentTitle}>CartIQ found you a better plan</Text>
          </View>
          <Text style={styles.magicMomentBody}>
            This trip saves ${data.historyComparison.currentSavings.toFixed(2)}
            {data.historyComparison.percentBetter != null && data.historyComparison.percentBetter > 0
              ? ` — ${data.historyComparison.percentBetter}% more than your usual $${data.historyComparison.averageSavings.toFixed(2)} average.`
              : ` — your usual average is $${data.historyComparison.averageSavings.toFixed(2)}.`}
          </Text>
        </View>
      )}

      <Text style={styles.explanation}>{data.explanation}</Text>

      {/* Phase 7 P0-2 — "all products in your plan," unconditional, right
          after the summary — see this file's own header comment. */}
      {allPlanItems.length > 0 && (
        <View style={styles.allProductsSection}>
          <Text style={styles.sectionLabel}>All products in your plan</Text>
          <PlanItemProductGrid items={allPlanItems} onPressProduct={onPressProduct} ownerEmail={ownerEmail} />
        </View>
      )}

      {recommended && recommended.storeAssignments.length > 0 && (
        <AnimatedPressable onPress={() => setShowProducts((s) => !s)} scaleTo={0.98}>
          <Text style={styles.toggleText}>{showProducts ? 'Hide store breakdown' : 'Show store-by-store breakdown →'}</Text>
        </AnimatedPressable>
      )}

      {showProducts && recommended && (
        <View style={styles.productsWrap}>
          {recommended.storeAssignments.map((assignment, i) => (
            <PlanStoreSection
              key={`${assignment.store}-${assignment.location.address}`}
              index={i}
              assignment={assignment}
              onPressProduct={onPressProduct}
              ownerEmail={ownerEmail}
            />
          ))}
        </View>
      )}

      {data.recommendationExplanation && <WhyThisPlanCard explanation={data.recommendationExplanation} />}

      <AnimatedPressable onPress={onOpenInPlanner} style={styles.button} scaleTo={0.97}>
        <Text style={styles.buttonText}>Open in Planner</Text>
        <Ionicons name="chevron-forward" size={15} color={colors.white} />
      </AnimatedPressable>
    </View>
  );
}

function Stat({ icon, value, label }: { icon: keyof typeof Ionicons.glyphMap; value: string; label: string }) {
  return (
    <View style={styles.stat}>
      <Ionicons name={icon} size={14} color={colors.green} />
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { ...surfaces.card, padding: spacing.lg, marginBottom: spacing.sm, gap: spacing.xs },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  title: { ...typography.h2, fontSize: 16 },
  statsRow: {
    flexDirection: 'row', backgroundColor: colors.panelBg, borderRadius: radius.md,
    paddingVertical: spacing.sm + 2, marginTop: spacing.xs,
  },
  stat: { flex: 1, alignItems: 'center', gap: 1 },
  statValue: { color: colors.charcoal, fontWeight: '800', fontSize: 13.5, marginTop: 2 },
  statLabel: { color: `${colors.charcoal}80`, fontSize: 10.5 },
  magicMomentBanner: {
    backgroundColor: colors.mint, borderRadius: radius.md, padding: spacing.md + 2, gap: spacing.xs,
    marginTop: spacing.sm, borderWidth: 1.5, borderColor: colors.green,
  },
  magicMomentTitleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  magicMomentTitle: { color: colors.green, fontWeight: '800', fontSize: 15 },
  magicMomentBody: { color: `${colors.green}e6`, fontSize: 13, lineHeight: 18, fontWeight: '600' },
  explanation: { ...typography.body, fontSize: 13, color: `${colors.charcoal}cc`, marginTop: 2 },
  allProductsSection: { gap: spacing.xs, marginTop: spacing.sm },
  sectionLabel: { color: `${colors.charcoal}99`, fontSize: 11.5, fontWeight: '700', textTransform: 'uppercase' },
  toggleText: { color: colors.green, fontSize: 12.5, fontWeight: '700', marginTop: spacing.xs },
  productsWrap: { gap: spacing.sm, marginTop: spacing.xs },
  button: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.xs,
    backgroundColor: colors.green, borderRadius: radius.md, paddingVertical: spacing.sm + 2, marginTop: spacing.sm,
  },
  buttonText: { ...typography.button, color: colors.white },
});

import React, { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { AnimatedPressable } from '../AnimatedPressable';
import { SearchProgress } from '../SearchProgress';
import { PlanStoreSection } from '../planner/PlanStoreSection';
import { generateShoppingPlan } from '../../services/plannerService';
import { ApiError } from '../../services/apiClient';
import { useCartStore } from '../../store/cartStore';
import { everyLineMatchesOriginal } from '../../services/planValidation';
import { colors } from '../../theme/colors';
import { typography } from '../../theme/typography';
import { spacing, radius } from '../../theme/metrics';
import type { CartItem, PlanCandidate, StoreGroup } from '../../models/types';

interface Props {
  visible: boolean;
  onClose: () => void;
  items: CartItem[];
  groups: StoreGroup[];
  zipcode: string;
  /** Real driving minutes for the CURRENT cart's stores, when CartScreen
   * has already resolved one — reused rather than re-fetched, same trip
   * preview the Advisor card already draws on. */
  currentTripMinutes: number | null;
}

type Stage = 'idle' | 'loading' | 'result' | 'already-optimal' | 'error' | 'applied';

const MEANINGFUL_SAVINGS_THRESHOLD = 0.5;

function currentCost(items: CartItem[]): number {
  return items.reduce((sum, i) => sum + i.product.price * i.quantity, 0);
}

/**
 * Cart's "Auto-Optimize" — turns the vague, inert "Consider skipping the
 * extra stop" advisor insight into a concrete, one-click, reversible action.
 * Reuses the same real optimizer the Smart Shopping Planner already calls
 * (generateShoppingPlan -> /api/planner, which brute-forces every store
 * subset and picks a scored "recommended" candidate) rather than a second,
 * parallel optimizer — the cart's current items are simply sent through the
 * identical pipeline PlannerScreen already uses, so "after" is always a
 * real, fully-priced, fully-routed plan, never an estimate.
 */
export function AutoOptimizeSheet({ visible, onClose, items, groups, zipcode, currentTripMinutes }: Props) {
  const applyOptimizedItems = useCartStore((s) => s.applyOptimizedItems);
  const undoLastOptimization = useCartStore((s) => s.undoLastOptimization);

  const [stage, setStage] = useState<Stage>('idle');
  const [recommended, setRecommended] = useState<PlanCandidate | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const before = { storeCount: groups.length, cost: currentCost(items) };

  const reset = () => {
    setStage('idle');
    setRecommended(null);
    setErrorMessage(null);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleAutoOptimize = async () => {
    setStage('loading');
    try {
      const plannerItems = items.map((i) => ({ id: i.product.id, rawText: i.product.name }));
      const plan = await generateShoppingPlan(plannerItems, zipcode);
      const candidate = plan.candidates.find((c) => c.id === plan.recommendedId) ?? plan.candidates[0];
      if (!candidate) {
        setErrorMessage("Couldn't find a plan for the items in your cart.");
        setStage('error');
        return;
      }
      if (!everyLineMatchesOriginal(candidate, items)) {
        // A resolved substitution landed in a different grocery department
        // than the item it's replacing — never show or let the shopper
        // apply a plan we can't verify is actually the same kind of item.
        setErrorMessage("Couldn't verify a reliable optimized plan for this cart's exact items — try again, or optimize with the Smart Shopping Planner instead.");
        setStage('error');
        return;
      }
      setRecommended(candidate);
      const savings = before.cost - candidate.totalCost;
      const fewerStops = before.storeCount - candidate.storeCount;
      setStage(savings < MEANINGFUL_SAVINGS_THRESHOLD && fewerStops <= 0 ? 'already-optimal' : 'result');
    } catch (err) {
      setErrorMessage(err instanceof ApiError ? err.message : "Couldn't build an optimized plan.");
      setStage('error');
    }
  };

  const handleApply = async () => {
    if (!recommended) return;
    const cartItems: CartItem[] = recommended.storeAssignments.flatMap((assignment) =>
      assignment.items.filter((line) => line.product).map((line) => ({ product: line.product!, quantity: 1 })),
    );
    await applyOptimizedItems(cartItems);
    setStage('applied');
  };

  const handleUndo = async () => {
    await undoLastOptimization();
    handleClose();
  };

  const savings = recommended ? before.cost - recommended.totalCost : 0;

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={handleClose}>
      <View style={styles.overlay}>
        <Pressable style={StyleSheet.absoluteFill} onPress={stage === 'loading' ? undefined : handleClose} />
        <View style={styles.sheet}>
          <View style={styles.grabberRow}>
            <View style={styles.grabber} />
          </View>
          <View style={styles.header}>
            <Text style={typography.h2}>Auto-Optimize</Text>
            <AnimatedPressable onPress={handleClose} style={styles.closeButton} scaleTo={0.9} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name="close" size={20} color={colors.charcoal} />
            </AnimatedPressable>
          </View>

          <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
            {stage === 'idle' && (
              <View style={{ gap: spacing.lg }}>
                <Text style={styles.subtitle}>
                  We&apos;ll balance savings, number of stops, and travel to find the best version of this exact cart.
                </Text>
                <View style={styles.planCard}>
                  <Text style={styles.planCardTitle}>Current Plan</Text>
                  <StatRow
                    stores={before.storeCount}
                    cost={before.cost}
                    minutes={currentTripMinutes}
                  />
                </View>
                <AnimatedPressable onPress={handleAutoOptimize} style={styles.primaryButton} scaleTo={0.97}>
                  <Ionicons name="sparkles" size={16} color={colors.white} />
                  <Text style={styles.primaryButtonText}>Auto-Optimize</Text>
                </AnimatedPressable>
              </View>
            )}

            {stage === 'loading' && (
              <View>
                <SearchProgress />
                <Text style={styles.loadingCaption}>Finding your best plan…</Text>
              </View>
            )}

            {stage === 'error' && (
              <View style={styles.centerState}>
                <Ionicons name="alert-circle-outline" size={32} color={colors.errorRed} />
                <Text style={styles.errorText}>{errorMessage}</Text>
                <AnimatedPressable onPress={reset} scaleTo={0.97}>
                  <Text style={styles.retryText}>Try again</Text>
                </AnimatedPressable>
              </View>
            )}

            {stage === 'already-optimal' && (
              <View style={styles.centerState}>
                <Ionicons name="checkmark-circle" size={36} color={colors.green} />
                <Text style={styles.optimalTitle}>Your cart is already well optimized.</Text>
                <Text style={styles.subtitle}>We couldn&apos;t find a meaningfully better balance of price and stops.</Text>
                <AnimatedPressable onPress={handleClose} style={styles.secondaryButton} scaleTo={0.97}>
                  <Text style={styles.secondaryButtonText}>Close</Text>
                </AnimatedPressable>
              </View>
            )}

            {stage === 'result' && recommended && (
              <View style={{ gap: spacing.lg }}>
                <Text style={styles.headline}>
                  {savings >= MEANINGFUL_SAVINGS_THRESHOLD
                    ? `Save $${savings.toFixed(2)}${recommended.storeCount < before.storeCount ? ` while reducing your trip to ${recommended.storeCount} store${recommended.storeCount !== 1 ? 's' : ''}` : ''}`
                    : `Reduce your trip to ${recommended.storeCount} store${recommended.storeCount !== 1 ? 's' : ''}`}
                </Text>

                <View style={styles.compareRow}>
                  <View style={styles.compareCol}>
                    <Text style={styles.compareLabel}>Before</Text>
                    <Text style={styles.compareStores}>{before.storeCount} store{before.storeCount !== 1 ? 's' : ''}</Text>
                    <Text style={styles.compareCost}>${before.cost.toFixed(2)}</Text>
                  </View>
                  <Ionicons name="arrow-forward" size={18} color={`${colors.charcoal}66`} />
                  <View style={styles.compareCol}>
                    <Text style={styles.compareLabel}>After</Text>
                    <Text style={[styles.compareStores, styles.compareAfterHighlight]}>
                      {recommended.storeCount} store{recommended.storeCount !== 1 ? 's' : ''}
                    </Text>
                    <Text style={[styles.compareCost, styles.compareAfterHighlight]}>${recommended.totalCost.toFixed(2)}</Text>
                  </View>
                </View>

                <View style={{ gap: spacing.sm }}>
                  <Text style={styles.sectionTitle}>Optimized Route</Text>
                  {recommended.storeAssignments.map((assignment, i) => (
                    <PlanStoreSection key={`${assignment.store}-${assignment.location.address}`} index={i} assignment={assignment} />
                  ))}
                </View>

                <AnimatedPressable onPress={handleApply} style={styles.primaryButton} scaleTo={0.97}>
                  <Text style={styles.primaryButtonText}>Apply Plan</Text>
                </AnimatedPressable>
                <AnimatedPressable onPress={handleClose} style={styles.secondaryButton} scaleTo={0.97}>
                  <Text style={styles.secondaryButtonText}>Keep Current Cart</Text>
                </AnimatedPressable>
              </View>
            )}

            {stage === 'applied' && (
              <View style={styles.centerState}>
                <Ionicons name="checkmark-circle" size={36} color={colors.green} />
                <Text style={styles.optimalTitle}>Plan applied to your cart.</Text>
                <Text style={styles.subtitle}>Changed your mind? You can undo this instantly.</Text>
                <AnimatedPressable onPress={handleUndo} style={styles.secondaryButton} scaleTo={0.97}>
                  <Ionicons name="arrow-undo" size={15} color={colors.green} />
                  <Text style={styles.secondaryButtonText}>Undo</Text>
                </AnimatedPressable>
                <AnimatedPressable onPress={handleClose} style={styles.primaryButton} scaleTo={0.97}>
                  <Text style={styles.primaryButtonText}>Done</Text>
                </AnimatedPressable>
              </View>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function formatMinutes(minutes: number): string {
  if (minutes < 1) return '<1 min';
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return m === 0 ? `${h} hr` : `${h} hr ${m} min`;
}

function StatRow({ stores, cost, minutes }: { stores: number; cost: number; minutes: number | null }) {
  return (
    <View style={styles.statRow}>
      <Stat value={`${stores}`} label={`store${stores !== 1 ? 's' : ''}`} />
      <Stat value={`$${cost.toFixed(2)}`} label="est. cost" />
      <Stat value={minutes != null ? formatMinutes(minutes) : '—'} label="est. travel" />
    </View>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.white,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    maxHeight: '88%',
  },
  grabberRow: { alignItems: 'center', paddingTop: spacing.sm },
  grabber: { width: 36, height: 4, borderRadius: 2, backgroundColor: colors.borderGray },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.lg, paddingTop: spacing.sm, paddingBottom: spacing.md,
  },
  closeButton: { padding: spacing.xs },
  body: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xl, gap: spacing.md },
  subtitle: { color: `${colors.charcoal}8c`, fontSize: 13.5, textAlign: 'center' },
  planCard: { backgroundColor: colors.panelBg, borderRadius: radius.lg, padding: spacing.lg, gap: spacing.md },
  planCardTitle: { ...typography.cardTitle, fontSize: 13 },
  statRow: { flexDirection: 'row', justifyContent: 'space-around' },
  stat: { alignItems: 'center' },
  statValue: { color: colors.charcoal, fontWeight: '800', fontSize: 17 },
  statLabel: { color: `${colors.charcoal}80`, fontSize: 11, marginTop: 2 },
  primaryButton: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm,
    backgroundColor: colors.green, borderRadius: radius.md, paddingVertical: spacing.md + 2, minHeight: 50,
  },
  primaryButtonText: { color: colors.white, fontWeight: '700', fontSize: 14.5 },
  secondaryButton: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm,
    backgroundColor: colors.mint, borderRadius: radius.md, paddingVertical: spacing.md + 2, minHeight: 50,
  },
  secondaryButtonText: { color: colors.green, fontWeight: '700', fontSize: 14.5 },
  loadingCaption: { textAlign: 'center', color: `${colors.charcoal}66`, fontSize: 12, marginTop: -spacing.xl },
  centerState: { alignItems: 'center', justifyContent: 'center', paddingVertical: 32, gap: spacing.md },
  errorText: { color: colors.errorRed, fontSize: 13.5, textAlign: 'center' },
  retryText: { color: colors.green, fontWeight: '600', fontSize: 14, textDecorationLine: 'underline' },
  optimalTitle: { ...typography.h2, fontSize: 16, textAlign: 'center' },
  headline: { ...typography.h2, fontSize: 17, textAlign: 'center' },
  compareRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around',
    backgroundColor: colors.panelBg, borderRadius: radius.lg, padding: spacing.lg,
  },
  compareCol: { alignItems: 'center', gap: 2 },
  compareLabel: { color: `${colors.charcoal}80`, fontSize: 11, fontWeight: '600', textTransform: 'uppercase' },
  compareStores: { color: colors.charcoal, fontWeight: '700', fontSize: 14 },
  compareCost: { color: colors.charcoal, fontWeight: '700', fontSize: 16 },
  compareAfterHighlight: { color: colors.green },
  sectionTitle: { ...typography.cardTitle, fontSize: 14 },
});

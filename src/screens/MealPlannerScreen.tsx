import React, { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { ScreenContainer } from '../components/ScreenContainer';
import { ScreenHeader } from '../components/ScreenHeader';
import { Ionicons } from '@expo/vector-icons';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { AnimatedPressable } from '../components/AnimatedPressable';
import { DotRow } from '../components/SearchProgress';
import { MealPlanCard } from '../components/assistant/MealPlanCard';
import { requestMealPlan } from '../services/mealPlanService';
import { getLikelyLowStockDisplayNames } from '../services/inventoryEstimationService';
import { ApiError } from '../services/apiClient';
import { useUserStore } from '../store/userStore';
import { colors } from '../theme/colors';
import { typography } from '../theme/typography';
import { spacing, radius, surfaces } from '../theme/metrics';
import type { RootStackParamList } from '../navigation/types';
import type { MealPlanGenerationResult, MealType } from '../models/types';
import type { MealPlanResult } from '../models/intent';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'MealPlanner'> };

/**
 * Homepage Redesign — "Plan a Whole Meal," a dedicated, UI-driven entry
 * point over the exact same real generator the Assistant's "plan my
 * meals" flow already calls (see mealPlanService.ts's `requestMealPlan`,
 * assistantDispatcher.ts's `dispatchMealPlan`, and
 * backend/src/services/mealPlanService.ts — deterministic, curated
 * templates, no AI, no prices, no new logic added here). The pantry
 * advisory (`lowStockItems`) reuses the exact same real, on-device
 * signal via `getLikelyLowStockDisplayNames` — the identical helper
 * `dispatchMealPlan`'s own dependency now calls too (Homepage Redesign
 * extracted it out of that file specifically so this screen wouldn't
 * have to re-derive it).
 *
 * Honesty note (see this phase's final report): the real generator only
 * ever varies along two real axes — `mealType` ('breakfast' | 'dinner')
 * and `mealCount` — there is no real "budget," "high protein," or
 * "party size" mode behind it. The quick-option chips below are
 * deliberately limited to combinations that produce a genuinely
 * different real result; the meal-type toggle and count stepper below
 * them expose every other real combination directly rather than adding
 * chips that would silently do nothing different.
 */
export function MealPlannerScreen({ navigation }: Props) {
  const user = useUserStore((s) => s.user);

  const [mealType, setMealType] = useState<MealType>('dinner');
  const [mealCount, setMealCount] = useState(3);
  const [stage, setStage] = useState<'idle' | 'loading' | 'result' | 'error'>('idle');
  const [result, setResult] = useState<MealPlanGenerationResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const applyQuickOption = (type: MealType, count: number) => {
    setMealType(type);
    setMealCount(count);
  };

  const handleCreatePlan = async () => {
    setStage('loading');
    setErrorMessage(null);
    try {
      const lowStockItems = await getLikelyLowStockDisplayNames(user?.email ?? '');
      const plan = await requestMealPlan({ mealCount, mealType, lowStockItems });
      setResult(plan);
      setStage('result');
    } catch (err) {
      setErrorMessage(err instanceof ApiError ? err.message : "Couldn't build a meal plan right now.");
      setStage('error');
    }
  };

  const handleOpenInPlanner = () => {
    if (!result) return;
    navigation.navigate('Planner', { prefillText: result.groceryItems.join('\n') });
  };

  // MealPlanCard renders a real `MealPlanResult` (the Assistant's own
  // shape) — reused verbatim, not a second card, so wrap the plain
  // generator response in the exact same real fields.
  const mealPlanResultData: MealPlanResult | null = result
    ? { action: 'meal_plan_result', meals: result.meals, groceryItems: result.groceryItems, pantryAdditions: result.pantryAdditions }
    : null;

  return (
    <ScreenContainer>
      <ScreenHeader title="Plan a Whole Meal" onBack={() => navigation.goBack()} />

      <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
        <Text style={styles.intro}>Choose a meal goal and CartIQ creates your grocery plan.</Text>

        <View style={styles.quickOptionsRow}>
          <QuickOption label="Dinner tonight" active={mealType === 'dinner' && mealCount === 1} onPress={() => applyQuickOption('dinner', 1)} />
          <QuickOption label="Weekly dinners" active={mealType === 'dinner' && mealCount === 7} onPress={() => applyQuickOption('dinner', 7)} />
          <QuickOption label="Family meals" active={mealType === 'dinner' && mealCount === 5} onPress={() => applyQuickOption('dinner', 5)} />
          <QuickOption label="Breakfasts this week" active={mealType === 'breakfast' && mealCount === 7} onPress={() => applyQuickOption('breakfast', 7)} />
        </View>

        <View style={styles.controlsCard}>
          <Text style={styles.controlsLabel}>Meal type</Text>
          <View style={styles.segmentRow}>
            <SegmentButton label="Dinner" active={mealType === 'dinner'} onPress={() => setMealType('dinner')} />
            <SegmentButton label="Breakfast" active={mealType === 'breakfast'} onPress={() => setMealType('breakfast')} />
          </View>

          <Text style={[styles.controlsLabel, { marginTop: spacing.lg }]}>How many meals?</Text>
          <View style={styles.stepperRow}>
            <AnimatedPressable
              style={styles.stepperButton}
              scaleTo={0.9}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              onPress={() => setMealCount((c) => Math.max(1, c - 1))}
              accessibilityLabel="Fewer meals"
            >
              <Ionicons name="remove" size={16} color={`${colors.charcoal}b3`} />
            </AnimatedPressable>
            <Text style={styles.stepperValue}>{mealCount}</Text>
            <AnimatedPressable
              style={styles.stepperButton}
              scaleTo={0.9}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              onPress={() => setMealCount((c) => Math.min(14, c + 1))}
              accessibilityLabel="More meals"
            >
              <Ionicons name="add" size={16} color={`${colors.charcoal}b3`} />
            </AnimatedPressable>
          </View>
        </View>

        {stage === 'loading' && (
          <View style={styles.loadingRow}>
            <DotRow />
            <Text style={styles.loadingText}>Building your meal plan…</Text>
          </View>
        )}

        {stage === 'error' && errorMessage && (
          <View style={styles.errorBox}>
            <Ionicons name="alert-circle-outline" size={16} color={colors.errorRed} />
            <Text style={styles.errorText}>{errorMessage}</Text>
          </View>
        )}

        {stage !== 'result' && (
          <AnimatedPressable onPress={handleCreatePlan} style={styles.primaryButton} scaleTo={0.97} disabled={stage === 'loading'}>
            <Text style={styles.primaryButtonText}>Plan Meal</Text>
            <Ionicons name="chevron-forward" size={15} color={colors.white} />
          </AnimatedPressable>
        )}

        {stage === 'result' && mealPlanResultData && (
          <>
            <MealPlanCard data={mealPlanResultData} onOpenInPlanner={handleOpenInPlanner} />
            <AnimatedPressable onPress={() => setStage('idle')} scaleTo={0.97} style={styles.tryAgainButton}>
              <Text style={styles.tryAgainText}>Plan a different meal</Text>
            </AnimatedPressable>
          </>
        )}
      </ScrollView>
    </ScreenContainer>
  );
}

function QuickOption({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <AnimatedPressable onPress={onPress} style={[styles.quickOption, active && styles.quickOptionActive]} scaleTo={0.96}>
      <Text style={[styles.quickOptionText, active && styles.quickOptionTextActive]}>{label}</Text>
    </AnimatedPressable>
  );
}

function SegmentButton({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <AnimatedPressable onPress={onPress} style={[styles.segmentButton, active && styles.segmentButtonActive]} scaleTo={0.97}>
      <Text style={[styles.segmentButtonText, active && styles.segmentButtonTextActive]}>{label}</Text>
    </AnimatedPressable>
  );
}

const styles = StyleSheet.create({
  body: { padding: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.lg },
  intro: { ...typography.body, color: `${colors.charcoal}99`, textAlign: 'center' },
  quickOptionsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, justifyContent: 'center' },
  quickOption: { backgroundColor: colors.panelBg, borderRadius: radius.pill, paddingHorizontal: spacing.md, paddingVertical: spacing.sm + 2 },
  quickOptionActive: { backgroundColor: colors.green },
  quickOptionText: { color: colors.charcoal, fontSize: 12.5, fontWeight: '600' },
  quickOptionTextActive: { color: colors.white },
  controlsCard: { ...surfaces.flat, padding: spacing.lg },
  controlsLabel: { ...typography.overline, color: `${colors.charcoal}99`, marginBottom: spacing.sm },
  segmentRow: { flexDirection: 'row', gap: spacing.sm },
  segmentButton: {
    flex: 1, alignItems: 'center', paddingVertical: spacing.sm + 2, borderRadius: radius.md,
    backgroundColor: colors.white, borderWidth: 1, borderColor: colors.borderGray,
  },
  segmentButtonActive: { backgroundColor: colors.green, borderColor: colors.green },
  segmentButtonText: { color: colors.charcoal, fontSize: 13.5, fontWeight: '600' },
  segmentButtonTextActive: { color: colors.white },
  stepperRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.lg },
  stepperButton: {
    width: 36, height: 36, borderRadius: 18, borderWidth: 1, borderColor: colors.borderGray,
    backgroundColor: colors.white, alignItems: 'center', justifyContent: 'center',
  },
  stepperValue: { ...typography.h2, fontSize: 20, minWidth: 32, textAlign: 'center' },
  loadingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm },
  loadingText: { ...typography.caption },
  errorBox: {
    flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm,
    backgroundColor: colors.errorBg, borderWidth: 1, borderColor: colors.errorBorder,
    borderRadius: radius.md, padding: spacing.md,
  },
  errorText: { flex: 1, color: '#B91C1C', fontSize: 13 },
  primaryButton: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.xs,
    backgroundColor: colors.green, borderRadius: radius.md, paddingVertical: spacing.md + 2, minHeight: 50,
  },
  primaryButtonText: { ...typography.button, color: colors.white, fontSize: 15 },
  tryAgainButton: { alignItems: 'center', paddingVertical: spacing.sm },
  tryAgainText: { color: colors.green, fontSize: 13, fontWeight: '700' },
});

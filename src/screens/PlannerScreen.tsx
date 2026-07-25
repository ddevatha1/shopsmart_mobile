import React, { useCallback, useMemo, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { AnimatedPressable } from '../components/AnimatedPressable';
import { SearchProgress } from '../components/SearchProgress';
import { AmbiguityCard } from '../components/planner/AmbiguityCard';
import { PlanResultsView } from '../components/planner/PlanResultsView';
import { useUserStore } from '../store/userStore';
import { useCartStore } from '../store/cartStore';
import { parseListInput, analyzeItems, applyAmbiguityAnswers } from '../services/plannerAmbiguityService';
import { getAllPreferences, setPreference } from '../services/plannerPreferenceService';
import { generateShoppingPlan } from '../services/plannerService';
import { ApiError } from '../services/apiClient';
import { perfLog } from '../utils/perfLog';
import { colors } from '../theme/colors';
import { typography } from '../theme/typography';
import { spacing, radius } from '../theme/metrics';
import type { RootStackParamList } from '../navigation/types';
import type { AmbiguityPrompt, CartItem, PlanCandidate, PlannerListItem, ShoppingPlanResponse } from '../models/types';

type Step = 'input' | 'clarify' | 'loading' | 'results' | 'error';

const PLACEHOLDER = 'milk\neggs\nchicken\nbread\nbananas\nyogurt\ncereal';

/**
 * The Smart Shopping Planner — one screen, internal step state, per the
 * "minimize screens" requirement. Mirrors shopsmart_web's
 * app/planner/page.tsx. Ambiguity resolution (analyzeItems) runs entirely
 * on-device/instantly, so the clarify step only ever appears when it
 * genuinely improves the plan and is skipped outright otherwise.
 */
export function PlannerScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const user = useUserStore(s => s.user);
  const setCart = useCartStore(s => s.setCart);
  const zipcode = user?.zipcode ?? '';

  const [step, setStep] = useState<Step>('input');
  const [listText, setListText] = useState('');
  const [resolvedItems, setResolvedItems] = useState<PlannerListItem[]>([]);
  const [prompts, setPrompts] = useState<AmbiguityPrompt[]>([]);
  const [answers, setAnswers] = useState<Record<string, string | null>>({});
  const [rememberChoices, setRememberChoices] = useState(true);
  const [plan, setPlan] = useState<ShoppingPlanResponse | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const canSubmit = listText.trim().length > 0 && zipcode.length === 5;

  const runOptimization = useCallback(async (items: PlannerListItem[]) => {
    setStep('loading');
    try {
      const result = await generateShoppingPlan(items, zipcode);
      setPlan(result);
      setStep('results');
    } catch (err) {
      setErrorMessage(err instanceof ApiError ? err.message : 'Could not build a shopping plan.');
      setStep('error');
    }
  }, [zipcode]);

  const handleCreatePlan = async () => {
    if (!canSubmit || !user) return;

    const rawItems = parseListInput(listText);
    const rememberedPrefs = await getAllPreferences(user.email);
    const { resolved, prompts: newPrompts } = analyzeItems(rawItems, rememberedPrefs);

    setResolvedItems(resolved);

    if (newPrompts.length === 0) {
      await runOptimization(resolved);
      return;
    }

    const initialAnswers: Record<string, string | null> = {};
    for (const p of newPrompts) {
      initialAnswers[p.taxonomyEntryId] = p.rememberedDefault ?? null;
    }
    setAnswers(initialAnswers);
    setPrompts(newPrompts);
    setStep('clarify');
  };

  const handleContinueFromClarify = async () => {
    const finalItems = applyAmbiguityAnswers(resolvedItems, answers);
    setResolvedItems(finalItems);

    if (user && rememberChoices) {
      try {
        await Promise.all(
          Object.entries(answers).map(([taxonomyEntryId, subtypeId]) => setPreference(user.email, taxonomyEntryId, subtypeId)),
        );
      } catch (err) {
        console.warn('[PlannerScreen] failed to remember ambiguity choices:', err);
      }
    }
    for (const [taxonomyEntryId, subtypeId] of Object.entries(answers)) {
      perfLog('planner:ambiguity-resolved', { taxonomyEntryId, subtypeId, remembered: rememberChoices });
    }

    await runOptimization(finalItems);
  };

  const handleStartShopping = useCallback(async (candidate: PlanCandidate) => {
    const cartItems: CartItem[] = candidate.storeAssignments.flatMap(assignment =>
      assignment.items
        .filter(line => line.product)
        .map(line => ({ product: line.product!, quantity: 1 })),
    );
    await setCart(cartItems);
    navigation.navigate('Route');
  }, [setCart, navigation]);

  const allAnswered = useMemo(() => prompts.every(p => p.taxonomyEntryId in answers), [prompts, answers]);

  const handleBack = () => {
    if (step === 'input') navigation.goBack();
    else setStep('input');
  };

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <View style={styles.header}>
        <AnimatedPressable
          onPress={handleBack}
          style={styles.backButton}
          scaleTo={0.9}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Ionicons name="chevron-back" size={22} color={colors.charcoal} />
        </AnimatedPressable>
        <Text style={styles.headerTitle}>Smart Shopping Planner</Text>
        <View style={{ width: 40 }} />
      </View>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          {step === 'input' && (
            <View style={{ gap: spacing.lg }}>
              <View>
                <Text style={styles.title}>What&apos;s on your list?</Text>
                <Text style={styles.subtitle}>
                  Enter your grocery list, one item per line — we&apos;ll find the best stores, route, and prices.
                </Text>
              </View>
              <TextInput
                style={styles.textArea}
                value={listText}
                onChangeText={setListText}
                placeholder={PLACEHOLDER}
                placeholderTextColor={`${colors.charcoal}4d`}
                multiline
                textAlignVertical="top"
              />
              {!zipcode && (
                <Text style={styles.warningText}>Sign in and set your ZIP code in Profile to build a plan.</Text>
              )}
              <AnimatedPressable
                onPress={handleCreatePlan}
                disabled={!canSubmit}
                style={[styles.primaryButton, !canSubmit && styles.primaryButtonDisabled]}
              >
                <Text style={styles.primaryButtonText}>Create My Plan</Text>
              </AnimatedPressable>
            </View>
          )}

          {step === 'clarify' && (
            <View style={{ gap: spacing.lg }}>
              <View>
                <Text style={styles.title}>Quick question</Text>
                <Text style={styles.subtitle}>
                  A couple of items could mean a few things — pick what you want, or leave it up to us.
                </Text>
              </View>

              <View style={{ gap: spacing.md }}>
                {prompts.map(prompt => (
                  <AmbiguityCard
                    key={prompt.taxonomyEntryId}
                    prompt={prompt}
                    selected={answers[prompt.taxonomyEntryId] ?? null}
                    onChange={value => setAnswers(a => ({ ...a, [prompt.taxonomyEntryId]: value }))}
                  />
                ))}
              </View>

              <AnimatedPressable
                onPress={() => setRememberChoices(r => !r)}
                style={styles.rememberRow}
                scaleTo={0.98}
              >
                <Ionicons
                  name={rememberChoices ? 'checkbox' : 'square-outline'}
                  size={18}
                  color={rememberChoices ? colors.green : `${colors.charcoal}66`}
                />
                <Text style={styles.rememberText}>Remember my choices for next time</Text>
              </AnimatedPressable>

              <AnimatedPressable
                onPress={handleContinueFromClarify}
                disabled={!allAnswered}
                style={[styles.primaryButton, !allAnswered && styles.primaryButtonDisabled]}
              >
                <Text style={styles.primaryButtonText}>Continue</Text>
              </AnimatedPressable>
            </View>
          )}

          {step === 'loading' && (
            <View>
              <SearchProgress />
              <Text style={styles.loadingCaption}>Building your optimized plan…</Text>
            </View>
          )}

          {step === 'error' && (
            <View style={styles.centerState}>
              <Text style={styles.errorText}>{errorMessage}</Text>
              <AnimatedPressable onPress={() => setStep('input')} scaleTo={0.97}>
                <Text style={styles.retryText}>Try again</Text>
              </AnimatedPressable>
            </View>
          )}

          {step === 'results' && plan && (
            <PlanResultsView
              candidates={plan.candidates}
              recommendedId={plan.recommendedId}
              unresolvedItems={plan.unresolvedItems}
              onStartShopping={handleStartShopping}
            />
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.white },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
  },
  backButton: {
    width: 40, height: 40, borderRadius: radius.pill, backgroundColor: colors.panelBg,
    alignItems: 'center', justifyContent: 'center',
  },
  headerTitle: { fontWeight: '700', fontSize: 16, color: colors.charcoal },
  body: { padding: spacing.lg, paddingBottom: spacing.xxxl },
  title: { ...typography.h1, fontSize: 22, marginBottom: spacing.xs },
  subtitle: { color: `${colors.charcoal}8c`, fontSize: 13.5 },
  textArea: {
    borderWidth: 1, borderColor: colors.borderGray, borderRadius: radius.lg,
    paddingHorizontal: spacing.lg, paddingVertical: spacing.md + 2,
    fontSize: 14, color: colors.charcoal, minHeight: 190,
  },
  warningText: { color: '#92400E', fontSize: 12 },
  primaryButton: {
    backgroundColor: colors.green, borderRadius: radius.md, paddingVertical: spacing.md + 2,
    minHeight: 50, alignItems: 'center', justifyContent: 'center',
  },
  primaryButtonDisabled: { opacity: 0.4 },
  primaryButtonText: { color: colors.white, fontWeight: '700', fontSize: 14.5 },
  rememberRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  rememberText: { color: `${colors.charcoal}99`, fontSize: 12.5 },
  loadingCaption: { textAlign: 'center', color: `${colors.charcoal}66`, fontSize: 12, marginTop: -spacing.xl },
  centerState: { alignItems: 'center', justifyContent: 'center', paddingVertical: 64, gap: spacing.lg },
  errorText: { color: colors.errorRed, fontSize: 13.5, textAlign: 'center' },
  retryText: { color: colors.green, fontWeight: '600', fontSize: 14, textDecorationLine: 'underline' },
});

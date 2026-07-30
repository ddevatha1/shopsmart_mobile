import React, { useCallback, useMemo, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { ScreenContainer } from '../components/ScreenContainer';
import { ScreenHeader } from '../components/ScreenHeader';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
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
import { getPreferences } from '../services/shopperPreferenceService';
import { collectPlanCandidateProducts } from '../utils/planProducts';
import { ApiError } from '../services/apiClient';
import { perfLog } from '../utils/perfLog';
import { colors } from '../theme/colors';
import { typography } from '../theme/typography';
import { spacing, radius } from '../theme/metrics';
import type { RootStackParamList } from '../navigation/types';
import type { AmbiguityPrompt, ApiProduct, CartItem, PlanCandidate, PlannerListItem, ShoppingPlanResponse } from '../models/types';
import type { PreferencesUsed } from '../services/recommendationExplanationService';

type Step = 'input' | 'clarify' | 'loading' | 'results' | 'error';

const PLACEHOLDER = 'milk\neggs\nchicken\nbread\nbananas\nyogurt\ncereal';

/**
 * The Smart Shopping Planner — one screen, internal step state, per the
 * "minimize screens" requirement. Mirrors CartIQ_web's
 * app/planner/page.tsx. Ambiguity resolution (analyzeItems) runs entirely
 * on-device/instantly, so the clarify step only ever appears when it
 * genuinely improves the plan and is skipped outright otherwise.
 */
export function PlannerScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const route = useRoute<RouteProp<RootStackParamList, 'Planner'>>();
  const user = useUserStore(s => s.user);
  const setCart = useCartStore(s => s.setCart);
  const zipcode = user?.zipcode ?? '';

  const [step, setStep] = useState<Step>('input');
  // Phase 5.0: pre-filled only when arriving from AssistantScreen's "Open
  // in Planner" action (see navigation/types.ts's `prefillText`) — still
  // just fills the text box, same as if the shopper had typed it
  // themselves; nothing is submitted until they press "Create My Plan".
  const [listText, setListText] = useState(route.params?.prefillText ?? '');
  const [resolvedItems, setResolvedItems] = useState<PlannerListItem[]>([]);
  const [prompts, setPrompts] = useState<AmbiguityPrompt[]>([]);
  const [answers, setAnswers] = useState<Record<string, string | null>>({});
  const [rememberChoices, setRememberChoices] = useState(true);
  const [plan, setPlan] = useState<ShoppingPlanResponse | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Phase 5.4 Part 4 — real, already-stored preferences (see
  // shopperPreferenceService.ts), used only to build a real "why"
  // explanation (see PlanResultsView.tsx) — never sent to the optimizer.
  const [preferencesUsed, setPreferencesUsed] = useState<PreferencesUsed | undefined>(undefined);

  const canSubmit = listText.trim().length > 0 && zipcode.length === 5;

  const runOptimization = useCallback(async (items: PlannerListItem[]) => {
    setStep('loading');
    try {
      const result = await generateShoppingPlan(items, zipcode, user?.weeklyBudget);
      setPlan(result);
      if (user?.email) {
        const prefs = await getPreferences(user.email);
        setPreferencesUsed(
          prefs.preferredStores?.length || prefs.optimizationPreference
            ? { stores: prefs.preferredStores, optimizationPreference: prefs.optimizationPreference }
            : undefined,
        );
      }
      setStep('results');
    } catch (err) {
      setErrorMessage(err instanceof ApiError ? err.message : 'Could not build a shopping plan.');
      setStep('error');
    }
  }, [zipcode, user?.weeklyBudget, user?.email]);

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
    <ScreenContainer>
      <ScreenHeader title="Smart Shopping Planner" onBack={handleBack} />

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
              preferencesUsed={preferencesUsed}
              ownerEmail={user?.email}
              onPressProduct={(product) => {
                // A real, complete list of every product this plan
                // actually resolved — never a fabricated "related
                // products" set. See utils/planProducts.ts.
                const allProducts: ApiProduct[] = plan.candidates.flatMap(collectPlanCandidateProducts);
                navigation.navigate('ProductDetail', { product, allProducts });
              }}
            />
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
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

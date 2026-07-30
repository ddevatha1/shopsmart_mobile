import React, { useMemo, useRef, useState } from 'react';
import { Keyboard, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSearchStore } from '../store/searchStore';
import { useUserStore } from '../store/userStore';
import { useStoreModeStore } from '../store/storeModeStore';
import { AnimatedPressable } from '../components/AnimatedPressable';
import { ScreenContainer } from '../components/ScreenContainer';
import { ScreenHeader } from '../components/ScreenHeader';
import { StoreModeBar } from '../components/search/StoreModeBar';
import { StorePickerSheet } from '../components/search/StorePickerSheet';
import { validateSearchQuery } from '../utils/searchValidation';
import { colors } from '../theme/colors';
import { typography } from '../theme/typography';
import { spacing, radius, elevation } from '../theme/metrics';
import type { RootStackParamList } from '../navigation/types';

const POPULAR = ['Organic Milk', 'Avocados', 'Chicken Breast', 'Almond Butter', 'Sourdough Bread'];

/** Real, existing capabilities the Assistant already handles end to end
 * (meal planning, price comparison, budget optimization) — shown here so
 * a shopper who only ever wanted to search a product still sees, in
 * passing, that this app can do more than that. Tapping one hands off to
 * the Assistant with this exact text as its `initialPrompt` (the same
 * param HomeInsightsStrip already used) rather than running it as a
 * literal product search — these are deliberately NOT simple product
 * names, they're full requests the Assistant's own intent router already
 * resolves (meal_plan, optimize_cart, etc.), matching Feature 4's "show
 * examples, not a tutorial" rule. */
const ASSISTANT_EXAMPLES = [
  'Find cheapest chicken breast',
  'Compare milk prices',
  'Make chicken Alfredo',
];

/**
 * Navigation Redesign — a focused, single-purpose task screen (per the
 * brief's own "search screen is a focused task experience" framing),
 * reached only by tapping the Home Hub's search bar and pushed on top of
 * it (see navigation/types.ts's `Search`). Large input, real search
 * history, a static popular-terms fallback, and a bridge to the
 * Assistant for anything more than a plain product lookup — deliberately
 * NOT styled like a generic search engine (no results preview, no
 * infinite scroll of suggestions): one input, a small number of real,
 * tappable starting points, nothing else competing for attention.
 */
export function SearchScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [query, setQuery] = useState('');
  const [invalidQueryMessage, setInvalidQueryMessage] = useState<string | null>(null);
  const inputRef = useRef<TextInput>(null);

  const user = useUserStore((s) => s.user);
  const zipcode = user?.zipcode ?? '';
  const recentSearches = useMemo(
    () => [...(user?.searchHistory ?? [])].reverse().slice(0, 6),
    [user?.searchHistory],
  );

  const { loading, search } = useSearchStore();
  const selectedStore = useStoreModeStore((s) => s.selectedStore);
  const setSelectedStore = useStoreModeStore((s) => s.setSelectedStore);
  const [pickerVisible, setPickerVisible] = useState(false);

  const canSubmit = query.trim().length > 0 && zipcode.length === 5;

  const runSearch = (term: string) => {
    const trimmed = term.trim();
    if (!trimmed || zipcode.length !== 5) return;
    const validation = validateSearchQuery(trimmed);
    if (!validation.valid) {
      setQuery(term);
      setInvalidQueryMessage(validation.message);
      return;
    }
    setInvalidQueryMessage(null);
    Keyboard.dismiss();
    search(trimmed);
    // `.push`, not `.navigate` — guarantees a fresh screen (and so a
    // real, single `goBack()` back to THIS Search screen) every time,
    // regardless of whether a `SearchResults` instance already exists
    // earlier in this stack from a previous search in the same session.
    navigation.push('SearchResults');
  };

  const handleQueryChange = (value: string) => {
    setQuery(value);
    if (invalidQueryMessage) setInvalidQueryMessage(null);
  };

  const chipTerms = recentSearches.length > 0 ? recentSearches : POPULAR;

  return (
    <ScreenContainer>
      <ScreenHeader title="Search" onBack={() => navigation.goBack()} />

      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
        <View style={styles.inputCard}>
          <TextInput
            ref={inputRef}
            autoFocus
            style={styles.input}
            placeholder="Search milk, bananas, chicken, etc."
            placeholderTextColor={`${colors.charcoal}59`}
            value={query}
            onChangeText={handleQueryChange}
            returnKeyType="search"
            onSubmitEditing={() => runSearch(query)}
          />
          <AnimatedPressable
            style={[styles.submitButton, !(canSubmit && !loading) && styles.submitButtonDisabled]}
            onPress={() => runSearch(query)}
            disabled={!canSubmit || loading}
          >
            <Text style={styles.submitButtonText}>
              {loading ? 'Searching…' : selectedStore ? `Search ${selectedStore}` : 'Search All Stores'}
            </Text>
          </AnimatedPressable>

          <StoreModeBar selectedStore={selectedStore} onOpenPicker={() => setPickerVisible(true)} onClear={() => setSelectedStore(null)} />

          {invalidQueryMessage && <Text style={styles.invalidQueryText}>{invalidQueryMessage}</Text>}
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionLabel}>{recentSearches.length > 0 ? 'Recent searches' : 'Suggested searches'}</Text>
          <View style={styles.chipRow}>
            {chipTerms.map((term) => (
              <AnimatedPressable key={term} onPress={() => runSearch(term)} style={styles.chip} scaleTo={0.95}>
                <Text style={styles.chipText} numberOfLines={1}>{term}</Text>
              </AnimatedPressable>
            ))}
          </View>
        </View>

        {recentSearches.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>Suggested searches</Text>
            <View style={styles.chipRow}>
              {POPULAR.map((term) => (
                <AnimatedPressable key={term} onPress={() => runSearch(term)} style={styles.chip} scaleTo={0.95}>
                  <Text style={styles.chipText} numberOfLines={1}>{term}</Text>
                </AnimatedPressable>
              ))}
            </View>
          </View>
        )}

        <View style={styles.aiSection}>
          <View style={styles.aiSectionHeader}>
            <Ionicons name="sparkles" size={15} color={colors.green} />
            <Text style={styles.aiSectionLabel}>Try asking CartIQ</Text>
          </View>
          {ASSISTANT_EXAMPLES.map((example) => (
            <AnimatedPressable
              key={example}
              onPress={() => navigation.navigate('Assistant', { initialPrompt: example })}
              style={styles.aiExampleRow}
              scaleTo={0.98}
            >
              <Text style={styles.aiExampleText} numberOfLines={2}>&quot;{example}&quot;</Text>
              <Ionicons name="arrow-forward" size={14} color={colors.green} />
            </AnimatedPressable>
          ))}
        </View>
      </ScrollView>

      <StorePickerSheet
        visible={pickerVisible}
        onClose={() => setPickerVisible(false)}
        onSelect={(store) => {
          setSelectedStore(store);
          setPickerVisible(false);
        }}
      />
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.xl },
  inputCard: { backgroundColor: colors.white, borderRadius: radius.lg, padding: spacing.lg, gap: spacing.sm, ...elevation.medium },
  input: {
    borderWidth: 1, borderColor: colors.borderGray, borderRadius: radius.md,
    paddingHorizontal: spacing.md + 2, paddingVertical: spacing.md + 4, fontSize: 16, color: colors.charcoal,
  },
  submitButton: { backgroundColor: colors.green, borderRadius: radius.md, paddingVertical: spacing.md + 2, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  submitButtonDisabled: { opacity: 0.4 },
  submitButtonText: { color: colors.white, fontWeight: '600', fontSize: 14 },
  invalidQueryText: { color: '#B45309', fontSize: 12.5, lineHeight: 17 },
  section: { gap: spacing.sm },
  sectionLabel: { ...typography.caption, textTransform: 'uppercase' },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: { backgroundColor: colors.panelBg, borderRadius: radius.pill, paddingHorizontal: spacing.md, paddingVertical: spacing.sm - 1 },
  chipText: { color: colors.charcoal, fontSize: 13, fontWeight: '500' },
  aiSection: { backgroundColor: colors.mint, borderRadius: radius.lg, padding: spacing.lg, gap: spacing.sm },
  aiSectionHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, marginBottom: 2 },
  aiSectionLabel: { ...typography.h3, fontSize: 14, color: colors.green },
  aiExampleRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: colors.white, borderRadius: radius.md, paddingHorizontal: spacing.md, paddingVertical: spacing.sm + 2,
  },
  aiExampleText: { ...typography.body, fontSize: 13, fontStyle: 'italic', flex: 1, marginRight: spacing.sm },
});

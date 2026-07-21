import React, { useEffect, useMemo, useState } from 'react';
import {
  FlatList,
  Keyboard,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useNavigation } from '@react-navigation/native';
import { STORE_NAMES, type ApiProduct } from '../models/types';
import { useSearchStore } from '../store/searchStore';
import { useUserStore } from '../store/userStore';
import { useCartStore } from '../store/cartStore';
import { ProductGroupCard } from '../components/ProductGroupCard';
import { SearchProgress } from '../components/SearchProgress';
import { CollapsibleProductSection } from '../components/CollapsibleProductSection';
import { ErrorPanel } from '../components/ErrorPanel';
import { AnimatedPressable } from '../components/AnimatedPressable';
import { AdvisorCard } from '../components/AdvisorCard';
import { validateSearchQuery } from '../utils/searchValidation';
import { getHomeInsight, type AdvisorInsight } from '../services/advisorService';
import { buildProductGroups, type ProductGroup } from '../services/comparisonService';
import { colors, storeAccents } from '../theme/colors';
import { duration, easing } from '../theme/motion';
import { spacing, radius } from '../theme/metrics';
import type { RootStackParamList } from '../navigation/types';

const POPULAR = ['Organic Milk', 'Avocados', 'Chicken Breast', 'Almond Butter', 'Sourdough Bread'];

/** Shared entrance treatment for the two empty states below (initial
 * prompt, no-results) — a state that just appeared should feel revealed,
 * not slapped on screen. */
function FadeInState({ children }: { children: React.ReactNode }) {
  const progress = useSharedValue(0);
  useEffect(() => {
    progress.value = withTiming(1, { duration: duration.slow, easing: easing.standard });
  }, [progress]);
  const style = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ translateY: (1 - progress.value) * 10 }],
  }));
  return <Animated.View style={style}>{children}</Animated.View>;
}

/** Mirrors the dashboard body in page.tsx: hero search header, popular
 * chips, empty/loading/error states, store filter chips, and the product
 * results grid. The desktop grid (`sm:grid-cols-2 xl:grid-cols-3`) becomes
 * a responsive 2-column grid sized for phones. */
export function SearchScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [query, setQuery] = useState('');
  // Local, instant feedback for a query that's clearly not grocery-related
  // (see utils/searchValidation) — set on submit, before any network
  // request, and cleared as soon as the user edits the query again.
  const [invalidQueryMessage, setInvalidQueryMessage] = useState<string | null>(null);
  // Whether the "tangentially related" tier (avocado-flavored snacks, milk
  // chocolate, etc.) has been revealed for the current search — resets
  // whenever the query changes so a new search always starts collapsed.
  const [showRelated, setShowRelated] = useState(false);
  // Same idea for products only one store carries — the main grid is
  // strictly product-specific (a group only shows there when it can
  // actually be compared across stores), so anything single-store gets set
  // aside here rather than ever appearing store-specific in the primary grid.
  const [showSingleStore, setShowSingleStore] = useState(false);
  // Tracks which query the two toggles above were last reset for. Adjusted
  // during render (React's documented pattern for resetting state when a
  // value changes) rather than in a useEffect, avoiding an extra render pass.
  const [resetForQuery, setResetForQuery] = useState('');

  // ZIP code is collected once at sign-up (see AuthScreen) and edited only
  // from Profile — the homepage never asks for it.
  const user = useUserStore((s) => s.user);
  const zipcode = user?.zipcode ?? '';
  // Most recent searches first, capped short — falls back to the static
  // POPULAR list for a brand-new account with no history yet (see
  // SearchHeader below).
  const recentSearches = useMemo(
    () => [...(user?.searchHistory ?? [])].reverse().slice(0, 6),
    [user?.searchHistory],
  );

  // The Smart Shopping Advisor's one Home-screen slot — a pantry reminder
  // or a standout deal among products this session has actually seen, at
  // most one at a time (see advisorService.getHomeInsight). Recomputed
  // only when the signed-in account or the product set actually changes,
  // and simply renders nothing while there's no real signal — a
  // brand-new/no-history account sees exactly today's UI.
  const [advisorInsight, setAdvisorInsight] = useState<AdvisorInsight | null>(null);
  const productsForAdvisor = useSearchStore((s) => s.products);
  useEffect(() => {
    let cancelled = false;
    // Always resolved asynchronously (even the "signed out" case), so
    // setAdvisorInsight is never called synchronously within the effect
    // body itself — only from inside this .then() continuation.
    const insightPromise = user
      ? getHomeInsight({ ownerEmail: user.email, recentSearchProducts: productsForAdvisor })
      : Promise.resolve(null);
    insightPromise.then((insight) => {
      if (!cancelled) setAdvisorInsight(insight);
    });
    return () => {
      cancelled = true;
    };
  }, [user, productsForAdvisor]);

  const { hasSearched, loading, error, activeQuery, search } = useSearchStore();
  const products = useSearchStore((s) => s.products);
  const addToCart = useCartStore((s) => s.addToCart);

  const canSubmit = query.trim().length > 0 && zipcode.length === 5;
  // Stage 1 shows every direct match, unfiltered — no store/deal/rating
  // filtering happens at this layer any more (see CompareScreen, where
  // Filter & Sort now lives, scoped to one category at a time). Stage 1
  // (direct matches) is grouped into semantic product categories (Fuji
  // Apples, Gala Apples, ...) rather than shown as individual listings —
  // see comparisonService.buildProductGroups. Stage 2 (related — the query
  // as an ingredient/flavor/component) lives in its own toggleable section
  // below, untouched. Missing matchType (e.g. stale cached data) defaults
  // to direct so nothing silently disappears.
  const direct = products.filter((p) => p.matchType !== 'related');
  const related = products.filter((p) => p.matchType === 'related');
  const groups = useMemo(() => buildProductGroups(direct), [direct]);
  // The primary grid only ever shows categories a shopper can actually
  // compare across stores. A group that only one store carries can't be
  // compared, so it's set aside into its own collapsible section — the only
  // place on this screen where a specific store is ever visible.
  const multiStoreGroups = useMemo(() => groups.filter((g) => g.storeCount > 1), [groups]);
  const singleStoreListings = useMemo(
    () => groups.filter((g) => g.storeCount === 1).flatMap((g) => g.listings),
    [groups],
  );

  if (activeQuery !== resetForQuery) {
    setResetForQuery(activeQuery);
    setShowRelated(false);
    setShowSingleStore(false);
  }

  const handleSubmit = () => {
    if (!canSubmit) return;
    const trimmed = query.trim();
    const validation = validateSearchQuery(trimmed);
    if (!validation.valid) {
      setInvalidQueryMessage(validation.message);
      return;
    }
    setInvalidQueryMessage(null);
    Keyboard.dismiss();
    search(trimmed);
  };

  const handleQueryChange = (value: string) => {
    setQuery(value);
    if (invalidQueryMessage) setInvalidQueryMessage(null);
  };

  const handleRefresh = () => {
    if (hasSearched && !loading) search(activeQuery);
  };

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <FlatList
        data={hasSearched && !loading && error == null ? multiStoreGroups : []}
        keyExtractor={(item) => item.id}
        numColumns={2}
        columnWrapperStyle={{ gap: spacing.md }}
        contentContainerStyle={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.md }}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={
          <SearchHeader
            query={query}
            setQuery={handleQueryChange}
            invalidQueryMessage={invalidQueryMessage}
            canSubmit={canSubmit}
            loading={loading}
            onSubmit={handleSubmit}
            hasSearched={hasSearched}
            error={error}
            displayedCount={multiStoreGroups.length}
            totalProductCount={products.length}
            recentSearches={recentSearches}
            advisorInsight={advisorInsight}
            onSeeProduct={(product) => navigation.navigate('ProductDetail', { product, allProducts: products })}
            onAddToCart={(product) => addToCart(product)}
          />
        }
        refreshControl={<RefreshControl refreshing={false} onRefresh={handleRefresh} tintColor={colors.green} />}
        renderItem={({ item, index }: { item: ProductGroup; index: number }) => (
          <View style={{ flex: 1 }}>
            <ProductGroupCard
              group={item}
              index={index}
              onPress={() => navigation.navigate('Compare', { group: item })}
            />
          </View>
        )}
        ListFooterComponent={
          hasSearched && !loading && error == null ? (
            <View style={{ gap: spacing.md }}>
              {/* Single-store options come first, then related/tangential
               * matches — a shopper who's just learned a category can't be
               * compared across stores is more likely to want the
               * single-store products next than a looser "related" match. */}
              <CollapsibleProductSection
                resetKey={activeQuery}
                products={singleStoreListings}
                expanded={showSingleStore}
                onToggle={() => setShowSingleStore((v) => !v)}
                onPressProduct={(item) => navigation.navigate('ProductDetail', { product: item, allProducts: products })}
                onAddToCart={(item) => addToCart(item)}
                sectionLabel="Single-Store Options"
                collapsedLabel={`Show ${singleStoreListings.length} product${singleStoreListings.length !== 1 ? 's' : ''} available at only one store`}
                expandedLabel="Hide single-store options"
              />
              <CollapsibleProductSection
                resetKey={activeQuery}
                products={related}
                expanded={showRelated}
                onToggle={() => setShowRelated((v) => !v)}
                onPressProduct={(item) => navigation.navigate('ProductDetail', { product: item, allProducts: products })}
                onAddToCart={(item) => addToCart(item)}
                sectionLabel={`Related to "${activeQuery}"`}
                collapsedLabel={`Show ${related.length} more product${related.length !== 1 ? 's' : ''} containing "${activeQuery}"`}
                expandedLabel="Hide related products"
              />
            </View>
          ) : null
        }
      />
    </SafeAreaView>
  );
}

// Defined as a stable, module-level component (not an inline arrow function
// re-created on every SearchScreen render) — passing a fresh function
// reference as ListHeaderComponent makes FlatList treat it as a brand new
// component type each render, forcing a full unmount/remount of everything
// inside it (including the TextInputs), which is what was resetting the
// text cursor on every keystroke.
interface SearchHeaderProps {
  query: string;
  setQuery: (v: string) => void;
  invalidQueryMessage: string | null;
  canSubmit: boolean;
  loading: boolean;
  onSubmit: () => void;
  hasSearched: boolean;
  error: string | null;
  displayedCount: number;
  totalProductCount: number;
  recentSearches: string[];
  advisorInsight: AdvisorInsight | null;
  onSeeProduct: (product: ApiProduct) => void;
  onAddToCart: (product: ApiProduct) => void;
}

function SearchHeader({
  query, setQuery, invalidQueryMessage, canSubmit, loading, onSubmit,
  hasSearched, error, displayedCount, totalProductCount, recentSearches, advisorInsight,
  onSeeProduct, onAddToCart,
}: SearchHeaderProps) {
  const chipTerms = recentSearches.length > 0 ? recentSearches : POPULAR;
  const chipLabel = recentSearches.length > 0 ? 'Recent:' : 'Popular:';
  return (
    <>
      <View style={styles.hero}>
        <Text style={styles.heroTitle}>Compare grocery prices, instantly</Text>
        <Text style={styles.heroSubtitle}>Search Trader Joe&apos;s, Sprouts, Kroger & Aldi near you.</Text>

        <View style={styles.searchCard}>
          <TextInput
            style={styles.input}
            placeholder="e.g. Organic Oat Milk"
            placeholderTextColor={`${colors.charcoal}59`}
            value={query}
            onChangeText={setQuery}
            returnKeyType="search"
            onSubmitEditing={onSubmit}
          />
          <AnimatedPressable
            style={[styles.submitButton, !(canSubmit && !loading) && styles.submitButtonDisabled]}
            onPress={onSubmit}
            disabled={!canSubmit || loading}
          >
            <Text style={styles.submitButtonText}>{loading ? 'Searching…' : 'Search All Stores'}</Text>
          </AnimatedPressable>

          {invalidQueryMessage && (
            <Text style={styles.invalidQueryText}>{invalidQueryMessage}</Text>
          )}

          <View style={styles.popularRow}>
            <Text style={styles.popularLabel}>{chipLabel}</Text>
            {chipTerms.map((term) => (
              <AnimatedPressable
                key={term}
                onPress={() => setQuery(term)}
                scaleTo={0.94}
                hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
              >
                <Text style={styles.popularTerm}>{term}</Text>
              </AnimatedPressable>
            ))}
          </View>
        </View>
      </View>

      {advisorInsight && (
        <View style={styles.advisorSlot}>
          <AdvisorCard insight={advisorInsight} onSeeProduct={onSeeProduct} onAddToCart={onAddToCart} />
        </View>
      )}

      <View style={styles.body}>
        {!hasSearched && (
          <FadeInState>
            <View style={styles.emptyState}>
              <View style={styles.dotsRow}>
                {STORE_NAMES.map((s) => (
                  <View key={s} style={[styles.storeDot, { backgroundColor: storeAccents[s].dot }]} />
                ))}
              </View>
              <Text style={styles.emptyText}>
                Enter a product above to compare prices across all four stores near you.
              </Text>
            </View>
          </FadeInState>
        )}

        {hasSearched && loading && <SearchProgress />}
        {hasSearched && !loading && error != null && <ErrorPanel message={error} />}

        {hasSearched && !loading && error == null && displayedCount === 0 && (
          <FadeInState>
            <View style={styles.emptyState}>
              <Text style={styles.emptyTitle}>No comparable products found</Text>
              <Text style={styles.emptyText}>
                {totalProductCount === 0
                  ? 'Try a different search term.'
                  : 'Check single-store options and related products below.'}
              </Text>
            </View>
          </FadeInState>
        )}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.white },
  hero: { backgroundColor: colors.mint, padding: spacing.xl, paddingBottom: spacing.xxl },
  heroTitle: { fontSize: 26, fontWeight: '800', color: colors.charcoal, lineHeight: 30 },
  heroSubtitle: { color: `${colors.charcoal}99`, fontSize: 14, marginTop: spacing.sm },
  searchCard: { backgroundColor: colors.white, borderRadius: radius.lg, padding: spacing.lg, marginTop: spacing.lg, gap: spacing.sm },
  advisorSlot: { paddingHorizontal: spacing.lg, paddingTop: spacing.lg },
  input: {
    borderWidth: 1,
    borderColor: colors.borderGray,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md + 2,
    paddingVertical: spacing.md,
    fontSize: 14,
    color: colors.charcoal,
  },
  submitButton: { backgroundColor: colors.green, borderRadius: radius.md, paddingVertical: spacing.md + 2, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  submitButtonDisabled: { opacity: 0.4 },
  submitButtonText: { color: colors.white, fontWeight: '600', fontSize: 14 },
  invalidQueryText: { color: '#B45309', fontSize: 12.5, marginTop: spacing.sm, lineHeight: 17 },
  popularRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm + 2, alignItems: 'center', marginTop: spacing.xs },
  popularLabel: { color: `${colors.charcoal}66`, fontSize: 11.5 },
  popularTerm: { color: colors.green, fontSize: 11.5, fontWeight: '500' },
  body: { paddingTop: spacing.xl },
  emptyState: { alignItems: 'center', paddingVertical: 40, gap: spacing.sm },
  dotsRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.sm },
  storeDot: { width: 10, height: 10, borderRadius: 5 },
  emptyTitle: { color: `${colors.charcoal}80`, fontWeight: '600', fontSize: 14 },
  emptyText: { color: `${colors.charcoal}80`, fontSize: 13, textAlign: 'center' },
});

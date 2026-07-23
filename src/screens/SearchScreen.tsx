import React, { useEffect, useMemo, useState } from 'react';
import {
  FlatList,
  Keyboard,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useNavigation } from '@react-navigation/native';
import { STORE_NAMES, type ApiProduct, type QueryCorrectionInfo, type StoreName } from '../models/types';
import { useSearchStore } from '../store/searchStore';
import { useUserStore } from '../store/userStore';
import { useCartStore } from '../store/cartStore';
import { useStoreModeStore } from '../store/storeModeStore';
import { ProductGroupCard } from '../components/ProductGroupCard';
import { ProductCard } from '../components/ProductCard';
import { SearchProgress } from '../components/SearchProgress';
import { ErrorPanel } from '../components/ErrorPanel';
import { AnimatedPressable } from '../components/AnimatedPressable';
import { AdvisorCard } from '../components/AdvisorCard';
import { RefinementSection } from '../components/search/RefinementSection';
import { DidYouMeanBanner } from '../components/search/DidYouMeanBanner';
import { StoreModeBar } from '../components/search/StoreModeBar';
import { StorePickerSheet } from '../components/search/StorePickerSheet';
import { ComparisonView } from '../components/comparison/ComparisonView';
import { validateSearchQuery } from '../utils/searchValidation';
import { getHomeInsight, type AdvisorInsight } from '../services/advisorService';
import {
  buildProductGroups,
  buildCombinedGroup,
  categoryLayerIsMeaningful,
  shortenSiblingLabel,
  type ProductGroup,
} from '../services/comparisonService';
import { getCurrentCoordinates, type Coordinates } from '../services/locationService';
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
  // Real device location for the "Still looking?" strip's "Browse
  // Individual Products" view (per-store distance, same as Stage 2) —
  // best-effort; a null coordinate just means that view omits distance,
  // never blocks it.
  const [coords, setCoords] = useState<Coordinates | null>(null);
  useEffect(() => {
    let cancelled = false;
    getCurrentCoordinates().then((c) => {
      if (!cancelled) setCoords(c);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // "Search Within One Store" — an optional mode a shopper explicitly opts
  // into (see storeModeStore); comparison mode (selectedStore === null) is
  // always the default. Reuses the exact same search response as
  // comparison mode (see `products` below) and just filters it down to
  // one store's listings client-side, rather than re-fetching — so
  // switching modes is instant and the current query/results are never
  // lost, satisfying "switching back should preserve the user's current
  // query whenever possible" for free.
  const selectedStore = useStoreModeStore((s) => s.selectedStore);
  const setSelectedStore = useStoreModeStore((s) => s.setSelectedStore);
  const [pickerVisible, setPickerVisible] = useState(false);

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
  const allSearchProducts = useSearchStore((s) => s.products);
  // Scoped to the chosen store while in "Search Within One Store" mode —
  // the Advisor should never nudge a shopper toward a different store's
  // deal while they've explicitly said they're only shopping at this one.
  const productsForAdvisor = selectedStore
    ? allSearchProducts.filter((p) => p.store === selectedStore)
    : allSearchProducts;
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

  const { hasSearched, loading, error, activeQuery, correction, search } = useSearchStore();
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
  // "Search Within One Store" mode: a plain, ungrouped browse of everything
  // this one retailer carries for the query — direct and related both,
  // same as the pre-comparison-redesign app, since there's no cross-store
  // semantic grouping to speak of once only one store is in view.
  const singleStoreProducts = useMemo(
    () => (selectedStore ? products.filter((p) => p.store === selectedStore) : []),
    [products, selectedStore],
  );
  const groups = useMemo(() => buildProductGroups(direct, activeQuery), [direct, activeQuery]);
  // The primary grid only ever shows categories a shopper can actually
  // compare across stores. A group that only one store carries can't be
  // compared, so it's set aside into its own collapsible section — the only
  // place on this screen where a specific store is ever visible.
  const multiStoreGroups = useMemo(() => groups.filter((g) => g.storeCount > 1), [groups]);
  // Everything the main grid can't show — a real semantic category no
  // other store carries, so it can't be compared. These become "Related
  // categories" chips in the "Still can't find it?" card instead of a
  // separate always-collapsed section of their own.
  const singleStoreGroups = useMemo(() => groups.filter((g) => g.storeCount === 1), [groups]);
  // Short, chip-sized labels (see comparisonService.shortenSiblingLabel) —
  // never a full product name — for every single-store group and every
  // tangential match, relative to the raw search query. Tapping a chip
  // jumps straight to that category/product; there's no intermediate grid
  // to open first anymore.
  const categoryChips = useMemo(
    () => [
      ...singleStoreGroups.map((g) => ({
        key: g.id,
        label: shortenSiblingLabel(g.name, activeQuery),
        onPress: () => navigation.navigate('Compare', { group: g, allDirectProducts: direct }),
      })),
      ...related.map((p) => ({
        key: p.id,
        label: shortenSiblingLabel(p.name, activeQuery, p.brand),
        onPress: () => navigation.navigate('ProductDetail', { product: p, allProducts: products }),
      })),
    ],
    [singleStoreGroups, related, activeQuery, direct, products, navigation],
  );

  const runSearch = (term: string) => {
    setQuery(term);
    Keyboard.dismiss();
    search(term);
  };

  // The "Did you mean" banner's escape hatch — re-runs the search using
  // exactly what the shopper typed, skipping correction entirely rather
  // than risking another (possibly different) auto-correction of the same
  // literal text.
  const searchOriginal = (original: string) => {
    setQuery(original);
    Keyboard.dismiss();
    search(original, { noCorrect: true });
  };

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

  const singleStoreMode = selectedStore != null;
  // The category grid (Stage 1) is only worth the extra click when there
  // are at least MIN_MEANINGFUL_CATEGORIES real, distinct, non-empty
  // multi-store categories (see comparisonService.categoryLayerIsMeaningful)
  // — otherwise route straight into the exact same Product Comparison View
  // a category normally opens into, just fed every direct-match product
  // instead of one cluster's listings (buildCombinedGroup). Never applies
  // in "Search Within One Store" mode, which already skips the category
  // layer entirely on its own terms.
  const categoryLayerWorthShowing = categoryLayerIsMeaningful(multiStoreGroups);
  const bypassToComparison = hasSearched && !loading && error == null
    && !singleStoreMode && direct.length > 0 && !categoryLayerWorthShowing;
  const combinedGroup = useMemo(
    () => (bypassToComparison ? buildCombinedGroup(direct, activeQuery) : null),
    [bypassToComparison, direct, activeQuery],
  );
  const displayedItems: (ProductGroup | ApiProduct)[] = singleStoreMode ? singleStoreProducts : multiStoreGroups;

  if (bypassToComparison && combinedGroup) {
    return (
      <SafeAreaView style={styles.safeArea} edges={['top']}>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingBottom: spacing.xxl }}
          showsVerticalScrollIndicator={false}
        >
          <SearchHeader
            query={query}
            setQuery={handleQueryChange}
            invalidQueryMessage={invalidQueryMessage}
            canSubmit={canSubmit}
            loading={loading}
            onSubmit={handleSubmit}
            hasSearched={hasSearched}
            error={error}
            displayedCount={combinedGroup.listings.length}
            totalProductCount={products.length}
            recentSearches={recentSearches}
            advisorInsight={advisorInsight}
            onSeeProduct={(product) => navigation.navigate('ProductDetail', { product, allProducts: products })}
            onAddToCart={(product) => addToCart(product)}
            selectedStore={selectedStore}
            onOpenStorePicker={() => setPickerVisible(true)}
            onClearStore={() => setSelectedStore(null)}
            correction={correction}
            onSearchOriginal={searchOriginal}
          />
          <ComparisonView
            group={combinedGroup}
            allDirectProducts={direct}
            onPressProduct={(product) => navigation.navigate('ProductDetail', { product, allProducts: products })}
            onAddToCart={(product) => addToCart(product)}
            onOpenCategory={(g) => navigation.navigate('Compare', { group: g, allDirectProducts: direct })}
            onSearchMore={runSearch}
          />
        </ScrollView>

        <StorePickerSheet
          visible={pickerVisible}
          onClose={() => setPickerVisible(false)}
          onSelect={(store) => {
            setSelectedStore(store);
            setPickerVisible(false);
          }}
        />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <FlatList
        data={hasSearched && !loading && error == null ? displayedItems : []}
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
            displayedCount={displayedItems.length}
            totalProductCount={products.length}
            recentSearches={recentSearches}
            advisorInsight={advisorInsight}
            onSeeProduct={(product) => navigation.navigate('ProductDetail', { product, allProducts: products })}
            onAddToCart={(product) => addToCart(product)}
            selectedStore={selectedStore}
            onOpenStorePicker={() => setPickerVisible(true)}
            onClearStore={() => setSelectedStore(null)}
            correction={correction}
            onSearchOriginal={searchOriginal}
          />
        }
        refreshControl={<RefreshControl refreshing={hasSearched && loading} onRefresh={handleRefresh} tintColor={colors.green} />}
        renderItem={({ item, index }) =>
          singleStoreMode ? (
            <View style={{ flex: 1 }}>
              <ProductCard
                product={item as ApiProduct}
                index={index}
                onPress={() => navigation.navigate('ProductDetail', { product: item as ApiProduct, allProducts: products })}
                onAddToCart={() => addToCart(item as ApiProduct)}
              />
            </View>
          ) : (
            <View style={{ flex: 1 }}>
              <ProductGroupCard
                group={item as ProductGroup}
                index={index}
                onPress={() => navigation.navigate('Compare', { group: item as ProductGroup, allDirectProducts: direct })}
              />
            </View>
          )
        }
        ListFooterComponent={
          hasSearched && !loading && error == null && !singleStoreMode ? (
            <RefinementSection
              userCoords={coords}
              categoryChips={categoryChips}
              browseProducts={direct}
              onPressProduct={(item) => navigation.navigate('ProductDetail', { product: item, allProducts: products })}
              onAddToCart={(item) => addToCart(item)}
              onSearchMore={runSearch}
            />
          ) : null
        }
      />

      <StorePickerSheet
        visible={pickerVisible}
        onClose={() => setPickerVisible(false)}
        onSelect={(store) => {
          setSelectedStore(store);
          setPickerVisible(false);
        }}
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
  selectedStore: StoreName | null;
  onOpenStorePicker: () => void;
  onClearStore: () => void;
  correction: QueryCorrectionInfo | null;
  onSearchOriginal: (original: string) => void;
}

function SearchHeader({
  query, setQuery, invalidQueryMessage, canSubmit, loading, onSubmit,
  hasSearched, error, displayedCount, totalProductCount, recentSearches, advisorInsight,
  onSeeProduct, onAddToCart, selectedStore, onOpenStorePicker, onClearStore,
  correction, onSearchOriginal,
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
            <Text style={styles.submitButtonText}>
              {loading ? 'Searching…' : selectedStore ? `Search ${selectedStore}` : 'Search All Stores'}
            </Text>
          </AnimatedPressable>

          <StoreModeBar selectedStore={selectedStore} onOpenPicker={onOpenStorePicker} onClear={onClearStore} />

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

      <PlannerEntryCard onPress={() => navigation.navigate('Planner')} />

      {advisorInsight && (
        <View style={styles.advisorSlot}>
          <AdvisorCard insight={advisorInsight} onSeeProduct={onSeeProduct} onAddToCart={onAddToCart} />
        </View>
      )}

      <View style={styles.body}>
        {hasSearched && !loading && error == null && correction && (
          <DidYouMeanBanner correction={correction} onSearchOriginal={onSearchOriginal} />
        )}

        {!hasSearched && (
          <FadeInState>
            <View style={styles.emptyState}>
              <View style={styles.dotsRow}>
                {(selectedStore ? [selectedStore] : STORE_NAMES).map((s) => (
                  <View key={s} style={[styles.storeDot, { backgroundColor: storeAccents[s].dot }]} />
                ))}
              </View>
              <Text style={styles.emptyText}>
                {selectedStore
                  ? `Enter a product above to browse ${selectedStore}'s inventory.`
                  : 'Enter a product above to compare prices across all four stores near you.'}
              </Text>
            </View>
          </FadeInState>
        )}

        {hasSearched && loading && <SearchProgress />}
        {hasSearched && !loading && error != null && <ErrorPanel message={error} />}

        {hasSearched && !loading && error == null && displayedCount === 0 && (
          <FadeInState>
            <View style={styles.emptyState}>
              <Text style={styles.emptyTitle}>
                {selectedStore ? `No products found at ${selectedStore}` : 'No comparable products found'}
              </Text>
              <Text style={styles.emptyText}>
                {totalProductCount === 0
                  ? 'Try a different search term.'
                  : selectedStore
                    ? 'Try a different search term, or compare across stores instead.'
                    : 'Check the refinement options below.'}
              </Text>
            </View>
          </FadeInState>
        )}
      </View>
    </>
  );
}

/** Entry point into the Smart Shopping Planner — mirrors the card
 * shopsmart_web's home page renders right below its hero search section. */
function PlannerEntryCard({ onPress }: { onPress: () => void }) {
  return (
    <AnimatedPressable onPress={onPress} style={styles.plannerCard} scaleTo={0.98}>
      <View style={styles.plannerIconBadge}>
        <Ionicons name="clipboard-outline" size={20} color={colors.green} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.plannerTitle}>Smart Shopping Planner</Text>
        <Text style={styles.plannerSubtitle}>Paste your whole grocery list — get the best route, stores, and prices, instantly.</Text>
      </View>
      <Ionicons name="chevron-forward" size={16} color={`${colors.charcoal}4d`} />
    </AnimatedPressable>
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
  plannerCard: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.md,
    backgroundColor: colors.white, borderWidth: 1, borderColor: colors.borderGray,
    borderRadius: radius.lg, padding: spacing.lg, marginHorizontal: spacing.lg, marginTop: -spacing.lg,
  },
  plannerIconBadge: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.mint, alignItems: 'center', justifyContent: 'center' },
  plannerTitle: { color: colors.charcoal, fontWeight: '700', fontSize: 14 },
  plannerSubtitle: { color: `${colors.charcoal}80`, fontSize: 12, marginTop: 2 },
});

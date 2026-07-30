import React, { useEffect, useMemo, useState } from 'react';
import { FlatList, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { ApiProduct } from '../models/types';
import { useSearchStore } from '../store/searchStore';
import { useCartStore } from '../store/cartStore';
import { useStoreModeStore } from '../store/storeModeStore';
import { ProductGroupCard } from '../components/ProductGroupCard';
import { ProductCard } from '../components/ProductCard';
import { SearchProgress } from '../components/SearchProgress';
import { ErrorPanel } from '../components/ErrorPanel';
import { ScreenContainer } from '../components/ScreenContainer';
import { ScreenHeader } from '../components/ScreenHeader';
import { RefinementSection } from '../components/search/RefinementSection';
import { DidYouMeanBanner } from '../components/search/DidYouMeanBanner';
import { StorePickerSheet } from '../components/search/StorePickerSheet';
import { ComparisonView } from '../components/comparison/ComparisonView';
import { ContextualHint } from '../components/onboarding/ContextualHint';
import {
  buildProductGroups,
  buildCombinedGroup,
  categoryLayerIsMeaningful,
  shortenSiblingLabel,
  type ProductGroup,
} from '../services/comparisonService';
import { getCurrentCoordinates, type Coordinates } from '../services/locationService';
import { getStatsForMany, type PriceStats } from '../services/priceHistoryService';
import { colors } from '../theme/colors';
import { spacing } from '../theme/metrics';
import type { RootStackParamList } from '../navigation/types';

/**
 * Navigation Redesign — Product Results, reached only after submitting a
 * query on `SearchScreen`. Everything below is the exact rendering logic
 * the old combined Home/Search screen used once `hasSearched` became
 * true — moved here unchanged, not rebuilt, so every existing behavior
 * (category grouping, the direct-to-comparison bypass, "Search Within
 * One Store" mode, price-trend badges, "Did you mean," the refinement
 * strip) keeps working exactly as it did. The only real addition is this
 * screen's own header: a back arrow (returns to `Search`, query still
 * there to edit) and the searched-for query, so a shopper always sees
 * "I searched for something," never "I left the app's home screen."
 */
export function SearchResultsScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();

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

  const selectedStore = useStoreModeStore((s) => s.selectedStore);
  const setSelectedStore = useStoreModeStore((s) => s.setSelectedStore);
  const [pickerVisible, setPickerVisible] = useState(false);

  const { hasSearched, loading, error, activeQuery, correction, search } = useSearchStore();
  const products = useSearchStore((s) => s.products);
  const addToCart = useCartStore((s) => s.addToCart);

  const direct = products.filter((p) => p.matchType !== 'related');
  const related = products.filter((p) => p.matchType === 'related');
  const singleStoreProducts = useMemo(
    () => (selectedStore ? products.filter((p) => p.store === selectedStore) : []),
    [products, selectedStore],
  );
  const groups = useMemo(() => buildProductGroups(direct, activeQuery), [direct, activeQuery]);
  const multiStoreGroups = useMemo(() => groups.filter((g) => g.storeCount > 1), [groups]);
  const singleStoreGroups = useMemo(() => groups.filter((g) => g.storeCount === 1), [groups]);
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

  const runSearch = (term: string) => search(term);
  const searchOriginal = (original: string) => search(original, { noCorrect: true });
  const handleRefresh = () => {
    if (hasSearched && !loading) search(activeQuery);
  };

  const singleStoreMode = selectedStore != null;
  const categoryLayerWorthShowing = categoryLayerIsMeaningful(multiStoreGroups);
  const bypassToComparison = hasSearched && !loading && error == null
    && !singleStoreMode && direct.length > 0 && !categoryLayerWorthShowing;
  const combinedGroup = useMemo(
    () => (bypassToComparison ? buildCombinedGroup(direct, activeQuery) : null),
    [bypassToComparison, direct, activeQuery],
  );
  const displayedItems: (ProductGroup | ApiProduct)[] = singleStoreMode ? singleStoreProducts : multiStoreGroups;

  const [priceStats, setPriceStats] = useState<Map<string, PriceStats>>(new Map());
  useEffect(() => {
    if (!singleStoreMode || singleStoreProducts.length === 0) {
      setPriceStats(new Map());
      return;
    }
    let cancelled = false;
    getStatsForMany(singleStoreProducts).then((stats) => {
      if (!cancelled) setPriceStats(stats);
    });
    return () => {
      cancelled = true;
    };
  }, [singleStoreMode, singleStoreProducts]);

  const displayedCount = bypassToComparison && combinedGroup ? combinedGroup.listings.length : displayedItems.length;

  const header = (
    <ScreenHeader
      title={`"${activeQuery || '…'}"`}
      eyebrow="Results for"
      onBack={() => navigation.goBack()}
    />
  );

  if (bypassToComparison && combinedGroup) {
    return (
      <ScreenContainer>
        {header}
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: spacing.xxl }} showsVerticalScrollIndicator={false}>
          {correction && <DidYouMeanBanner correction={correction} onSearchOriginal={searchOriginal} />}
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
      </ScreenContainer>
    );
  }

  return (
    <ScreenContainer>
      {header}
      <FlatList
        data={hasSearched && !loading && error == null ? displayedItems : []}
        keyExtractor={(item) => item.id}
        numColumns={2}
        columnWrapperStyle={{ gap: spacing.md }}
        contentContainerStyle={{ paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: spacing.xxl, gap: spacing.md }}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={
          <View>
            {correction && <DidYouMeanBanner correction={correction} onSearchOriginal={searchOriginal} />}

            {loading && <SearchProgress />}
            {!loading && error != null && <ErrorPanel message={error} />}

            {!loading && error == null && displayedCount > 0 && (
              <View style={styles.hintSlot}>
                <ContextualHint hintKey="search-compare" message="CartIQ compares prices across stores." />
              </View>
            )}

            {!loading && error == null && displayedCount === 0 && (
              <View style={styles.emptyState}>
                <Text style={styles.emptyTitle}>
                  {selectedStore ? `No products found at ${selectedStore}` : 'No comparable products found'}
                </Text>
                <Text style={styles.emptyText}>
                  {products.length === 0
                    ? 'Try a different search term.'
                    : selectedStore
                      ? 'Try a different search term, or compare across stores instead.'
                      : 'Check the refinement options below.'}
                </Text>
              </View>
            )}
          </View>
        }
        refreshControl={<RefreshControl refreshing={loading} onRefresh={handleRefresh} tintColor={colors.green} />}
        renderItem={({ item, index }) =>
          singleStoreMode ? (
            <View style={{ flex: 1 }}>
              <ProductCard
                product={item as ApiProduct}
                index={index}
                onPress={() => navigation.navigate('ProductDetail', { product: item as ApiProduct, allProducts: products })}
                onAddToCart={() => addToCart(item as ApiProduct)}
                priceTrend={(() => {
                  const stats = priceStats.get((item as ApiProduct).id);
                  return stats && stats.trend !== 'flat' ? { trend: stats.trend, changePercent: stats.changePercent } : undefined;
                })()}
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
          !loading && error == null && !singleStoreMode ? (
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
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  hintSlot: { marginBottom: spacing.md },
  emptyState: { alignItems: 'center', paddingVertical: 40, gap: spacing.sm },
  emptyTitle: { color: `${colors.charcoal}80`, fontWeight: '600', fontSize: 14, textAlign: 'center' },
  emptyText: { color: `${colors.charcoal}80`, fontSize: 13, textAlign: 'center' },
});

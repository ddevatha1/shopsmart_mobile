import React, { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { colors } from '../theme/colors';
import { typography } from '../theme/typography';
import { spacing } from '../theme/metrics';
import { AnimatedPressable } from '../components/AnimatedPressable';
import { AdvisorCard } from '../components/AdvisorCard';
import { ProductCard } from '../components/ProductCard';
import { StoreSection } from '../components/comparison/StoreSection';
import { FilterTriggerButton } from '../components/filters/FilterTriggerButton';
import { ComparisonFilterModal } from '../components/comparison/ComparisonFilterModal';
import {
  enrichListings,
  buildStoreSections,
  getBestValueSummary,
  applyComparisonFilters,
  defaultComparisonFilters,
  countActiveComparisonFilters,
  type ComparisonFilters,
  type EnrichedListing,
  type ProductGroup,
} from '../services/comparisonService';
import { getComparisonInsight, type AdvisorInsight } from '../services/advisorService';
import { getCurrentCoordinates, type Coordinates } from '../services/locationService';
import { useCartStore } from '../store/cartStore';
import type { ApiProduct } from '../models/types';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'Compare'>;

/**
 * Stage 2 — the hero experience. A single featured "Best Value" pick
 * answers "what's the best Fuji Apple to buy?" immediately, then every
 * store gets its own horizontally-browsable row of every matching product
 * it carries — not just one collapsed listing per store. Filter & Sort
 * lives here rather than on Stage 1 — it only makes sense once a shopper
 * has already picked one category to compare.
 */
export function CompareScreen({ route, navigation }: Props) {
  const { group } = route.params;
  const addToCart = useCartStore((s) => s.addToCart);

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

  const [filtersVisible, setFiltersVisible] = useState(false);
  const [filters, setFilters] = useState<ComparisonFilters>(defaultComparisonFilters());
  const activeFilterCount = countActiveComparisonFilters(filters);

  // Package Size options always reflect the full, unfiltered group — so
  // picking a size doesn't make its own checkbox disappear from the panel.
  const availableSizes = useMemo(
    () => [...new Set(group.listings.map((p) => p.size).filter(Boolean))],
    [group.listings],
  );

  const filteredGroup: ProductGroup = useMemo(
    () => ({ ...group, listings: applyComparisonFilters(group.listings, filters) }),
    [group, filters],
  );

  const allListings = useMemo(() => enrichListings(filteredGroup, coords), [filteredGroup, coords]);
  const bestValue = useMemo(() => getBestValueSummary(allListings), [allListings]);
  const storeSections = useMemo(
    () => buildStoreSections(filteredGroup, coords, filters.sort),
    [filteredGroup, coords, filters.sort],
  );

  const [insight, setInsight] = useState<AdvisorInsight | null>(null);
  useEffect(() => {
    let cancelled = false;
    getComparisonInsight(filteredGroup, allListings).then((result) => {
      if (!cancelled) setInsight(result);
    });
    return () => {
      cancelled = true;
    };
  }, [filteredGroup, allListings]);

  const openProduct = (product: ApiProduct) => {
    navigation.navigate('ProductDetail', { product, allProducts: group.listings });
  };

  const handlePressListing = (listing: EnrichedListing) => openProduct(listing.product);

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <View style={styles.header}>
        <AnimatedPressable
          onPress={() => navigation.goBack()}
          style={styles.closeButton}
          scaleTo={0.9}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Ionicons name="arrow-back" size={20} color={colors.charcoal} />
        </AnimatedPressable>
        <Text style={styles.headerTitle} numberOfLines={1}>{group.name}</Text>
        <View style={{ width: 32 }} />
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        <View style={styles.filterRow}>
          <FilterTriggerButton count={activeFilterCount} onPress={() => setFiltersVisible(true)} />
        </View>

        {bestValue && (
          <View style={styles.heroSection}>
            <Text style={styles.heroEyebrow}>Best Value</Text>
            <View style={styles.heroCardWrap}>
              <ProductCard
                product={bestValue.best.product}
                bestValue
                unitPriceLabel={bestValue.best.unitPrice?.label}
                savingsLabel={bestValue.savings != null ? `Save $${bestValue.savings.toFixed(2)}` : undefined}
                onPress={() => openProduct(bestValue.best.product)}
                onAddToCart={() => addToCart(bestValue.best.product)}
              />
            </View>
          </View>
        )}

        {insight && (
          <View style={styles.advisorSlot}>
            <AdvisorCard insight={insight} onSeeProduct={openProduct} onAddToCart={addToCart} />
          </View>
        )}

        {storeSections.length === 0 ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyText}>No products match your filters — try adjusting them.</Text>
          </View>
        ) : (
          storeSections.map((section) => (
            <StoreSection
              key={section.store}
              section={section}
              onPressListing={handlePressListing}
              onAddToCart={addToCart}
            />
          ))
        )}
      </ScrollView>

      <ComparisonFilterModal
        visible={filtersVisible}
        onClose={() => setFiltersVisible(false)}
        availableSizes={availableSizes}
        filters={filters}
        onApply={setFilters}
        onReset={() => setFilters(defaultComparisonFilters())}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.white },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  closeButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.panelBg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: { ...typography.h2, flex: 1, textAlign: 'center', marginHorizontal: spacing.sm },
  scrollContent: { paddingBottom: spacing.xxl },
  filterRow: { paddingHorizontal: spacing.lg, marginBottom: spacing.lg },
  heroSection: { paddingHorizontal: spacing.lg, alignItems: 'center', marginBottom: spacing.lg },
  heroEyebrow: {
    ...typography.overline,
    color: colors.green,
    alignSelf: 'flex-start',
    marginBottom: spacing.sm,
  },
  heroCardWrap: { width: 232 },
  advisorSlot: { paddingHorizontal: spacing.lg, marginBottom: spacing.xl },
  emptyState: { alignItems: 'center', paddingVertical: 48, paddingHorizontal: spacing.lg },
  emptyText: { color: `${colors.charcoal}80`, fontSize: 13, textAlign: 'center' },
});

import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { AdvisorCard } from '../AdvisorCard';
import { ProductCard } from '../ProductCard';
import { StoreSection } from './StoreSection';
import { FilterTriggerButton } from '../filters/FilterTriggerButton';
import { ComparisonFilterModal } from './ComparisonFilterModal';
import { RefinementSection } from '../search/RefinementSection';
import {
  enrichListings,
  buildStoreSections,
  buildProductGroups,
  shortenSiblingLabel,
  getBestValueSummary,
  applyComparisonFilters,
  defaultComparisonFilters,
  countActiveComparisonFilters,
  type ComparisonFilters,
  type EnrichedListing,
  type ProductGroup,
} from '../../services/comparisonService';
import { buildFilterSchema } from '../../services/filterSchemaService';
import { getComparisonInsight, type AdvisorInsight } from '../../services/advisorService';
import { getCurrentCoordinates, type Coordinates } from '../../services/locationService';
import { useSearchStore } from '../../store/searchStore';
import type { ApiProduct } from '../../models/types';
import { colors } from '../../theme/colors';
import { typography } from '../../theme/typography';
import { spacing } from '../../theme/metrics';

interface Props {
  group: ProductGroup;
  /** The whole direct-match pool from the search that led here — every
   * variety, every store — carried along only for the "Still can't find
   * it?" card (see RefinementSection) and the sibling-categories lookup
   * below. */
  allDirectProducts: ApiProduct[];
  onPressProduct: (product: ApiProduct) => void;
  onAddToCart: (product: ApiProduct) => void;
  /** A sibling category chip was tapped — the caller decides how to get
   * there (CompareScreen replaces itself; SearchScreen's bypass mode
   * pushes a new Compare screen), since that differs by where this view
   * is mounted. */
  onOpenCategory: (group: ProductGroup) => void;
  onSearchMore: (term: string) => void;
}

/**
 * Stage 2's body — a single featured "Best Value" pick, then every store's
 * own horizontally-browsable row of every matching product it carries.
 * Deliberately just the *content*: no screen chrome (header/back button,
 * SafeAreaView, outer ScrollView) so it can be mounted two ways —
 * CompareScreen wraps it as its own full screen after a shopper taps a
 * category, and SearchScreen mounts it directly under the search header
 * when the category layer isn't worth the click (see
 * comparisonService.categoryLayerIsMeaningful/buildCombinedGroup) — same
 * interface either way, never a third UI.
 */
export function ComparisonView({
  group, allDirectProducts, onPressProduct, onAddToCart, onOpenCategory, onSearchMore,
}: Props) {
  const activeQuery = useSearchStore((s) => s.activeQuery);

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

  const filterSchema = useMemo(() => buildFilterSchema(group.listings), [group.listings]);

  const siblingGroups = useMemo(
    () => buildProductGroups(allDirectProducts, activeQuery).filter((g) => g.id !== group.id),
    [allDirectProducts, group.id, activeQuery],
  );
  const categoryChips = useMemo(
    () => siblingGroups.map((g) => ({
      key: g.id,
      label: shortenSiblingLabel(g.name, group.name),
      onPress: () => onOpenCategory(g),
    })),
    [siblingGroups, group.name, onOpenCategory],
  );

  const filteredGroup: ProductGroup = useMemo(
    () => ({ ...group, listings: applyComparisonFilters(group.listings, filters, filterSchema.attributes) }),
    [group, filters, filterSchema.attributes],
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

  const handlePressListing = (listing: EnrichedListing) => onPressProduct(listing.product);

  return (
    <>
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
              onPress={() => onPressProduct(bestValue.best.product)}
              onAddToCart={() => onAddToCart(bestValue.best.product)}
            />
          </View>
        </View>
      )}

      {insight && (
        <View style={styles.advisorSlot}>
          <AdvisorCard insight={insight} onSeeProduct={onPressProduct} onAddToCart={onAddToCart} />
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
            onAddToCart={onAddToCart}
          />
        ))
      )}

      <RefinementSection
        userCoords={coords}
        categoryChips={categoryChips}
        browseProducts={allDirectProducts}
        onPressProduct={onPressProduct}
        onAddToCart={onAddToCart}
        onSearchMore={onSearchMore}
      />

      <ComparisonFilterModal
        visible={filtersVisible}
        onClose={() => setFiltersVisible(false)}
        sortOptions={filterSchema.sortOptions}
        sizeOptions={filterSchema.sizeOptions}
        attributeDefs={filterSchema.attributes}
        filters={filters}
        onApply={setFilters}
        onReset={() => setFilters(defaultComparisonFilters())}
      />
    </>
  );
}

const styles = StyleSheet.create({
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

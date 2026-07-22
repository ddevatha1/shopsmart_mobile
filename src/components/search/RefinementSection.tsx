import React, { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { ApiProduct } from '../../models/types';
import { buildStoreSectionsFromProducts } from '../../services/comparisonService';
import type { Coordinates } from '../../services/locationService';
import { colors } from '../../theme/colors';
import { typography } from '../../theme/typography';
import { radius, spacing } from '../../theme/metrics';
import { AnimatedPressable } from '../AnimatedPressable';
import { StoreSection } from '../comparison/StoreSection';

export interface CategoryChip {
  key: string;
  /** Already short — see comparisonService.shortenSiblingLabel — never a
   * full product name ("Kroger Fuji Apples - 3 Pound Bag"). */
  label: string;
  /** Jumps straight to that category/product — a sibling ProductGroup
   * (Compare) or a tangential related product (ProductDetail). The chip
   * itself is the action; there's no intermediate reveal step anymore. */
  onPress: () => void;
}

interface Props {
  userCoords: Coordinates | null;
  categoryChips: CategoryChip[];
  browseProducts: ApiProduct[];
  onPressProduct: (product: ApiProduct) => void;
  onAddToCart: (product: ApiProduct) => void;
  onSearchMore: (query: string) => void;
}

const VISIBLE_CHIP_LIMIT = 3;

/**
 * "Still can't find it?" — one small, quiet card at the bottom of every
 * search layer, in the same spirit as Google's "People also search for" or
 * Amazon's "Did you mean": easy to ignore, immediately useful if needed,
 * never competing with the comparison results above it for attention.
 *
 * Deliberately a single card with no repeated icons/headings/dividers —
 * an earlier version gave "More Categories," "Browse Individual Products,"
 * and "Refine Search" each their own header + icon + spacing, which read
 * as three stacked features rather than one lightweight escape hatch.
 * Here there's one heading for the whole card; everything below it is
 * typography and spacing, not iconography — the only icon left is the
 * arrow on "Browse all store products," because that's the one row that
 * actually navigates somewhere.
 */
export function RefinementSection({
  userCoords, categoryChips, browseProducts, onPressProduct, onAddToCart, onSearchMore,
}: Props) {
  const [chipsExpanded, setChipsExpanded] = useState(false);
  const [browseExpanded, setBrowseExpanded] = useState(false);
  const [draftQuery, setDraftQuery] = useState('');

  const visibleChips = chipsExpanded ? categoryChips : categoryChips.slice(0, VISIBLE_CHIP_LIMIT);
  const hiddenCount = categoryChips.length - VISIBLE_CHIP_LIMIT;

  const browseSections = browseExpanded ? buildStoreSectionsFromProducts(browseProducts, userCoords) : [];

  const handleSubmitSearch = () => {
    const trimmed = draftQuery.trim();
    if (!trimmed) return;
    onSearchMore(trimmed);
    setDraftQuery('');
  };

  if (categoryChips.length === 0 && browseProducts.length === 0) return null;

  return (
    <View style={styles.card}>
      <Text style={styles.heading}>Still can&apos;t find it?</Text>

      {categoryChips.length > 0 && (
        <View style={styles.row}>
          <Text style={styles.rowLabel}>Related categories</Text>
          <View style={styles.chipWrap}>
            {visibleChips.map((chip) => (
              <AnimatedPressable key={chip.key} onPress={chip.onPress} style={styles.chip} scaleTo={0.96}>
                <Text style={styles.chipText}>{chip.label}</Text>
              </AnimatedPressable>
            ))}
            {!chipsExpanded && hiddenCount > 0 && (
              <AnimatedPressable onPress={() => setChipsExpanded(true)} style={styles.chip} scaleTo={0.96}>
                <Text style={styles.chipText}>+{hiddenCount}</Text>
              </AnimatedPressable>
            )}
          </View>
        </View>
      )}

      {browseProducts.length > 0 && (
        <View style={styles.row}>
          <AnimatedPressable onPress={() => setBrowseExpanded((v) => !v)} style={styles.linkRow} scaleTo={0.98}>
            <Text style={styles.linkText}>{browseExpanded ? 'Hide store listings' : 'Browse all store products'}</Text>
            <Ionicons name={browseExpanded ? 'chevron-up' : 'arrow-forward'} size={13} color={colors.green} />
          </AnimatedPressable>
          {browseExpanded && (
            <View style={styles.browseBody}>
              {browseSections.map((section) => (
                <StoreSection
                  key={section.store}
                  section={section}
                  onPressListing={(listing) => onPressProduct(listing.product)}
                  onAddToCart={onAddToCart}
                />
              ))}
            </View>
          )}
        </View>
      )}

      <TextInput
        style={styles.searchInput}
        value={draftQuery}
        onChangeText={setDraftQuery}
        placeholder="Try a more specific search..."
        placeholderTextColor={`${colors.charcoal}59`}
        returnKeyType="search"
        onSubmitEditing={handleSubmitSearch}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginTop: spacing.xl,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.borderGray,
    borderRadius: radius.lg,
    padding: spacing.md + 2,
    gap: spacing.sm + 2,
  },
  heading: { ...typography.caption, fontSize: 12, color: `${colors.charcoal}80` },
  row: { gap: spacing.xs + 2 },
  rowLabel: { fontSize: 11.5, color: `${colors.charcoal}66` },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs + 2 },
  chip: {
    borderWidth: 1,
    borderColor: colors.borderGray,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.xs + 1,
  },
  chipText: { fontSize: 12, color: colors.charcoal },
  linkRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs + 2 },
  linkText: { fontSize: 12.5, color: colors.green, fontWeight: '600' },
  browseBody: { marginTop: spacing.sm },
  searchInput: {
    borderWidth: 1,
    borderColor: colors.borderGray,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 3,
    fontSize: 13,
    color: colors.charcoal,
  },
});

import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import type { ApiProduct } from '../../models/types';
import type { StoreSection as StoreSectionData, EnrichedListing } from '../../services/comparisonService';
import { ProductCard } from '../ProductCard';
import { colors, storeAccents } from '../../theme/colors';
import { typography } from '../../theme/typography';
import { spacing, radius } from '../../theme/metrics';
import { formatMiles } from '../../utils/geo';

interface Props {
  section: StoreSectionData;
  onPressListing: (listing: EnrichedListing) => void;
  onAddToCart: (product: ApiProduct) => void;
}

const CARD_WIDTH = 176;

/**
 * One store's browsable aisle within a product comparison — mirrors how the
 * app looked before the comparison redesign (a plain product-card grid),
 * just laid out horizontally per store instead of one long vertical list.
 * Every product this store carries for the category shows up here, not
 * just its single cheapest listing — "the comparison engine stays the
 * hero," but browsing a store's real variety is no longer collapsed away.
 */
export function StoreSection({ section, onPressListing, onAddToCart }: Props) {
  const accent = storeAccents[section.store];

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        {/* No served store-logo asset exists in this app's data — the
         * colored accent initial mark is the same store-identity language
         * used everywhere else (ProductCard's store badge, map pins). */}
        <View style={[styles.logo, { backgroundColor: accent.background }]}>
          <Text style={[styles.logoText, { color: accent.text }]}>
            {section.store.slice(0, 2).toUpperCase()}
          </Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.storeName}>{section.store}</Text>
          <Text style={styles.meta}>
            {section.distanceMiles != null ? `${formatMiles(section.distanceMiles)} · ` : ''}
            {section.listings.length} option{section.listings.length !== 1 ? 's' : ''}
          </Text>
        </View>
      </View>

      <View style={styles.statsRow}>
        {section.bestUnitPrice && <Stat label="Best Unit Price" value={section.bestUnitPrice.label} />}
        <Stat label="From" value={`$${section.bestPackagePrice.toFixed(2)}`} />
        <Stat label="Organic" value={section.organicAvailable ? 'Yes' : 'No'} />
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.row}
        decelerationRate="fast"
        snapToInterval={CARD_WIDTH + spacing.md}
      >
        {section.listings.map((listing, i) => (
          <View key={listing.product.id} style={styles.cardWrap}>
            <ProductCard
              product={listing.product}
              index={i}
              unitPriceLabel={listing.unitPrice?.label}
              onPress={() => onPressListing(listing)}
              onAddToCart={() => onAddToCart(listing.product)}
            />
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { marginBottom: spacing.xl },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.lg },
  logo: { width: 36, height: 36, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center' },
  logoText: { fontSize: 12, fontWeight: '800' },
  storeName: { ...typography.h3 },
  meta: { color: `${colors.charcoal}80`, fontSize: 12, marginTop: 1 },
  statsRow: {
    flexDirection: 'row',
    gap: spacing.lg,
    paddingHorizontal: spacing.lg,
    marginTop: spacing.sm,
    marginBottom: spacing.md,
  },
  stat: { gap: 1 },
  statValue: { color: colors.charcoal, fontWeight: '700', fontSize: 12.5 },
  statLabel: { color: `${colors.charcoal}66`, fontSize: 10.5 },
  row: { paddingHorizontal: spacing.lg, gap: spacing.md },
  cardWrap: { width: CARD_WIDTH },
});

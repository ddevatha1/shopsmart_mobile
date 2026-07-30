import React from 'react';
import { Image, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import type { StoreName } from '../models/types';
import { storeLogos } from '../theme/storeLogos';
import { colors } from '../theme/colors';
import { radius } from '../theme/metrics';

interface Props {
  store: StoreName;
  height?: number;
  width?: number;
  style?: StyleProp<ViewStyle>;
}

/**
 * A store's real logo, letterboxed into a fixed-size white chip via
 * `resizeMode="contain"` — real logos come in wildly different aspect
 * ratios (Aldi's near-square badge vs. Trader Joe's wide wordmark), so a
 * fixed box + contain is the sizing that looks right for all of them
 * without per-store special-casing. Replaces the old colored-initials
 * badge everywhere a store's identity is shown.
 */
export function StoreLogo({ store, height = 32, width, style }: Props) {
  return (
    <View style={[styles.chip, { height, width: width ?? height * 1.8 }, style]}>
      <Image source={storeLogos[store]} style={styles.image} resizeMode="contain" />
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    backgroundColor: colors.white,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.borderGray,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
    paddingVertical: 3,
    overflow: 'hidden',
  },
  image: { width: '100%', height: '100%' },
});

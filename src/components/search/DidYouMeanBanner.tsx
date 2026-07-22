import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { QueryCorrectionInfo } from '../../models/types';
import { colors } from '../../theme/colors';
import { spacing } from '../../theme/metrics';
import { AnimatedPressable } from '../AnimatedPressable';

interface Props {
  correction: QueryCorrectionInfo;
  /** Re-runs the search using the literal original query, bypassing
   * correction entirely — the escape hatch a 'moderate'-confidence
   * correction always pairs with, per "never silently replace a query with
   * a completely different meaning." */
  onSearchOriginal: (original: string) => void;
}

/**
 * Surfaces the backend's query-correction result (see
 * backend/src/services/queryCorrection.ts). Both confidence levels already
 * searched using the corrected term by the time this renders — they differ
 * only in how assertively that's communicated:
 *  - 'high': a quiet, already-decided statement.
 *  - 'moderate': phrased as a question, paired with a visible way back to
 *    exactly what was typed.
 */
export function DidYouMeanBanner({ correction, onSearchOriginal }: Props) {
  if (correction.level === 'high') {
    return (
      <Text style={styles.text}>
        Did you mean: <Text style={styles.emphasis}>{correction.corrected}</Text>
      </Text>
    );
  }

  return (
    <View>
      <Text style={styles.text}>
        Did you mean <Text style={styles.emphasis}>{correction.corrected}</Text>?
      </Text>
      <AnimatedPressable onPress={() => onSearchOriginal(correction.original)} scaleTo={0.98}>
        <Text style={styles.link}>Search instead for &ldquo;{correction.original}&rdquo;</Text>
      </AnimatedPressable>
    </View>
  );
}

const styles = StyleSheet.create({
  text: { fontSize: 13, color: `${colors.charcoal}8c`, marginBottom: spacing.xs },
  emphasis: { fontWeight: '700', color: colors.charcoal },
  link: { fontSize: 13, color: colors.green, fontWeight: '600', marginBottom: spacing.sm },
});

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../theme/colors';

/** Mirrors ErrorPanel in page.tsx — error state with actionable self-fixes. */
const TIPS = [
  'Verify your ZIP code is correct in your Profile',
  'Check your local internet connectivity',
  'Try again in a few moments',
  'Search for a more common grocery item (e.g. "milk" or "eggs")',
];

export function ErrorPanel({ message }: { message: string }) {
  return (
    <View style={styles.container}>
      <View style={styles.iconCircle}>
        <Ionicons name="alert-circle-outline" size={28} color={colors.errorRed} />
      </View>
      <Text style={styles.title}>Could not reach store data</Text>
      <Text style={styles.message}>{message}</Text>

      <View style={styles.tipsBox}>
        <Text style={styles.tipsHeader}>Things you can try:</Text>
        {TIPS.map((tip) => (
          <View key={tip} style={styles.tipRow}>
            <View style={styles.tipBullet}>
              <Ionicons name="chevron-forward" size={12} color={colors.errorRed} />
            </View>
            <Text style={styles.tipText}>{tip}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.errorBg,
    borderWidth: 1,
    borderColor: colors.errorBorder,
    borderRadius: 24,
    padding: 24,
    alignItems: 'center',
    marginVertical: 24,
  },
  iconCircle: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#FEE2E2',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 14,
  },
  title: { fontWeight: '700', fontSize: 16, color: colors.charcoal },
  message: { color: `${colors.charcoal}8c`, fontSize: 13, textAlign: 'center', marginTop: 6, marginBottom: 20 },
  tipsBox: {
    width: '100%',
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.errorBorder,
    borderRadius: 16,
    padding: 16,
  },
  tipsHeader: { fontWeight: '600', fontSize: 13, color: colors.charcoal, marginBottom: 10 },
  tipRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginBottom: 8 },
  tipBullet: {
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: '#FEE2E2',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  tipText: { flex: 1, color: `${colors.charcoal}a6`, fontSize: 13 },
});

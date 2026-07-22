import React, { useState } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../../theme/colors';
import { typography } from '../../theme/typography';
import { radius, spacing } from '../../theme/metrics';
import { AnimatedPressable } from '../AnimatedPressable';

interface Props {
  visible: boolean;
  onShare: () => void | Promise<void>;
  onSkip: () => void;
}

/**
 * Pre-permission explainer shown once per app session before route
 * planning falls back to the OS's own low-context location prompt — a raw
 * "Allow ShopSmart to use your location?" dialog gives shoppers no reason
 * to say yes, so this explains *why* first (a precise starting point for
 * driving directions, instead of a ZIP-code centroid), the same
 * "explain first" pattern StorePickerSheet uses for store selection.
 * Skipping is always one tap away — route planning still works from the
 * saved ZIP code either way (see tripService.planShoppingTrip).
 */
export function LocationPermissionModal({ visible, onShare, onSkip }: Props) {
  const [requesting, setRequesting] = useState(false);

  const handleShare = async () => {
    setRequesting(true);
    await onShare();
    setRequesting(false);
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onSkip}>
      <View style={styles.overlay}>
        <Pressable style={[StyleSheet.absoluteFill, styles.backdrop]} onPress={requesting ? undefined : onSkip} />
        <View style={styles.sheet}>
          <View style={styles.grabberRow}>
            <View style={styles.grabber} />
          </View>

          <View style={styles.iconCircle}>
            <Ionicons name="navigate" size={24} color={colors.green} />
          </View>
          <Text style={typography.h2}>Use your exact location?</Text>
          <Text style={styles.subtitle}>
            Sharing your precise location gives a much more accurate starting point for driving
            directions and arrival times than your saved ZIP code alone. It&apos;s only used to
            plan this route — never stored or shared.
          </Text>

          <AnimatedPressable onPress={handleShare} style={[styles.shareButton, requesting && styles.buttonDisabled]} scaleTo={0.98} disabled={requesting}>
            {requesting ? (
              <ActivityIndicator color={colors.white} />
            ) : (
              <Text style={styles.shareButtonText}>Share Precise Location</Text>
            )}
          </AnimatedPressable>

          <AnimatedPressable onPress={onSkip} style={styles.skipButton} scaleTo={0.98} disabled={requesting}>
            <Text style={styles.skipButtonText}>Use my saved ZIP instead</Text>
          </AnimatedPressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { backgroundColor: 'rgba(0,0,0,0.35)' },
  sheet: {
    backgroundColor: colors.white,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xl,
  },
  grabberRow: { alignItems: 'center', paddingTop: spacing.sm, marginBottom: spacing.md },
  grabber: { width: 36, height: 4, borderRadius: 2, backgroundColor: colors.borderGray },
  iconCircle: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#E0F3E2',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md,
  },
  subtitle: { ...typography.caption, marginTop: spacing.xs, marginBottom: spacing.lg, lineHeight: 19 },
  shareButton: {
    backgroundColor: colors.green,
    borderRadius: radius.lg,
    paddingVertical: spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonDisabled: { opacity: 0.6 },
  shareButtonText: { ...typography.bodyMedium, color: colors.white, fontWeight: '700', fontSize: 14.5 },
  skipButton: { alignItems: 'center', paddingVertical: spacing.md, marginTop: spacing.xs },
  skipButtonText: { ...typography.caption, color: `${colors.charcoal}73`, fontWeight: '600' },
});

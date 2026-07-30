import React, { useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { AnimatedPressable } from '../components/AnimatedPressable';
import { ScreenContainer } from '../components/ScreenContainer';
import { productQualityService } from '../services/productQualityService';
import { compressPhotoForUpload } from '../services/imageCompressionService';
import { recordExpiration } from '../services/expirationMemoryService';
import { useUserStore } from '../store/userStore';
import { ApiError } from '../services/apiClient';
import { colors } from '../theme/colors';
import { typography } from '../theme/typography';
import { spacing, radius, elevation } from '../theme/metrics';
import type { RootStackParamList } from '../navigation/types';
import type { VisionQualityResult } from '../models/types';

/**
 * AI Product Quality Scanner (Feature 1) + optional expiration-date
 * detection (Feature 2). Reached only via the Route screen's own
 * "Check quality" action on a pickup checklist item — an entirely
 * optional, never-forced action (see RouteScreen.tsx's ChecklistRow).
 *
 * One photo covers both features in a single request (see
 * backend/src/services/visionQualityService.ts) — the shopper never
 * takes a second picture "for the expiration date." If a real date was
 * visible, it's recorded automatically (same as purchaseHistoryService's
 * own "no per-item confirmation needed" convention) but always shown back
 * here, never silently stored with no visible trace.
 *
 * Every verdict shown is exactly the hedged-language, short sentence the
 * backend validated — this screen never adds, strengthens, or rephrases
 * a claim about food safety.
 */
type Step = 'camera' | 'analyzing' | 'result' | 'error';

const VERDICT_META: Record<VisionQualityResult['verdict'], { icon: keyof typeof Ionicons.glyphMap; color: string; label: string }> = {
  good: { icon: 'checkmark-circle', color: colors.green, label: 'Looks good' },
  caution: { icon: 'alert-circle', color: '#B45309', label: 'Use your judgment' },
  avoid: { icon: 'close-circle', color: colors.errorRed, label: 'Consider another one' },
};

export function ProductQualityScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const route = useRoute<RouteProp<RootStackParamList, 'ProductQuality'>>();
  const productName = route.params?.productName;
  const ownerEmail = useUserStore((s) => s.user?.email ?? '');

  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView>(null);

  const [step, setStep] = useState<Step>('camera');
  const [result, setResult] = useState<VisionQualityResult | null>(null);
  const [savedExpiration, setSavedExpiration] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleCapture = async () => {
    if (!cameraRef.current) return;
    setStep('analyzing');
    try {
      // No base64 requested here — the raw camera capture is full sensor
      // resolution (often several MB) and would be wasted work to encode
      // when compressPhotoForUpload immediately resizes/recompresses it
      // anyway. See imageCompressionService.ts for why this step exists
      // at all: it's the actual fix for a real, confirmed 413 upload bug,
      // not just cosmetic — `quality` alone only affects JPEG compression,
      // never pixel dimensions.
      const photo = await cameraRef.current.takePictureAsync({ quality: 0.8 });
      if (!photo?.uri) throw new Error('No photo captured.');

      const base64 = await compressPhotoForUpload(photo.uri, photo.width, photo.height);
      const quality = await productQualityService.assessQuality(base64, productName);
      setResult(quality);

      if (quality.detectedExpirationDate && productName) {
        await recordExpiration(ownerEmail, productName, quality.detectedExpirationDate);
        setSavedExpiration(quality.detectedExpirationDate);
      }
      setStep('result');
    } catch (err) {
      setErrorMessage(err instanceof ApiError ? err.message : "Couldn't analyze this photo. Try taking another picture.");
      setStep('error');
    }
  };

  const handleRetake = () => {
    setResult(null);
    setSavedExpiration(null);
    setErrorMessage(null);
    setStep('camera');
  };

  return (
    <ScreenContainer style={styles.container}>
      <View style={styles.header}>
        <AnimatedPressable onPress={() => navigation.goBack()} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Ionicons name="close" size={24} color={colors.white} />
        </AnimatedPressable>
        <Text style={styles.headerTitle}>Check item quality</Text>
        <View style={{ width: 24 }} />
      </View>

      {!permission ? (
        <View style={styles.centerFill} />
      ) : !permission.granted ? (
        <View style={styles.centerFill}>
          <Ionicons name="camera-outline" size={40} color={`${colors.white}b3`} />
          <Text style={styles.permissionText}>
            CartIQ needs camera access to check a product's quality while you shop.
          </Text>
          <AnimatedPressable onPress={requestPermission} style={styles.primaryButton}>
            <Text style={styles.primaryButtonText}>Allow Camera</Text>
          </AnimatedPressable>
        </View>
      ) : step === 'camera' ? (
        <>
          <CameraView ref={cameraRef} style={styles.camera} facing="back" />
          <View style={styles.captureRow}>
            <AnimatedPressable onPress={handleCapture} style={styles.shutterButton} scaleTo={0.9} accessibilityLabel="Take photo">
              <View />
            </AnimatedPressable>
          </View>
        </>
      ) : step === 'analyzing' ? (
        <View style={styles.centerFill}>
          <ActivityIndicator size="large" color={colors.white} />
          <Text style={styles.permissionText}>Checking the photo…</Text>
        </View>
      ) : step === 'error' ? (
        <View style={styles.centerFill}>
          <Ionicons name="alert-circle-outline" size={40} color={`${colors.white}b3`} />
          <Text style={styles.permissionText}>{errorMessage}</Text>
          <AnimatedPressable onPress={handleRetake} style={styles.primaryButton}>
            <Text style={styles.primaryButtonText}>Try Again</Text>
          </AnimatedPressable>
        </View>
      ) : (
        result && (
          <View style={styles.resultWrap}>
            <View style={styles.resultCard}>
              <Ionicons name={VERDICT_META[result.verdict].icon} size={40} color={VERDICT_META[result.verdict].color} />
              <Text style={[styles.verdictLabel, { color: VERDICT_META[result.verdict].color }]}>
                {VERDICT_META[result.verdict].label}
              </Text>
              <Text style={styles.explanationText}>{result.explanation}</Text>

              {savedExpiration && (
                <View style={styles.expirationNote}>
                  <Ionicons name="hourglass-outline" size={14} color={`${colors.charcoal}99`} />
                  <Text style={styles.expirationNoteText}>
                    Expiration detected ({savedExpiration}) — saved to your reminders.
                  </Text>
                </View>
              )}
            </View>

            <View style={styles.resultActions}>
              <AnimatedPressable onPress={handleRetake} style={styles.secondaryButton}>
                <Text style={styles.secondaryButtonText}>Scan Another</Text>
              </AnimatedPressable>
              <AnimatedPressable onPress={() => navigation.goBack()} style={styles.primaryButton}>
                <Text style={styles.primaryButtonText}>Done</Text>
              </AnimatedPressable>
            </View>
          </View>
        )
      )}
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.charcoal },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.lg, paddingVertical: spacing.md,
  },
  headerTitle: { ...typography.h3, color: colors.white },
  camera: { flex: 1 },
  captureRow: {
    position: 'absolute', bottom: spacing.xxl, left: 0, right: 0,
    alignItems: 'center', justifyContent: 'center',
  },
  shutterButton: {
    width: 68, height: 68, borderRadius: 34,
    backgroundColor: colors.white, borderWidth: 4, borderColor: `${colors.white}66`,
  },
  centerFill: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: spacing.xxl, gap: spacing.md,
  },
  permissionText: { ...typography.body, color: colors.white, textAlign: 'center' },
  primaryButton: {
    backgroundColor: colors.green, paddingHorizontal: spacing.xl, paddingVertical: spacing.md,
    borderRadius: radius.pill, ...elevation.medium,
  },
  primaryButtonText: { ...typography.button, color: colors.white },
  secondaryButton: {
    backgroundColor: 'transparent', paddingHorizontal: spacing.xl, paddingVertical: spacing.md,
    borderRadius: radius.pill, borderWidth: 1, borderColor: `${colors.white}4d`,
  },
  secondaryButtonText: { ...typography.button, color: colors.white },
  resultWrap: { flex: 1, justifyContent: 'flex-end', padding: spacing.lg, gap: spacing.lg },
  resultCard: {
    backgroundColor: colors.white, borderRadius: radius.lg, padding: spacing.xl,
    alignItems: 'center', gap: spacing.sm, ...elevation.high,
  },
  verdictLabel: { ...typography.h2 },
  explanationText: { ...typography.body, textAlign: 'center' },
  expirationNote: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.xs, marginTop: spacing.xs,
    backgroundColor: colors.panelBg, borderRadius: radius.sm, padding: spacing.sm,
  },
  expirationNoteText: { ...typography.caption, flex: 1 },
  resultActions: { flexDirection: 'row', gap: spacing.md, justifyContent: 'center' },
});

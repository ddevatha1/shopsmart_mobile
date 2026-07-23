import React, { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { authRepository, AuthError } from '../repositories/authRepository';
import { useUserStore } from '../store/userStore';
import { useOnboardingStore } from '../store/onboardingStore';
import { colors } from '../theme/colors';
import { spacing } from '../theme/metrics';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'Auth'>;
type Mode = 'signIn' | 'signUp';

/** Mirrors shopsmart_web/src/components/AuthModal.tsx exactly — same two
 * modes, same fields, same validation, same fake local-account logic (see
 * authRepository). The web dialog overlay becomes a full-screen modal
 * route here for reliable keyboard handling on mobile. */
export function AuthScreen({ navigation, route }: Props) {
  const [mode, setMode] = useState<Mode>(route.params?.initialMode ?? 'signIn');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [zipcode, setZipcode] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const signIn = useUserStore((s) => s.signIn);
  const completeOnboarding = useOnboardingStore((s) => s.completeOnboarding);

  const isSignUp = mode === 'signUp';
  const onSuccess = route.params?.onSuccess ?? 'goBack';

  const switchMode = (next: Mode) => {
    setMode(next);
    setFieldError(null);
  };

  const handleSubmit = async () => {
    setFieldError(null);
    setSubmitting(true);
    try {
      const user = isSignUp
        ? await authRepository.signUp({ name, email, zipcode })
        : await authRepository.signIn({ email });
      await signIn(user);
      if (onSuccess === 'toDashboard') {
        // Reached here either from first-launch onboarding or from its
        // Skip path — both count as "onboarding done" the moment a
        // session actually starts, so hints on the real screens can begin.
        await completeOnboarding();
        navigation.reset({ index: 0, routes: [{ name: 'Tabs' }] });
      } else {
        navigation.goBack();
      }
    } catch (err) {
      if (err instanceof AuthError) {
        setFieldError(err.message);
      } else {
        setFieldError('Something went wrong. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: colors.white }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
          <View style={styles.headerTop}>
            <Text style={styles.logo}>
              Shop<Text style={{ color: '#A8D5AA' }}>Smart</Text>
            </Text>
            <TouchableOpacity
              style={styles.closeButton}
              onPress={() => navigation.goBack()}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Ionicons name="close" size={18} color={colors.white} />
            </TouchableOpacity>
          </View>
          <Text style={styles.headerTitle}>{isSignUp ? 'Create your account' : 'Welcome back'}</Text>
          <Text style={styles.headerSubtitle}>
            {isSignUp
              ? 'Save carts across all four stores and track price history.'
              : 'Sign in to access your saved carts and search history.'}
          </Text>
        </View>

        <View style={styles.tabs}>
          <TouchableOpacity style={[styles.tab, !isSignUp && styles.tabActive]} onPress={() => switchMode('signIn')}>
            <Text style={[styles.tabText, !isSignUp && styles.tabTextActive]}>Sign In</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.tab, isSignUp && styles.tabActive]} onPress={() => switchMode('signUp')}>
            <Text style={[styles.tabText, isSignUp && styles.tabTextActive]}>Create Account</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.form}>
          {isSignUp && (
            <View style={styles.field}>
              <Text style={styles.label}>Full Name</Text>
              <TextInput style={styles.input} placeholder="Jane Smith" value={name} onChangeText={setName} />
            </View>
          )}

          <View style={styles.field}>
            <Text style={styles.label}>Email Address</Text>
            <TextInput
              style={styles.input}
              placeholder="you@example.com"
              value={email}
              onChangeText={setEmail}
              keyboardType="email-address"
              autoCapitalize="none"
            />
          </View>

          {isSignUp && (
            <View style={styles.field}>
              <Text style={styles.label}>Home ZIP Code</Text>
              <TextInput
                style={styles.input}
                placeholder="78701"
                value={zipcode}
                onChangeText={(v) => setZipcode(v.replace(/\D/g, '').slice(0, 5))}
                keyboardType="number-pad"
                maxLength={5}
              />
            </View>
          )}

          {fieldError && (
            <View style={styles.errorBox}>
              <Ionicons name="alert-circle" size={16} color={colors.errorRed} />
              <Text style={styles.errorText}>{fieldError}</Text>
            </View>
          )}

          <TouchableOpacity style={styles.submitButton} onPress={handleSubmit} disabled={submitting}>
            <Text style={styles.submitText}>{isSignUp ? 'Create Account' : 'Sign In'}</Text>
          </TouchableOpacity>

          <View style={styles.switchRow}>
            <Text style={styles.switchText}>
              {isSignUp ? 'Already have an account? ' : "Don't have an account? "}
            </Text>
            <TouchableOpacity
              onPress={() => switchMode(isSignUp ? 'signIn' : 'signUp')}
              hitSlop={{ top: 10, bottom: 10, left: 6, right: 6 }}
            >
              <Text style={styles.switchLink}>{isSignUp ? 'Sign in' : 'Sign up free'}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  header: { backgroundColor: colors.green, paddingHorizontal: 24, paddingTop: 60, paddingBottom: 24 },
  headerTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  logo: { color: colors.white, fontWeight: '800', fontSize: 20 },
  closeButton: { width: 32, height: 32, borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.2)', alignItems: 'center', justifyContent: 'center' },
  headerTitle: { color: colors.white, fontWeight: '700', fontSize: 24, marginTop: 16 },
  headerSubtitle: { color: 'rgba(255,255,255,0.75)', fontSize: 13, marginTop: 4 },
  tabs: { flexDirection: 'row' },
  tab: { flex: 1, paddingVertical: 14, alignItems: 'center', borderBottomWidth: 2, borderBottomColor: 'transparent' },
  tabActive: { borderBottomColor: colors.green },
  tabText: { fontWeight: '600', fontSize: 13.5, color: `${colors.charcoal}80` },
  tabTextActive: { color: colors.green },
  form: { padding: 24, gap: spacing.lg },
  field: { gap: spacing.sm },
  label: { fontSize: 11, fontWeight: '600', color: `${colors.charcoal}99`, letterSpacing: 0.5, textTransform: 'uppercase' },
  input: { borderWidth: 1, borderColor: '#E5E7EB', borderRadius: 12, paddingHorizontal: 14, paddingVertical: spacing.md, fontSize: 14, color: colors.charcoal },
  errorBox: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, backgroundColor: colors.errorBg, borderWidth: 1, borderColor: colors.errorBorder, borderRadius: 12, padding: spacing.md },
  errorText: { flex: 1, color: '#B91C1C', fontSize: 12 },
  submitButton: { backgroundColor: colors.green, borderRadius: 12, paddingVertical: spacing.md + 2, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  submitText: { color: colors.white, fontWeight: '600', fontSize: 14 },
  switchRow: { flexDirection: 'row', justifyContent: 'center', marginTop: spacing.xs },
  switchText: { color: `${colors.charcoal}66`, fontSize: 12 },
  switchLink: { color: colors.green, fontWeight: '600', fontSize: 12 },
});

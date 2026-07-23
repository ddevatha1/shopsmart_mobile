import React, { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { User } from '../models/types';
import { cartItemCount, cartTotal, useCartStore } from '../store/cartStore';
import { useUserStore } from '../store/userStore';
import { GROCERY_TAXONOMY } from '../data/groceryTaxonomy';
import { getAllPreferences, clearPreference } from '../services/plannerPreferenceService';
import type { PlannerPreferences } from '../repositories/plannerPreferenceRepository';
import { colors } from '../theme/colors';
import { spacing, radius } from '../theme/metrics';
import type { RootStackParamList } from '../navigation/types';

function taxonomyLabel(taxonomyEntryId: string): string {
  return taxonomyEntryId.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function subtypeLabel(taxonomyEntryId: string, subtypeId: string): string {
  if (subtypeId === 'no-preference') return 'No Preference';
  const entry = GROCERY_TAXONOMY.find(e => e.id === taxonomyEntryId);
  return entry?.subtypes.find(s => s.id === subtypeId)?.label ?? subtypeId;
}

/** Mirrors shopsmart_web/src/components/ProfileTray.tsx. The web slide-over
 * tray becomes a persistent bottom-nav tab (same rationale as CartScreen).
 * When signed out, shows a sign-in prompt — the web only ever renders
 * ProfileTray when `user` is truthy (`{user && <ProfileTray .../>}` in
 * page.tsx), so this prompt state is the mobile-appropriate equivalent of
 * "nothing to show." */
export function ProfileScreen() {
  const user = useUserStore((s) => s.user);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.white }} edges={['top']}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Profile</Text>
      </View>
      {user == null ? <SignedOutPrompt /> : <SignedInProfile user={user} />}
    </SafeAreaView>
  );
}

function SignedOutPrompt() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  return (
    <View style={styles.centerContainer}>
      <View style={styles.promptCircle}>
        <Ionicons name="person-outline" size={32} color={colors.green} />
      </View>
      <Text style={styles.promptTitle}>Sign in to ShopSmart</Text>
      <Text style={styles.promptText}>Save your cart, track search history, and pick up where you left off.</Text>
      <TouchableOpacity
        style={styles.signInButton}
        onPress={() => navigation.navigate('Auth')}
        hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
      >
        <Text style={styles.signInButtonText}>Sign In</Text>
      </TouchableOpacity>
    </View>
  );
}

function initials(name: string): string {
  return name.trim().split(/\s+/).slice(0, 2).map((w) => w[0] ?? '').join('').toUpperCase();
}

function SignedInProfile({ user }: { user: User }) {
  const items = useCartStore((s) => s.items);
  const signOut = useUserStore((s) => s.signOut);
  const updateZipcode = useUserStore((s) => s.updateZipcode);
  const updateBudget = useUserStore((s) => s.updateBudget);
  const total = cartTotal(items);
  const count = cartItemCount(items);
  const uniqueStores = new Set(items.map((i) => i.product.store)).size;

  const [plannerPrefs, setPlannerPrefs] = useState<PlannerPreferences>({});
  useEffect(() => {
    let cancelled = false;
    getAllPreferences(user.email).then((prefs) => {
      if (!cancelled) setPlannerPrefs(prefs);
    });
    return () => {
      cancelled = true;
    };
  }, [user.email]);

  const handleClearPreference = async (taxonomyEntryId: string) => {
    await clearPreference(user.email, taxonomyEntryId);
    setPlannerPrefs((prev) => {
      const next = { ...prev };
      delete next[taxonomyEntryId];
      return next;
    });
  };

  return (
    <ScrollView>
      <View style={styles.profileHeader}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{initials(user.name)}</Text>
        </View>
        <View>
          <Text style={styles.profileName}>{user.name}</Text>
          <Text style={styles.profileEmail}>{user.email}</Text>
        </View>
      </View>

      <View style={styles.body}>
        <SectionLabel text="Account" />
        <InfoCard rows={[
          ['Name', user.name],
          ['Email', user.email],
        ]} />
        <ZipCodeRow zipcode={user.zipcode} onSave={updateZipcode} />
        <BudgetRow budget={user.weeklyBudget} onSave={updateBudget} />

        <SectionLabel text="Active Cart" />
        {count > 0 ? (
          <View style={styles.cartSummary}>
            <View style={styles.cartSummaryRow}>
              <Text style={styles.cartSummaryCount}>{count} item{count !== 1 ? 's' : ''}</Text>
              <Text style={styles.cartSummaryTotal}>${total.toFixed(2)}</Text>
            </View>
            <Text style={styles.cartSummarySub}>Across {uniqueStores} store{uniqueStores !== 1 ? 's' : ''}</Text>
          </View>
        ) : (
          <EmptyCard text="No items in cart yet." />
        )}

        <SectionLabel text="Recent Searches" />
        {user.searchHistory.length > 0 ? (
          <View style={styles.chipsRow}>
            {[...user.searchHistory].reverse().slice(0, 10).map((term, i) => (
              <View key={i} style={styles.searchChip}>
                <Text style={styles.searchChipText}>{term}</Text>
              </View>
            ))}
          </View>
        ) : (
          <Text style={styles.mutedText}>No searches yet.</Text>
        )}

        <SectionLabel text="Grocery Preferences" />
        {Object.keys(plannerPrefs).length > 0 ? (
          <View style={styles.infoCard}>
            {Object.entries(plannerPrefs).map(([taxonomyEntryId, subtypeId], i, arr) => (
              <View
                key={taxonomyEntryId}
                style={[styles.prefRow, i < arr.length - 1 && styles.infoRowBorder]}
              >
                <View>
                  <Text style={styles.infoValue}>{taxonomyLabel(taxonomyEntryId)}</Text>
                  <Text style={styles.prefSubtype}>{subtypeLabel(taxonomyEntryId, subtypeId)}</Text>
                </View>
                <TouchableOpacity onPress={() => handleClearPreference(taxonomyEntryId)} hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }}>
                  <Text style={styles.prefClear}>Clear</Text>
                </TouchableOpacity>
              </View>
            ))}
          </View>
        ) : (
          <EmptyCard text="No remembered choices yet — the Smart Shopping Planner will save them here as you use it." />
        )}

        <TouchableOpacity style={styles.signOutButton} onPress={() => signOut()}>
          <Text style={styles.signOutText}>Sign Out</Text>
        </TouchableOpacity>
        <Text style={styles.footerTagline}>ShopSmart — Compare grocery prices across 4 stores</Text>
      </View>
    </ScrollView>
  );
}

function SectionLabel({ text }: { text: string }) {
  return <Text style={styles.sectionLabel}>{text.toUpperCase()}</Text>;
}

function InfoCard({ rows }: { rows: [string, string][] }) {
  return (
    <View style={styles.infoCard}>
      {rows.map(([label, value], i) => (
        <View key={label} style={[styles.infoRow, i < rows.length - 1 && styles.infoRowBorder]}>
          <Text style={styles.infoLabel}>{label}</Text>
          <Text style={styles.infoValue}>{value}</Text>
        </View>
      ))}
    </View>
  );
}

// ZIP code is only ever collected at sign-up; this is the single place a
// user can change it afterward (per instructions — homepage never asks).
function ZipCodeRow({ zipcode, onSave }: { zipcode: string; onSave: (zipcode: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(zipcode);
  const canSave = draft.length === 5;

  if (editing) {
    return (
      <View style={styles.zipEditCard}>
        <Text style={styles.infoLabel}>Home ZIP</Text>
        <View style={styles.zipEditRow}>
          <TextInput
            style={styles.zipInput}
            value={draft}
            onChangeText={(v) => setDraft(v.replace(/\D/g, '').slice(0, 5))}
            keyboardType="number-pad"
            maxLength={5}
            autoFocus
          />
          <TouchableOpacity onPress={() => setEditing(false)} hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }}>
            <Text style={styles.zipCancel}>Cancel</Text>
          </TouchableOpacity>
          <TouchableOpacity
            disabled={!canSave}
            hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }}
            onPress={() => {
              onSave(draft);
              setEditing(false);
            }}
          >
            <Text style={[styles.zipSave, !canSave && styles.zipSaveDisabled]}>Save</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <TouchableOpacity
      style={styles.zipEditCard}
      onPress={() => {
        setDraft(zipcode);
        setEditing(true);
      }}
    >
      <Text style={styles.infoLabel}>Home ZIP</Text>
      <View style={styles.zipDisplayRow}>
        <Text style={styles.infoValue}>{zipcode || '—'}</Text>
        <Ionicons name="pencil" size={13} color={`${colors.charcoal}66`} />
      </View>
    </TouchableOpacity>
  );
}

// Optional and subtle by design — an unset budget is the normal state for
// most accounts, and this row is the only place it's ever configured (see
// budgetService/advisorService for how it's used: a quiet Cart-screen
// warning when spending approaches or crosses it, never a dashboard).
function BudgetRow({ budget, onSave }: { budget: number | undefined; onSave: (budget: number | null) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(budget != null ? String(budget) : '');
  const parsedDraft = parseFloat(draft);
  const canSave = draft === '' || (Number.isFinite(parsedDraft) && parsedDraft > 0);

  if (editing) {
    return (
      <View style={styles.zipEditCard}>
        <Text style={styles.infoLabel}>Weekly Budget (optional)</Text>
        <View style={styles.zipEditRow}>
          <TextInput
            style={styles.zipInput}
            value={draft}
            onChangeText={(v) => setDraft(v.replace(/[^0-9.]/g, ''))}
            keyboardType="decimal-pad"
            placeholder="e.g. 90"
            autoFocus
          />
          <TouchableOpacity onPress={() => setEditing(false)} hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }}>
            <Text style={styles.zipCancel}>Cancel</Text>
          </TouchableOpacity>
          <TouchableOpacity
            disabled={!canSave}
            hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }}
            onPress={() => {
              onSave(draft === '' ? null : parsedDraft);
              setEditing(false);
            }}
          >
            <Text style={[styles.zipSave, !canSave && styles.zipSaveDisabled]}>Save</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <TouchableOpacity
      style={styles.zipEditCard}
      onPress={() => {
        setDraft(budget != null ? String(budget) : '');
        setEditing(true);
      }}
    >
      <Text style={styles.infoLabel}>Weekly Budget</Text>
      <View style={styles.zipDisplayRow}>
        <Text style={styles.infoValue}>{budget != null ? `$${budget.toFixed(0)}` : 'Not set'}</Text>
        <Ionicons name="pencil" size={13} color={`${colors.charcoal}66`} />
      </View>
    </TouchableOpacity>
  );
}

function EmptyCard({ text }: { text: string }) {
  return (
    <View style={styles.emptyCard}>
      <Text style={styles.mutedText}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  headerTitle: { fontWeight: '700', fontSize: 20, color: colors.charcoal },
  centerContainer: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  promptCircle: { width: 72, height: 72, borderRadius: 36, backgroundColor: colors.mint, alignItems: 'center', justifyContent: 'center', marginBottom: spacing.lg },
  promptTitle: { fontWeight: '700', fontSize: 17, color: colors.charcoal },
  promptText: { color: `${colors.charcoal}80`, fontSize: 13, textAlign: 'center', marginTop: spacing.sm, marginBottom: spacing.xl },
  signInButton: { backgroundColor: colors.green, borderRadius: radius.md, paddingVertical: spacing.md + 2, paddingHorizontal: 32, minHeight: 46, justifyContent: 'center' },
  signInButtonText: { color: colors.white, fontWeight: '600', fontSize: 14, textAlign: 'center' },
  profileHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.md + 2, backgroundColor: colors.green, padding: spacing.lg, paddingTop: spacing.sm },
  avatar: { width: 56, height: 56, borderRadius: 28, backgroundColor: 'rgba(255,255,255,0.25)', alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: colors.white, fontWeight: '700', fontSize: 18 },
  profileName: { color: colors.white, fontWeight: '700', fontSize: 17 },
  profileEmail: { color: 'rgba(255,255,255,0.75)', fontSize: 12.5, marginTop: 2 },
  body: { padding: spacing.lg },
  sectionLabel: { fontSize: 11, fontWeight: '600', color: `${colors.charcoal}80`, letterSpacing: 0.6, marginBottom: spacing.md, marginTop: spacing.xl },
  infoCard: { backgroundColor: colors.panelBg, borderRadius: radius.lg, overflow: 'hidden' },
  infoRow: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: spacing.lg, paddingVertical: spacing.md + 2 },
  infoRowBorder: { borderBottomWidth: 1, borderBottomColor: colors.borderGray },
  prefRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.lg, paddingVertical: spacing.md + 2 },
  prefSubtype: { color: `${colors.charcoal}80`, fontSize: 11.5, marginTop: 2 },
  prefClear: { color: `${colors.charcoal}66`, fontSize: 12, fontWeight: '500' },
  infoLabel: { color: `${colors.charcoal}99`, fontSize: 13 },
  infoValue: { fontWeight: '600', fontSize: 13 },
  cartSummary: { backgroundColor: colors.mint, borderRadius: radius.lg, padding: spacing.lg },
  cartSummaryRow: { flexDirection: 'row', justifyContent: 'space-between' },
  cartSummaryCount: { color: colors.green, fontWeight: '600', fontSize: 13.5 },
  cartSummaryTotal: { color: colors.green, fontWeight: '800', fontSize: 18 },
  cartSummarySub: { color: `${colors.green}b3`, fontSize: 11.5, marginTop: spacing.xs },
  emptyCard: { backgroundColor: colors.panelBg, borderRadius: radius.lg, padding: spacing.lg, alignItems: 'center' },
  mutedText: { color: `${colors.charcoal}66`, fontSize: 13 },
  chipsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  searchChip: { backgroundColor: '#F3F4F6', borderRadius: radius.pill, paddingHorizontal: spacing.md, paddingVertical: spacing.sm - 1 },
  searchChipText: { color: `${colors.charcoal}b3`, fontSize: 12, fontWeight: '500' },
  zipEditCard: { backgroundColor: colors.panelBg, borderRadius: radius.lg, paddingHorizontal: spacing.lg, paddingVertical: spacing.md + 2, marginTop: spacing.sm, gap: spacing.sm, minHeight: 48, justifyContent: 'center' },
  zipDisplayRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  zipEditRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  zipInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.borderGray,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.sm - 1,
    fontSize: 13,
    color: colors.charcoal,
    backgroundColor: colors.white,
  },
  zipCancel: { color: `${colors.charcoal}80`, fontSize: 13, fontWeight: '500' },
  zipSave: { color: colors.green, fontSize: 13, fontWeight: '700' },
  zipSaveDisabled: { opacity: 0.4 },
  signOutButton: { borderWidth: 1, borderColor: '#FECACA', borderRadius: radius.md, paddingVertical: spacing.md + 2, minHeight: 48, alignItems: 'center', justifyContent: 'center', marginTop: spacing.xxl },
  signOutText: { color: '#DC2626', fontWeight: '600', fontSize: 14 },
  footerTagline: { textAlign: 'center', color: `${colors.charcoal}4d`, fontSize: 11, marginTop: spacing.md },
});

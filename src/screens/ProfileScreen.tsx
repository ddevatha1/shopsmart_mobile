import React, { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { cartItemCount, cartTotal, useCartStore } from '../store/cartStore';
import { useGuestZipStore } from '../store/guestZipStore';
import { useGuestSearchHistoryStore } from '../store/guestSearchHistoryStore';
import { useOnboardingStore } from '../store/onboardingStore';
import { GUEST_OWNER_KEY } from '../services/guestIdentity';
import { GROCERY_TAXONOMY } from '../data/groceryTaxonomy';
import { getAllPreferences, clearPreference } from '../services/plannerPreferenceService';
import type { PlannerPreferences } from '../repositories/plannerPreferenceRepository';
import { colors } from '../theme/colors';
import { spacing, radius } from '../theme/metrics';

function taxonomyLabel(taxonomyEntryId: string): string {
  return taxonomyEntryId.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function subtypeLabel(taxonomyEntryId: string, subtypeId: string): string {
  if (subtypeId === 'no-preference') return 'No Preference';
  const entry = GROCERY_TAXONOMY.find(e => e.id === taxonomyEntryId);
  return entry?.subtypes.find(s => s.id === subtypeId)?.label ?? subtypeId;
}

/**
 * Device-local settings — no account, no sign-in, nothing to sign out of.
 * Everything here is either a Search preference (ZIP, budget) or a plain
 * read of already-existing device-local data (cart, recent searches,
 * planner preferences) — all of it works, and persists across app
 * restarts, without ever asking who the shopper is.
 */
export function ProfileScreen() {
  const items = useCartStore((s) => s.items);
  const zipHydrated = useGuestZipStore((s) => s.hydrated);
  const zipcode = useGuestZipStore((s) => s.zipcode);
  const weeklyBudget = useGuestZipStore((s) => s.weeklyBudget);
  const setZipcode = useGuestZipStore((s) => s.setZipcode);
  const setWeeklyBudget = useGuestZipStore((s) => s.setWeeklyBudget);
  const searchHistory = useGuestSearchHistoryStore((s) => s.history);
  const resetOnboarding = useOnboardingStore((s) => s.resetOnboarding);
  const total = cartTotal(items);
  const count = cartItemCount(items);
  const uniqueStores = new Set(items.map((i) => i.product.store)).size;

  const [plannerPrefs, setPlannerPrefs] = useState<PlannerPreferences>({});
  useEffect(() => {
    let cancelled = false;
    getAllPreferences(GUEST_OWNER_KEY).then((prefs) => {
      if (!cancelled) setPlannerPrefs(prefs);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleClearPreference = async (taxonomyEntryId: string) => {
    await clearPreference(GUEST_OWNER_KEY, taxonomyEntryId);
    setPlannerPrefs((prev) => {
      const next = { ...prev };
      delete next[taxonomyEntryId];
      return next;
    });
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.white }} edges={['top']}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Settings</Text>
      </View>
      <ScrollView>
        <View style={styles.body}>
          <SectionLabel text="Search" />
          <ZipCodeRow zipcode={zipHydrated ? zipcode : ''} onSave={setZipcode} />
          <BudgetRow budget={weeklyBudget ?? undefined} onSave={setWeeklyBudget} />

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
          {searchHistory.length > 0 ? (
            <View style={styles.chipsRow}>
              {[...searchHistory].reverse().slice(0, 10).map((term, i) => (
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

          <SectionLabel text="Help" />
          <TouchableOpacity style={styles.restartOnboardingRow} onPress={() => resetOnboarding()}>
            <Ionicons name="refresh-outline" size={16} color={colors.green} />
            <Text style={styles.restartOnboardingText}>Reset Tips</Text>
          </TouchableOpacity>

          <Text style={styles.footerTagline}>ShopSmart — Compare grocery prices across 9 stores</Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function SectionLabel({ text }: { text: string }) {
  return <Text style={styles.sectionLabel}>{text.toUpperCase()}</Text>;
}

// ZIP code is the one thing search genuinely needs — this is the only
// place a shopper can set or change it by hand; searchStore.ts resolves
// it automatically (via location) the first time it's needed if nothing
// has been set here yet.
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
        <Text style={styles.infoValue}>{zipcode || 'Set automatically from your location on first search'}</Text>
        <Ionicons name="pencil" size={13} color={`${colors.charcoal}66`} />
      </View>
    </TouchableOpacity>
  );
}

// Optional and subtle by design — most shoppers never set one. The only
// place it's ever configured (see budgetService/advisorService for how
// it's used: a quiet Cart-screen warning when spending approaches or
// crosses it, never a dashboard).
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
  body: { padding: spacing.lg },
  sectionLabel: { fontSize: 11, fontWeight: '600', color: `${colors.charcoal}80`, letterSpacing: 0.6, marginBottom: spacing.md, marginTop: spacing.xl },
  infoCard: { backgroundColor: colors.panelBg, borderRadius: radius.lg, overflow: 'hidden' },
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
  restartOnboardingRow: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    backgroundColor: colors.panelBg, borderRadius: radius.lg,
    paddingHorizontal: spacing.lg, paddingVertical: spacing.md + 2, minHeight: 48,
  },
  restartOnboardingText: { color: colors.green, fontWeight: '600', fontSize: 13.5 },
  footerTagline: { textAlign: 'center', color: `${colors.charcoal}4d`, fontSize: 11, marginTop: spacing.xxl },
});

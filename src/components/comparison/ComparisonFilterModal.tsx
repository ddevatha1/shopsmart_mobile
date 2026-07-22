import React, { useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
  countActiveComparisonFilters,
  type AttributeFilterDef,
  type ComparisonFilters,
  type ComparisonSort,
} from '../../services/comparisonService';
import { colors } from '../../theme/colors';
import { typography } from '../../theme/typography';
import { radius, spacing } from '../../theme/metrics';
import { AccordionSection } from '../filters/AccordionSection';
import { ChipRow } from '../filters/ChipRow';
import { FilterFooter } from '../filters/FilterFooter';
import { AnimatedPressable } from '../AnimatedPressable';

/** How many dynamically-generated attribute facets show up front, above
 * the "More Filters" fold — the rest (typically Brand/Store and secondary
 * boolean facets) collapse into an accordion so the sheet stays short for
 * categories with a long attribute list, per "avoid long scrolling
 * sheets" / "expandable sections where appropriate." A category with few
 * facets never shows the fold at all. */
const ALWAYS_VISIBLE_ATTRIBUTE_COUNT = 3;

interface Props {
  visible: boolean;
  onClose: () => void;
  sortOptions: { value: ComparisonSort; label: string }[];
  sizeOptions: string[];
  attributeDefs: AttributeFilterDef[];
  filters: ComparisonFilters;
  onApply: (filters: ComparisonFilters) => void;
  onReset: () => void;
}

/**
 * The comparison screen's Filter & Sort sheet — a bottom sheet (not the
 * old full-page modal) so it reads as a quick refinement, not a new
 * screen. Every facet here — Sort By's options, Serving Size, and the
 * whole attribute list below it — is generated fresh per category by
 * filterSchemaService.buildFilterSchema from the group actually being
 * viewed; this component only renders whatever schema it's handed; it has
 * no category-specific knowledge of its own, which is what makes it
 * genuinely category-aware instead of one universal checkbox list carried
 * over from the pre-comparison version of the app.
 */
export function ComparisonFilterModal({ visible, onClose, ...panelProps }: Props) {
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      {visible && <ComparisonFilterSheet onClose={onClose} {...panelProps} />}
    </Modal>
  );
}

type SheetProps = Omit<Props, 'visible'>;

function ComparisonFilterSheet({
  onClose, sortOptions, sizeOptions, attributeDefs, filters, onApply, onReset,
}: SheetProps) {
  const [draft, setDraft] = useState(filters);
  const activeCount = useMemo(() => countActiveComparisonFilters(draft), [draft]);

  const setSort = (value: string) => setDraft((prev) => ({ ...prev, sort: value as ComparisonSort }));

  const toggleSize = (size: string) => {
    setDraft((prev) => {
      const next = new Set(prev.sizes);
      if (next.has(size)) next.delete(size);
      else next.add(size);
      return { ...prev, sizes: next };
    });
  };

  const toggleInStock = () => setDraft((prev) => ({ ...prev, inStockOnly: !prev.inStockOnly }));

  const toggleAttribute = (key: string, value: string) => {
    setDraft((prev) => {
      const current = prev.attributes[key] ?? new Set<string>();
      const next = new Set(current);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return { ...prev, attributes: { ...prev.attributes, [key]: next } };
    });
  };

  const handleClear = () => {
    onReset();
    onClose();
  };

  const handleApply = () => {
    onApply(draft);
    onClose();
  };

  const visibleAttributes = attributeDefs.slice(0, ALWAYS_VISIBLE_ATTRIBUTE_COUNT);
  const moreAttributes = attributeDefs.slice(ALWAYS_VISIBLE_ATTRIBUTE_COUNT);

  return (
    <View style={styles.overlay}>
      <Pressable style={[StyleSheet.absoluteFill, styles.backdrop]} onPress={onClose} />
      <View style={styles.sheet}>
        <View style={styles.grabberRow}>
          <View style={styles.grabber} />
        </View>
        <View style={styles.header}>
          <Text style={typography.h2}>Filter & Sort</Text>
          <AnimatedPressable
            onPress={onClose}
            style={styles.closeButton}
            scaleTo={0.9}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Ionicons name="close" size={20} color={colors.charcoal} />
          </AnimatedPressable>
        </View>

        <ScrollView style={styles.body} showsVerticalScrollIndicator={false} bounces={false}>
          <FilterGroup label="Sort By">
            <ChipRow
              options={sortOptions}
              selected={new Set([draft.sort])}
              onToggle={setSort}
            />
          </FilterGroup>

          {sizeOptions.length > 1 && (
            <FilterGroup label="Serving Size">
              <ChipRow options={sizeOptions.map((s) => ({ value: s, label: s }))} selected={draft.sizes} onToggle={toggleSize} />
            </FilterGroup>
          )}

          <FilterGroup label="Availability">
            <ChipRow
              options={[{ value: 'yes', label: 'In Stock Only' }]}
              selected={draft.inStockOnly ? new Set(['yes']) : new Set()}
              onToggle={toggleInStock}
            />
          </FilterGroup>

          {visibleAttributes.map((def) => (
            <FilterGroup key={def.key} label={def.label}>
              <ChipRow
                options={def.options}
                selected={draft.attributes[def.key] ?? new Set()}
                onToggle={(value) => toggleAttribute(def.key, value)}
              />
            </FilterGroup>
          ))}

          {moreAttributes.length > 0 && (
            <AccordionSection title="More Filters">
              <View style={{ gap: spacing.lg, paddingBottom: spacing.md }}>
                {moreAttributes.map((def) => (
                  <FilterGroup key={def.key} label={def.label} compact>
                    <ChipRow
                      options={def.options}
                      selected={draft.attributes[def.key] ?? new Set()}
                      onToggle={(value) => toggleAttribute(def.key, value)}
                    />
                  </FilterGroup>
                ))}
              </View>
            </AccordionSection>
          )}
        </ScrollView>

        <FilterFooter activeFilterCount={activeCount} onClear={handleClear} onApply={handleApply} />
      </View>
    </View>
  );
}

function FilterGroup({ label, children, compact }: { label: string; children: React.ReactNode; compact?: boolean }) {
  return (
    <View style={[styles.group, compact && styles.groupCompact]}>
      <Text style={styles.groupLabel}>{label}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { backgroundColor: 'rgba(0,0,0,0.35)' },
  sheet: {
    backgroundColor: colors.white,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    maxHeight: '82%',
    paddingBottom: spacing.md,
  },
  grabberRow: { alignItems: 'center', paddingTop: spacing.sm },
  grabber: { width: 36, height: 4, borderRadius: 2, backgroundColor: colors.borderGray },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
  },
  closeButton: { padding: spacing.xs },
  body: { paddingHorizontal: spacing.lg },
  group: { marginBottom: spacing.xl },
  groupCompact: { marginBottom: spacing.lg },
  groupLabel: { ...typography.overline, color: `${colors.charcoal}99`, marginBottom: spacing.sm },
});

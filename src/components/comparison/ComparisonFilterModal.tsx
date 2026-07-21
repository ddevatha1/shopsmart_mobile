import React, { useMemo, useState } from 'react';
import { Modal, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import {
  countActiveComparisonFilters,
  type ComparisonFilters,
  type ComparisonSort,
} from '../../services/comparisonService';
import { colors } from '../../theme/colors';
import { typography } from '../../theme/typography';
import { spacing } from '../../theme/metrics';
import { AccordionSection } from '../filters/AccordionSection';
import { RadioRow } from '../filters/RadioRow';
import { CheckboxRow } from '../filters/CheckboxRow';
import { FilterFooter } from '../filters/FilterFooter';
import { AnimatedPressable } from '../AnimatedPressable';

const SORT_OPTIONS: { value: ComparisonSort; label: string }[] = [
  { value: 'best_value', label: 'Best Value' },
  { value: 'lowest_total', label: 'Lowest Total Price' },
  { value: 'closest', label: 'Closest Store' },
  { value: 'organic_first', label: 'Organic First' },
];

interface Props {
  visible: boolean;
  onClose: () => void;
  availableSizes: string[];
  filters: ComparisonFilters;
  onApply: (filters: ComparisonFilters) => void;
  onReset: () => void;
}

/**
 * The comparison screen's own Filter & Sort panel — moved here from Stage 1
 * (SearchScreen), since sorting/filtering only makes sense once a shopper
 * has already picked a category to compare. Same low-level primitives as
 * the app's other filter panels (AccordionSection, RadioRow, CheckboxRow,
 * FilterFooter), just scoped to the 4 groups that matter here: Sort,
 * Availability, Package Size, Organic.
 */
export function ComparisonFilterModal({ visible, onClose, ...panelProps }: Props) {
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} presentationStyle="pageSheet">
      {visible && <ComparisonFilterPanel onClose={onClose} {...panelProps} />}
    </Modal>
  );
}

type PanelProps = Omit<Props, 'visible'>;

function ComparisonFilterPanel({ onClose, availableSizes, filters, onApply, onReset }: PanelProps) {
  const [draft, setDraft] = useState(filters);
  const activeCount = useMemo(() => countActiveComparisonFilters(draft), [draft]);

  const toggleSize = (size: string) => {
    setDraft((prev) => {
      const next = new Set(prev.sizes);
      if (next.has(size)) next.delete(size);
      else next.add(size);
      return { ...prev, sizes: next };
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

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <Text style={typography.h2}>Filter & Sort</Text>
        <AnimatedPressable
          onPress={onClose}
          style={styles.closeButton}
          scaleTo={0.9}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Ionicons name="close" size={22} color={colors.charcoal} />
        </AnimatedPressable>
      </View>

      <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
        <AccordionSection title="Sort By" defaultExpanded>
          {SORT_OPTIONS.map((opt) => (
            <RadioRow
              key={opt.value}
              label={opt.label}
              selected={draft.sort === opt.value}
              onPress={() => setDraft((prev) => ({ ...prev, sort: opt.value }))}
            />
          ))}
        </AccordionSection>

        <AccordionSection title="Availability">
          <CheckboxRow
            label="In Stock Only"
            selected={draft.inStockOnly}
            onPress={() => setDraft((prev) => ({ ...prev, inStockOnly: !prev.inStockOnly }))}
          />
        </AccordionSection>

        {availableSizes.length > 1 && (
          <AccordionSection title="Package Size">
            {availableSizes.map((size) => (
              <CheckboxRow
                key={size}
                label={size}
                selected={draft.sizes.has(size)}
                onPress={() => toggleSize(size)}
              />
            ))}
          </AccordionSection>
        )}

        <AccordionSection title="Organic">
          <CheckboxRow
            label="Organic Only"
            selected={draft.organicOnly}
            onPress={() => setDraft((prev) => ({ ...prev, organicOnly: !prev.organicOnly }))}
          />
        </AccordionSection>
      </ScrollView>

      <FilterFooter activeFilterCount={activeCount} onClear={handleClear} onApply={handleApply} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.white },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderGray,
  },
  closeButton: { padding: spacing.xs },
  body: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xl },
});

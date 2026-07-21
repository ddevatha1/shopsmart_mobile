import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { colors } from '../../theme/colors';
import { typography } from '../../theme/typography';
import { spacing } from '../../theme/metrics';
import { fadeIn } from '../../theme/motion';

interface Props {
  title: string;
  defaultExpanded?: boolean;
  children: React.ReactNode;
}

/** Generic collapsible section used by every group in the Filter & Sort
 * panel. Animates to a measured content height (not `LayoutAnimation`,
 * which is flaky on Android/Fabric) — matches the reanimated convention
 * already used for entrance animations elsewhere in the app. */
export function AccordionSection({ title, defaultExpanded = false, children }: Props) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [contentHeight, setContentHeight] = useState(0);
  const progress = useSharedValue(defaultExpanded ? 1 : 0);

  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    progress.value = withTiming(next ? 1 : 0, fadeIn());
  };

  const bodyStyle = useAnimatedStyle(() => ({
    height: progress.value * contentHeight,
    opacity: progress.value,
  }));
  const chevronStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${progress.value * 180}deg` }],
  }));

  return (
    <View style={styles.section}>
      <Pressable onPress={toggle} style={({ pressed }) => [styles.header, pressed && styles.headerPressed]}>
        <Text style={styles.title}>{title}</Text>
        <Animated.View style={chevronStyle}>
          <Ionicons name="chevron-down" size={18} color={`${colors.charcoal}99`} />
        </Animated.View>
      </Pressable>

      <Animated.View style={[styles.body, bodyStyle]}>
        <View
          style={contentHeight === 0 ? styles.measureAbsolute : undefined}
          onLayout={(e) => {
            const h = e.nativeEvent.layout.height;
            if (h > 0 && h !== contentHeight) setContentHeight(h);
          }}
        >
          {children}
        </View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    borderBottomWidth: 1,
    borderBottomColor: colors.borderGray,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.lg,
  },
  headerPressed: {
    opacity: 0.6,
  },
  title: { ...typography.h3 },
  body: {
    overflow: 'hidden',
  },
  // First measurement pass: render off-flow so we can read natural height
  // without a visible layout jump, before the collapsed height is known.
  measureAbsolute: {
    position: 'absolute',
    left: 0,
    right: 0,
  },
});

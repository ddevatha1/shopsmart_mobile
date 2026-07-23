import React, { useRef, useState } from 'react';
import {
  FlatList,
  NativeScrollEvent,
  NativeSyntheticEvent,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { AnimatedPressable } from '../components/AnimatedPressable';
import { colors } from '../theme/colors';
import { typography } from '../theme/typography';
import { radius, spacing } from '../theme/metrics';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'Onboarding'>;

interface Slide {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  body: string;
}

// One slide per real feature in the app (see SearchScreen, CompareScreen,
// CartScreen, RouteScreen, advisorService) — every sentence here describes
// something the app actually does, in the order a shopper actually
// encounters it, not a marketing pitch. Plain, literal wording throughout:
// no metaphors, no "magic," nothing a shopper has to decode.
const SLIDES: Slide[] = [
  {
    icon: 'search-outline',
    title: 'Search once, see four stores',
    body: "Type in any grocery item and get prices from Trader Joe's, Sprouts, Kroger, and Aldi at the same time, in one search.",
  },
  {
    icon: 'pricetag-outline',
    title: 'The best price, right away',
    body: 'Every item shows its best value first. Open it to see every store’s price for that same item, side by side, before you decide.',
  },
  {
    icon: 'bag-handle-outline',
    title: 'One cart for every store',
    body: 'Add items from any store to a single cart. Each item keeps track of which store it comes from and what it costs there.',
  },
  {
    icon: 'navigate-outline',
    title: 'One route for your whole trip',
    body: 'When you’re ready to shop, get a route that covers every store on your list, in order, with a checklist for what to buy at each stop.',
  },
  {
    icon: 'bulb-outline',
    title: 'Helpful tips as you shop',
    body: 'The app points out useful things while you search and shop, like an item you may be running low on or a nearby store worth adding to your trip.',
  },
];

/**
 * First-launch feature walkthrough for signed-out users, shown right after
 * Splash and before Welcome (see AppNavigator/SplashScreen) — Welcome
 * already carries the branding + sign-up/log-in choice, so this screen's
 * only job is explaining what the app does, one real feature per slide, so
 * a shopper knows what they're signing up for before being asked to.
 */
export function OnboardingScreen({ navigation }: Props) {
  const { width } = useWindowDimensions();
  const [index, setIndex] = useState(0);
  const listRef = useRef<FlatList<Slide>>(null);
  const isLast = index === SLIDES.length - 1;

  function goToWelcome() {
    navigation.replace('Welcome');
  }

  function goNext() {
    if (isLast) {
      goToWelcome();
      return;
    }
    const nextIndex = index + 1;
    // Set eagerly rather than waiting on onMomentumScrollEnd — react-native-web
    // doesn't reliably fire that event for a programmatic scrollToOffset, which
    // left `index` (and so the dots + isLast/"Get Started") permanently stuck
    // after the first tap on web. Native swipe gestures still update `index`
    // via onMomentumScrollEnd below; this just keeps the button-driven path
    // from depending on it too.
    setIndex(nextIndex);
    listRef.current?.scrollToOffset({ offset: nextIndex * width, animated: true });
  }

  function onMomentumScrollEnd(e: NativeSyntheticEvent<NativeScrollEvent>) {
    const nextIndex = Math.round(e.nativeEvent.contentOffset.x / width);
    setIndex(nextIndex);
  }

  return (
    <View style={{ flex: 1 }}>
      <LinearGradient colors={[colors.mint, colors.white]} style={StyleSheet.absoluteFill} />
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.header}>
          <TouchableOpacity
            onPress={goToWelcome}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            disabled={isLast}
          >
            <Text style={[styles.skipText, isLast && styles.skipTextHidden]}>Skip</Text>
          </TouchableOpacity>
        </View>

        <FlatList
          ref={listRef}
          data={SLIDES}
          keyExtractor={(s) => s.title}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          bounces={false}
          onMomentumScrollEnd={onMomentumScrollEnd}
          renderItem={({ item }) => (
            <View style={[styles.slide, { width }]}>
              <View style={styles.iconCircle}>
                <Ionicons name={item.icon} size={40} color={colors.green} />
              </View>
              <Text style={styles.title}>{item.title}</Text>
              <Text style={styles.body}>{item.body}</Text>
            </View>
          )}
        />

        <View style={styles.footer}>
          <View style={styles.dots}>
            {SLIDES.map((s, i) => (
              <View key={s.title} style={[styles.dot, i === index && styles.dotActive]} />
            ))}
          </View>
          <AnimatedPressable style={styles.nextButton} onPress={goNext}>
            <Text style={styles.nextButtonText}>{isLast ? 'Get Started' : 'Next'}</Text>
          </AnimatedPressable>
        </View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  header: { flexDirection: 'row', justifyContent: 'flex-end', paddingHorizontal: spacing.xl, paddingTop: spacing.md },
  skipText: { ...typography.bodyMedium, color: `${colors.charcoal}80` },
  skipTextHidden: { opacity: 0 },
  slide: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.xxl },
  iconCircle: {
    width: 96, height: 96, borderRadius: 48, backgroundColor: colors.mint,
    alignItems: 'center', justifyContent: 'center', marginBottom: spacing.xxl,
    borderWidth: 1, borderColor: colors.mintDark,
  },
  title: { ...typography.h1, fontSize: 24, lineHeight: 30, textAlign: 'center' },
  body: {
    ...typography.body, color: `${colors.charcoal}99`, textAlign: 'center',
    marginTop: spacing.md, maxWidth: 320,
  },
  footer: { paddingHorizontal: spacing.xl, paddingBottom: spacing.lg, gap: spacing.xl },
  dots: { flexDirection: 'row', justifyContent: 'center', gap: spacing.sm },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.mintDark },
  dotActive: { width: 20, backgroundColor: colors.green },
  nextButton: {
    backgroundColor: colors.green, borderRadius: radius.md, paddingVertical: 16,
    alignItems: 'center',
  },
  nextButtonText: { ...typography.button, color: colors.white, fontSize: 15.5 },
});

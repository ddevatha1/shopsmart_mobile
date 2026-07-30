import React, { useEffect, useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { NavigationContainer, type Theme, DefaultTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Ionicons } from '@expo/vector-icons';
import Animated, { useAnimatedStyle, useSharedValue, withSequence, withTiming } from 'react-native-reanimated';
import { HomeScreen } from '../screens/HomeScreen';
import { SearchScreen } from '../screens/SearchScreen';
import { SearchResultsScreen } from '../screens/SearchResultsScreen';
import { CartScreen } from '../screens/CartScreen';
import { ProfileScreen } from '../screens/ProfileScreen';
import { CompareScreen } from '../screens/CompareScreen';
import { ProductDetailScreen } from '../screens/ProductDetailScreen';
import { RouteScreen } from '../screens/RouteScreen';
import { PlannerScreen } from '../screens/PlannerScreen';
import { MealPlannerScreen } from '../screens/MealPlannerScreen';
import { SavingsScreen } from '../screens/SavingsScreen';
import { AssistantScreen } from '../screens/AssistantScreen';
import { AuthScreen } from '../screens/AuthScreen';
import { SplashScreen } from '../screens/SplashScreen';
import { ProductQualityScreen } from '../screens/ProductQualityScreen';
import { OnboardingScreen } from '../screens/OnboardingScreen';
import { cartItemCount, useCartStore } from '../store/cartStore';
import { colors } from '../theme/colors';
import { duration, easing } from '../theme/motion';
import { webContentMaxWidth } from '../theme/metrics';
import type { RootStackParamList, TabParamList } from './types';

const Tab = createBottomTabNavigator<TabParamList>();
const Stack = createNativeStackNavigator<RootStackParamList>();

const navTheme: Theme = {
  ...DefaultTheme,
  colors: { ...DefaultTheme.colors, primary: colors.green, background: colors.white },
};

/** Bottom tabs (Home/Cart/Profile) — mirrors the web's persistent header
 * icons + slide-over drawers, converted to primary mobile navigation
 * destinations per the instructions ("Desktop sidebar → Bottom navigation").
 * `Home` (renamed from `Search` in the Navigation Redesign) is now the
 * hub/command-center tab — search itself moved to its own root-stack
 * screens (`Search`/`SearchResults`, registered below) so a search no
 * longer replaces this tab's content in place. */
function Tabs() {
  const count = useCartStore((s) => cartItemCount(s.items));

  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.green,
        tabBarInactiveTintColor: `${colors.charcoal}80`,
      }}
    >
      <Tab.Screen
        name="Home"
        component={HomeScreen}
        options={{ tabBarIcon: ({ color, size }) => <Ionicons name="home-outline" size={size} color={color} /> }}
      />
      <Tab.Screen
        name="Cart"
        component={CartScreen}
        options={{
          tabBarIcon: ({ color, size }) => <CartTabIcon color={color} size={size} count={count} />,
        }}
      />
      <Tab.Screen
        name="Profile"
        component={ProfileScreen}
        options={{ tabBarIcon: ({ color, size }) => <Ionicons name="person-outline" size={size} color={color} /> }}
      />
    </Tab.Navigator>
  );
}

/** A small bump (scale up, spring back) whenever the item count *grows* —
 * skipped on the initial mount and on decreases, so it only fires for the
 * moment that matters: "something was just added." */
function CartTabIcon({ color, size, count }: { color: string; size: number; count: number }) {
  const scale = useSharedValue(1);
  const prevCount = useRef(count);

  useEffect(() => {
    if (count > prevCount.current) {
      scale.value = withSequence(
        withTiming(1.3, { duration: duration.micro, easing: easing.standard }),
        withTiming(1, { duration: duration.base, easing: easing.standard }),
      );
    }
    prevCount.current = count;
  }, [count, scale]);

  const badgeStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  return (
    <View>
      <Ionicons name="cart-outline" size={size} color={color} />
      {count > 0 && (
        <Animated.View style={[tabIconStyles.badge, badgeStyle]}>
          <Text style={tabIconStyles.badgeText}>{count}</Text>
        </Animated.View>
      )}
    </View>
  );
}

const tabIconStyles = StyleSheet.create({
  badge: {
    position: 'absolute',
    top: -4,
    right: -8,
    backgroundColor: colors.green,
    borderRadius: 8,
    minWidth: 16,
    height: 16,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 3,
  },
  badgeText: { color: colors.white, fontSize: 9, fontWeight: '700' },
});

export function AppNavigator() {
  return (
    <NavigationContainer theme={navTheme}>
      <Stack.Navigator
        initialRouteName="Splash"
        screenOptions={{
          headerShown: false,
          contentStyle: { width: '100%', maxWidth: webContentMaxWidth, alignSelf: 'center' },
        }}
      >
        <Stack.Screen name="Splash" component={SplashScreen} options={{ animation: 'none' }} />
        <Stack.Screen name="Onboarding" component={OnboardingScreen} options={{ animation: 'fade' }} />
        <Stack.Screen name="Tabs" component={Tabs} options={{ animation: 'fade' }} />
        <Stack.Screen name="Compare" component={CompareScreen} options={{ headerShown: false }} />
        <Stack.Screen name="ProductDetail" component={ProductDetailScreen} options={{ headerShown: false }} />
        <Stack.Screen name="Route" component={RouteScreen} options={{ headerShown: false }} />
        <Stack.Screen name="Planner" component={PlannerScreen} options={{ headerShown: false }} />
        <Stack.Screen name="MealPlanner" component={MealPlannerScreen} options={{ headerShown: false }} />
        <Stack.Screen name="Savings" component={SavingsScreen} options={{ headerShown: false }} />
        <Stack.Screen name="Assistant" component={AssistantScreen} options={{ headerShown: false }} />
        <Stack.Screen name="Auth" component={AuthScreen} options={{ presentation: 'fullScreenModal' }} />
        <Stack.Screen name="ProductQuality" component={ProductQualityScreen} options={{ presentation: 'fullScreenModal' }} />
        <Stack.Screen name="Search" component={SearchScreen} options={{ headerShown: false }} />
        <Stack.Screen name="SearchResults" component={SearchResultsScreen} options={{ headerShown: false }} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}

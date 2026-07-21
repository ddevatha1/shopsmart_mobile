import { Easing, type WithSpringConfig, type WithTimingConfig } from 'react-native-reanimated';

/**
 * Central motion vocabulary for the whole app — durations, easing curves,
 * and spring configs every animated component should pull from instead of
 * inventing its own numbers. The goal is a single, consistent feel (quick,
 * physical, never sluggish) rather than a different rhythm per screen.
 *
 * Three tiers of duration, same idea as the existing spacing/radius scales
 * in metrics.ts:
 *  - micro:   press/toggle feedback — should feel instant
 *  - base:    most fades/reveals — the default for "something appeared"
 *  - slow:    larger surface transitions (splash, page-level reveals)
 */
export const duration = {
  micro: 120,
  base: 240,
  slow: 420,
};

/** Standard "ease out" for anything entering/appearing — quick start,
 * gentle settle. Matches the curve already used across Splash/Welcome. */
export const easing = {
  standard: Easing.out(Easing.cubic),
  emphasized: Easing.out(Easing.back(1.15)),
};

/** A soft, physical settle — used for release/bounce-back feedback instead
 * of a fixed-duration timing curve, so it feels tactile rather than
 * mechanical. Tuned low-bounce on purpose: "premium," not "bouncy toy." */
export const spring: WithSpringConfig = {
  damping: 16,
  stiffness: 220,
  mass: 0.5,
};

export const fadeIn = (ms: number = duration.base): WithTimingConfig => ({
  duration: ms,
  easing: easing.standard,
});

/** Per-item delay for staggered list/grid entrances — capped so a long
 * list doesn't take forever to finish revealing itself. */
export function staggerDelay(index: number, step = 45, cap = 8): number {
  return Math.min(index, cap) * step;
}

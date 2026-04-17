// Motion presets per docs/design.md §1.4.
// Values are `as const` so downstream code gets literal types.

import { ReduceMotion, type WithSpringConfig } from 'react-native-reanimated';

export const SPRING_SOFT = {
  damping: 20,
  stiffness: 180,
  mass: 1,
} as const satisfies WithSpringConfig;

export const SPRING_SNAPPY = {
  damping: 18,
  stiffness: 260,
  mass: 1,
} as const satisfies WithSpringConfig;

export const SPRING_BOUNCY = {
  damping: 12,
  stiffness: 220,
  mass: 1,
} as const satisfies WithSpringConfig;

// Augments a Reanimated animation config with `reduceMotion: Always` when the caller's
// `useReducedMotion()` value is true. Reanimated 4 collapses animations configured with
// `ReduceMotion.Always` into an instant update — that satisfies the docs/design.md §1.4
// "Reduced motion" rule of replacing springs with a no-op.
export function withReducedMotion<C extends { reduceMotion?: ReduceMotion }>(
  config: C,
  reduced: boolean,
): C {
  return reduced ? { ...config, reduceMotion: ReduceMotion.Always } : config;
}

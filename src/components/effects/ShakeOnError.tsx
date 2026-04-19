import { forwardRef, useCallback, useImperativeHandle, type ReactNode } from 'react';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { useReducedMotion } from '@/design/useReducedMotion';

// Row-level shake wrapper per docs/design.md §5.3 (rejected submission status
// change): "one shake gesture made of 3 oscillation cycles (±4px each, 120ms
// per half-cycle, ~720ms total)". The rejection is blameless so the haptic is
// Warning (not Error). Reduced-motion collapses to a haptic-only call — same
// axis-separation rule as CelebrationBurst.
//
// Imperative ref instead of a prop-driven re-trigger because the parent
// list owns the realtime handler and needs to drive the animation on the
// exact row that just flipped; a prop-counter per row would force the
// parent to thread indexed state through every item.

export type ShakeOnErrorHandle = {
  shake: () => void;
};

export type ShakeOnErrorProps = {
  children: ReactNode;
};

export const ShakeOnError = forwardRef<ShakeOnErrorHandle, ShakeOnErrorProps>(function ShakeOnError(
  { children },
  ref,
) {
  const translateX = useSharedValue(0);
  const reduced = useReducedMotion();

  const shake = useCallback(() => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
    if (reduced) return;
    // 6 half-cycles × 120ms = 720ms. Pattern: 0 → +4 → -4 → +4 → -4 → +4 → 0.
    // Each withTiming in withSequence is a half-cycle that crosses the
    // centerline; the final segment settles back to zero.
    translateX.value = withSequence(
      withTiming(4, { duration: 120 }),
      withTiming(-4, { duration: 120 }),
      withTiming(4, { duration: 120 }),
      withTiming(-4, { duration: 120 }),
      withTiming(4, { duration: 120 }),
      withTiming(0, { duration: 120 }),
    );
  }, [reduced, translateX]);

  useImperativeHandle(ref, () => ({ shake }), [shake]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  return <Animated.View style={animatedStyle}>{children}</Animated.View>;
});

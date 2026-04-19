import { forwardRef, useCallback, useImperativeHandle } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { colors } from '@/design/tokens';
import { useReducedMotion } from '@/design/useReducedMotion';

// Confetti-lite per docs/design.md §5.3 (approved submission status change):
// "8 small 6×6 squares burst upward, fade over 800ms."
//
// Mounted once at screen root as a pointer-events-none overlay. `burst()` via
// the imperative ref fires a success haptic and drives a single `progress`
// shared value from 0→1 over 800ms; every particle reads the same value and
// translates/scales/fades accordingly. Reduced-motion collapses to a haptic-
// only call (no visual) per design.md §1.4 — haptics are a separate a11y axis
// from reduce-motion and match the existing Button / Toast posture (fire
// regardless). Anchor-ref API from design.md §7 component inventory is
// intentionally deferred; screen-level overlay at a fixed top-center origin
// is sufficient for the §5.3 celebration moment and avoids layout-measure
// races on list rows that might unmount mid-animation.

export type CelebrationBurstHandle = {
  burst: () => void;
};

type ParticleSpec = {
  dx: number;
  dy: number;
  rotate: number;
  color: string;
};

// Upward-fan spread. dx/dy are the final translate offsets at progress=1; a
// quadratic term adds a subtle gravity arc so particles don't look like a
// hard vector explosion. Colors rotate through the neubrutalist accent
// palette (cta/primary/success/ink) — all already on the canvas, no token
// additions needed.
const PARTICLES: readonly ParticleSpec[] = [
  { dx: -78, dy: -92, rotate: 48, color: colors.cta },
  { dx: -48, dy: -118, rotate: -36, color: colors.primary },
  { dx: -18, dy: -132, rotate: 14, color: colors.success },
  { dx: 10, dy: -138, rotate: -52, color: colors.ink },
  { dx: 38, dy: -128, rotate: 62, color: colors.cta },
  { dx: 64, dy: -108, rotate: -20, color: colors.primary },
  { dx: 86, dy: -80, rotate: 74, color: colors.success },
  { dx: 58, dy: -54, rotate: 28, color: colors.ink },
];

export const CelebrationBurst = forwardRef<CelebrationBurstHandle, object>(function CelebrationBurst(
  _props,
  ref,
) {
  const progress = useSharedValue(0);
  const opacity = useSharedValue(0);
  const reduced = useReducedMotion();

  const burst = useCallback(() => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    if (reduced) return;
    progress.value = 0;
    opacity.value = 1;
    progress.value = withTiming(1, { duration: 800, easing: Easing.out(Easing.quad) });
    opacity.value = withTiming(0, { duration: 800, easing: Easing.in(Easing.quad) });
  }, [opacity, progress, reduced]);

  useImperativeHandle(ref, () => ({ burst }), [burst]);

  return (
    <View
      pointerEvents="none"
      style={StyleSheet.absoluteFill}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <View style={styles.origin}>
        {PARTICLES.map((p, i) => (
          <Particle
            key={i}
            progress={progress}
            opacity={opacity}
            dx={p.dx}
            dy={p.dy}
            rotate={p.rotate}
            color={p.color}
          />
        ))}
      </View>
    </View>
  );
});

type ParticleProps = {
  progress: SharedValue<number>;
  opacity: SharedValue<number>;
  dx: number;
  dy: number;
  rotate: number;
  color: string;
};

function Particle({ progress, opacity, dx, dy, rotate, color }: ParticleProps) {
  const style = useAnimatedStyle(() => {
    const p = progress.value;
    return {
      opacity: opacity.value,
      transform: [
        { translateX: p * dx },
        { translateY: p * dy + p * p * 36 },
        { rotate: `${p * rotate}deg` },
      ],
    };
  });
  return <Animated.View style={[styles.particle, { backgroundColor: color }, style]} />;
}

const styles = StyleSheet.create({
  origin: {
    position: 'absolute',
    left: '50%',
    top: 140,
    width: 0,
    height: 0,
  },
  particle: {
    position: 'absolute',
    width: 6,
    height: 6,
    marginLeft: -3,
    marginTop: -3,
    borderWidth: 1,
    borderColor: colors.ink,
  },
});

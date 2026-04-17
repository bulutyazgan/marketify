import { useEffect } from 'react';
import {
  type LayoutChangeEvent,
  type StyleProp,
  StyleSheet,
  View,
  type ViewStyle,
} from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { colors, radii, shadows } from '@/design/tokens';
import { useReducedMotion } from '@/design/useReducedMotion';

export type SkeletonCardShape = 'card' | 'line';

export type SkeletonCardProps = {
  height?: number;
  shape?: SkeletonCardShape;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

// Loading placeholder per docs/design.md §5.1 ("Loading (3 skeleton cards)") +
// §6 inventory. Shimmer is a translated surface-colored band animated across the
// skeleton's width on a repeating worklet. Reduced-motion short-circuits: the
// placeholder renders with its neutral hairline bg and no moving band.
//
// Width is held in a shared value (not React state) so the worklet always reads
// the current layout width without a re-render cycle — avoids a stale-capture
// flicker on the first layout pass.
export function SkeletonCard({
  height = 140,
  shape = 'card',
  style,
  testID,
}: SkeletonCardProps) {
  const reduced = useReducedMotion();
  const progress = useSharedValue(0);
  const width = useSharedValue(0);

  useEffect(() => {
    if (reduced) return;
    progress.value = 0;
    progress.value = withRepeat(
      withTiming(1, { duration: 1200, easing: Easing.inOut(Easing.quad) }),
      -1,
      false,
    );
    return () => {
      cancelAnimation(progress);
    };
  }, [reduced, progress]);

  const animatedStyle = useAnimatedStyle(() => {
    const w = width.value;
    if (w === 0) return { opacity: 0 };
    const bandWidth = Math.max(80, w * 0.4);
    const start = -bandWidth;
    const end = w;
    return {
      width: bandWidth,
      opacity: 1,
      transform: [{ translateX: start + (end - start) * progress.value }],
    };
  });

  const handleLayout = (event: LayoutChangeEvent) => {
    width.value = event.nativeEvent.layout.width;
  };

  const outerStyle =
    shape === 'card' ? [styles.card, shadows.hard, { height }] : [styles.line, { height }];

  return (
    <View
      style={[outerStyle, style]}
      onLayout={handleLayout}
      testID={testID}
      accessible
      accessibilityLabel="Loading"
      accessibilityState={{ busy: true }}
    >
      {reduced ? null : (
        <Animated.View pointerEvents="none" style={[styles.shimmer, animatedStyle]} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.hairline,
    borderRadius: radii.card,
    borderWidth: 2,
    borderColor: colors.ink,
    overflow: 'hidden',
  },
  line: {
    backgroundColor: colors.hairline,
    borderRadius: radii.image,
    overflow: 'hidden',
  },
  shimmer: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    backgroundColor: colors.surface,
    opacity: 0.6,
  },
});

import { useEffect, useMemo } from 'react';
import {
  Modal,
  Pressable,
  type StyleProp,
  StyleSheet,
  useWindowDimensions,
  View,
  type ViewStyle,
} from 'react-native';
import {
  Gesture,
  GestureDetector,
  GestureHandlerRootView,
} from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
  type WithSpringConfig,
} from 'react-native-reanimated';
import { colors, radii, shadows, spacing } from '@/design/tokens';
import { SPRING_SNAPPY, withReducedMotion } from '@/design/motion';
import { useReducedMotion } from '@/design/useReducedMotion';

// Modal bottom sheet per docs/design.md §3.3 ("Bottom sheet (80% height)") +
// §6 inventory (children, snapPoints). Slides up on open with SPRING_SNAPPY per
// §1.4 line 99. Drag-to-dismiss via react-native-gesture-handler PanGesture:
// snap to the nearest provided snap point, or dismiss when pulled past the
// lowest snap + threshold or flung downward.
//
// snapPoints are fractions of screen height. The FIRST entry is the initial
// (and largest) snap — sheet height is set from it. Additional smaller entries
// create peek positions the user can drag to.
const DISMISS_VELOCITY = 600; // px/s — fling-dismiss threshold
const DISMISS_DRAG_OVERSHOOT = 0.25; // extra drag past lowest snap before dismissing (as fraction of sheetHeight)

export type BottomSheetProps = {
  visible: boolean;
  onDismiss: () => void;
  children: React.ReactNode;
  snapPoints?: readonly number[];
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
  testID?: string;
};

export function BottomSheet({
  visible,
  onDismiss,
  children,
  snapPoints = [0.8],
  style,
  accessibilityLabel,
  testID,
}: BottomSheetProps) {
  const reduced = useReducedMotion();
  const { height: screenHeight } = useWindowDimensions();

  const { sheetHeight, snapOffsets } = useMemo(() => {
    const sorted = [...snapPoints]
      .map((p) => clamp(p, 0.2, 0.95))
      .sort((a, b) => b - a);
    const primary = sorted[0] ?? 0.8;
    const h = screenHeight * primary;
    // snapOffsets[0] is always 0 (fully shown at primary snap). Subsequent
    // entries are positive translateY offsets sliding the sheet down for peeks.
    const offsets = sorted.map((p) => h * (1 - p / primary));
    return { sheetHeight: h, snapOffsets: offsets };
  }, [snapPoints, screenHeight]);

  const translateY = useSharedValue(sheetHeight);
  const backdropOpacity = useSharedValue(0);
  const gestureStart = useSharedValue(0);

  useEffect(() => {
    if (visible) {
      translateY.value = withSpring(0, withReducedMotion<WithSpringConfig>(SPRING_SNAPPY, reduced));
      backdropOpacity.value = withTiming(1, { duration: reduced ? 0 : 180 });
    } else {
      translateY.value = withSpring(
        sheetHeight,
        withReducedMotion<WithSpringConfig>(SPRING_SNAPPY, reduced),
      );
      backdropOpacity.value = withTiming(0, { duration: reduced ? 0 : 160 });
    }
  }, [visible, reduced, sheetHeight, translateY, backdropOpacity]);

  // Keep the offscreen parking spot in sync with sheetHeight when hidden, so a
  // rotation-driven height change while closed doesn't leave the sheet peeking.
  useEffect(() => {
    if (!visible) {
      translateY.value = sheetHeight;
    }
  }, [visible, sheetHeight, translateY]);

  const pan = useMemo(
    () =>
      Gesture.Pan()
        .onStart(() => {
          gestureStart.value = translateY.value;
        })
        .onUpdate((e) => {
          translateY.value = Math.max(0, gestureStart.value + e.translationY);
        })
        .onEnd((e) => {
          const final = translateY.value;
          const largestOffset = snapOffsets[snapOffsets.length - 1] ?? 0;
          const shouldDismiss =
            final > largestOffset + sheetHeight * DISMISS_DRAG_OVERSHOOT ||
            e.velocityY > DISMISS_VELOCITY;
          if (shouldDismiss) {
            runOnJS(onDismiss)();
            return;
          }
          let nearest = snapOffsets[0] ?? 0;
          let bestDist = Math.abs(final - nearest);
          for (const o of snapOffsets) {
            const d = Math.abs(final - o);
            if (d < bestDist) {
              bestDist = d;
              nearest = o;
            }
          }
          translateY.value = withSpring(
            nearest,
            withReducedMotion<WithSpringConfig>(SPRING_SNAPPY, reduced),
          );
        }),
    [gestureStart, translateY, snapOffsets, sheetHeight, reduced, onDismiss],
  );

  const sheetAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
  }));

  const backdropAnimatedStyle = useAnimatedStyle(() => ({
    opacity: backdropOpacity.value * 0.45,
  }));

  return (
    <Modal
      visible={visible}
      transparent
      onRequestClose={onDismiss}
      animationType="none"
      statusBarTranslucent
      testID={testID}
    >
      {/* New GestureHandlerRootView inside Modal — on Android, Modal opens a new
          window that does not inherit the root handler from app/_layout.tsx. */}
      <GestureHandlerRootView style={styles.root}>
        <Animated.View
          pointerEvents="box-none"
          style={[styles.backdrop, backdropAnimatedStyle]}
        >
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={onDismiss}
            accessible={false}
            importantForAccessibility="no"
          />
        </Animated.View>
        <GestureDetector gesture={pan}>
          <Animated.View
            style={[styles.sheet, { height: sheetHeight }, shadows.hard, sheetAnimatedStyle, style]}
            accessibilityViewIsModal
            accessibilityLabel={accessibilityLabel}
          >
            <View style={styles.handle} />
            <View style={styles.content}>{children}</View>
          </Animated.View>
        </GestureDetector>
      </GestureHandlerRootView>
    </Modal>
  );
}

function clamp(v: number, min: number, max: number) {
  return Math.min(max, Math.max(min, v));
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colors.ink,
  },
  sheet: {
    backgroundColor: colors.canvas,
    borderTopLeftRadius: radii.card,
    borderTopRightRadius: radii.card,
    borderWidth: 2,
    borderBottomWidth: 0,
    borderColor: colors.ink,
    paddingTop: spacing.sm,
  },
  handle: {
    alignSelf: 'center',
    width: 48,
    height: 4,
    borderRadius: radii.pill,
    backgroundColor: colors.ink40,
    marginBottom: spacing.sm,
  },
  content: {
    flex: 1,
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.xxl + spacing.base, // covers iOS home-indicator area
  },
});

import { useCallback } from 'react';
import { Pressable, type PressableProps, StyleSheet } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  type WithSpringConfig,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { Plus } from 'lucide-react-native';
import { colors, shadows } from '@/design/tokens';
import { SPRING_SOFT, withReducedMotion } from '@/design/motion';
import { useReducedMotion } from '@/design/useReducedMotion';

// Floating action button — docs/design.md §3.2 ("cta color, hard shadow, 56px")
// + §1.5 universal press-collapse via shadowOpacity / translate (same pattern as
// Button). Routes via the onPress callback; callers decide where it leads.
export type FabProps = {
  onPress: PressableProps['onPress'];
  accessibilityLabel: string;
  testID?: string;
};

export function Fab({ onPress, accessibilityLabel, testID }: FabProps) {
  const reduced = useReducedMotion();
  const pressed = useSharedValue(0);

  const animatedStyle = useAnimatedStyle(() => {
    const v = pressed.value;
    return {
      transform: [
        { translateX: v * 3 },
        { translateY: v * 3 },
        { scale: 1 - v * 0.03 },
      ],
      shadowOpacity: 1 - v,
    };
  });

  const handlePressIn = useCallback(() => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    pressed.value = withSpring(1, withReducedMotion<WithSpringConfig>(SPRING_SOFT, reduced));
  }, [pressed, reduced]);

  const handlePressOut = useCallback(() => {
    pressed.value = withSpring(0, withReducedMotion<WithSpringConfig>(SPRING_SOFT, reduced));
  }, [pressed, reduced]);

  return (
    <Pressable
      onPress={onPress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      testID={testID}
      style={styles.pressable}
    >
      <Animated.View style={[styles.fab, shadows.hard, animatedStyle]}>
        <Plus size={28} color={colors.ink} strokeWidth={2.5} />
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pressable: {
    position: 'absolute',
    right: 20,
    bottom: 20,
  },
  fab: {
    width: 56,
    height: 56,
    borderRadius: 28,
    borderWidth: 2,
    borderColor: colors.ink,
    backgroundColor: colors.cta,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

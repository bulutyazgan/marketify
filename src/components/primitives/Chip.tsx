import { useCallback } from 'react';
import {
  Pressable,
  type PressableProps,
  type StyleProp,
  StyleSheet,
  Text,
  type ViewStyle,
} from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  type WithSpringConfig,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { colors, radii, shadows, spacing } from '@/design/tokens';
import { SPRING_SOFT, withReducedMotion } from '@/design/motion';
import { useReducedMotion } from '@/design/useReducedMotion';
import { textStyles } from '@/design/typography';

export type ChipProps = {
  label: string;
  active?: boolean;
  onPress?: PressableProps['onPress'];
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
  testID?: string;
};

// Filter chip per docs/design.md §5.1 (horizontal chip row) + §1.2 (primarySoft bg
// when selected). Press = spring.soft scale-to-0.97 per §1.4 line 100; haptic uses
// `selectionAsync` since toggling is a discrete selection change, not an impact.
export function Chip({
  label,
  active = false,
  onPress,
  disabled = false,
  style,
  accessibilityLabel,
  testID,
}: ChipProps) {
  const reduced = useReducedMotion();
  const pressed = useSharedValue(0);
  const interactive = !disabled && !!onPress;

  // Shadow collapses on press by fading shadowOpacity to 0 while the chip
  // translates (3,3) — same compound-prop workaround the Button primitive uses
  // since iOS `shadowOffset` is not animatable through `useAnimatedStyle`.
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
    if (!interactive) return;
    void Haptics.selectionAsync();
    pressed.value = withSpring(1, withReducedMotion<WithSpringConfig>(SPRING_SOFT, reduced));
  }, [interactive, pressed, reduced]);

  const handlePressOut = useCallback(() => {
    if (!interactive) return;
    pressed.value = withSpring(0, withReducedMotion<WithSpringConfig>(SPRING_SOFT, reduced));
  }, [interactive, pressed, reduced]);

  const bg = disabled ? colors.hairline : active ? colors.primarySoft : colors.surface;
  const borderColor = disabled ? colors.ink40 : colors.ink;
  const textColor = disabled ? colors.ink40 : active ? colors.primaryDeep : colors.ink;

  return (
    <Pressable
      onPress={interactive ? onPress : undefined}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      disabled={!interactive}
      accessibilityRole="checkbox"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ checked: active, disabled: !interactive }}
      testID={testID}
    >
      <Animated.View
        style={[
          styles.base,
          { backgroundColor: bg, borderColor },
          disabled ? shadows.none : shadows.hard,
          animatedStyle,
          style,
        ]}
      >
        <Text style={[textStyles.micro, { color: textColor }]} allowFontScaling={false}>
          {label}
        </Text>
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: 32,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
    borderRadius: radii.pill,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
  },
});

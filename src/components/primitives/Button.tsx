import { useCallback } from 'react';
import {
  ActivityIndicator,
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

type Variant = 'primary' | 'secondary';

export type ButtonProps = {
  label: string;
  onPress: PressableProps['onPress'];
  disabled?: boolean;
  loading?: boolean;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
  testID?: string;
};

// Neubrutalist press — docs/design.md §1.4 (scale 0.97 on pressIn, spring.soft),
// §1.5 (hard shadow (3,3) collapses on press). Reanimated can't animate the
// compound `shadowOffset` prop; we fade `shadowOpacity` to 0 while translating
// (3,3) so the shadow visually "collapses" into the button.
function useBaseButton(interactive: boolean) {
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
    if (!interactive) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    pressed.value = withSpring(1, withReducedMotion<WithSpringConfig>(SPRING_SOFT, reduced));
  }, [interactive, pressed, reduced]);

  const handlePressOut = useCallback(() => {
    if (!interactive) return;
    pressed.value = withSpring(0, withReducedMotion<WithSpringConfig>(SPRING_SOFT, reduced));
  }, [interactive, pressed, reduced]);

  return { animatedStyle, handlePressIn, handlePressOut };
}

function BaseButton({
  label,
  onPress,
  disabled = false,
  loading = false,
  variant,
  style,
  accessibilityLabel,
  testID,
}: ButtonProps & { variant: Variant }) {
  const interactive = !disabled && !loading;
  const { animatedStyle, handlePressIn, handlePressOut } = useBaseButton(interactive);

  const variantStyle = variant === 'primary' ? styles.primary : styles.secondary;
  const labelColor = disabled ? colors.ink40 : colors.ink;

  return (
    <Pressable
      onPress={interactive ? onPress : undefined}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      disabled={!interactive}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: !interactive, busy: loading }}
      testID={testID}
    >
      <Animated.View
        style={[
          styles.base,
          variantStyle,
          disabled ? styles.disabled : shadows.hard,
          animatedStyle,
          style,
        ]}
      >
        {loading ? (
          <ActivityIndicator color={colors.ink} />
        ) : (
          <Text style={[textStyles.body, { color: labelColor }]}>{label}</Text>
        )}
      </Animated.View>
    </Pressable>
  );
}

export function ButtonPrimary(props: ButtonProps) {
  return <BaseButton {...props} variant="primary" />;
}

export function ButtonSecondary(props: ButtonProps) {
  return <BaseButton {...props} variant="secondary" />;
}

const styles = StyleSheet.create({
  base: {
    minHeight: 48,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radii.button,
    borderWidth: 2,
    borderColor: colors.ink,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: colors.ink,
    shadowOpacity: 1,
    shadowRadius: 0,
  },
  primary: {
    backgroundColor: colors.cta,
  },
  secondary: {
    backgroundColor: colors.surface,
  },
  disabled: {
    backgroundColor: colors.hairline,
    borderColor: colors.ink40,
    shadowOpacity: 0,
    elevation: 0,
  },
});

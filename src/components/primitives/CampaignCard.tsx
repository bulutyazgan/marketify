import { useCallback } from 'react';
import {
  Pressable,
  type StyleProp,
  StyleSheet,
  Text,
  View,
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
import { StatusPill, type StatusPillStatus } from './StatusPill';

export type CampaignCardCurrency = 'USD' | 'EUR' | 'GBP';

export type CampaignCardProps = {
  title: string;
  listerHandle: string;
  priceCents: number;
  currency?: CampaignCardCurrency;
  preConditionSummary?: string;
  status?: StatusPillStatus;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

const CURRENCY_SYMBOL: Record<CampaignCardCurrency, string> = {
  USD: '$',
  EUR: '€',
  GBP: '£',
};

function formatPrice(priceCents: number, currency: CampaignCardCurrency): string {
  const whole = Math.round(priceCents / 100);
  return `${CURRENCY_SYMBOL[currency]}${whole.toLocaleString('en-US')}`;
}

// Feed cell per docs/design.md §5.1 — hard-shadow card, 2px ink border. Press
// behavior per §1.4 line 103: shadow collapses (3,3) → (0,0) while the card
// translates (3,3) to mimic a physical press. Same animated-shadowOpacity + fixed
// shadowOffset pattern as Button/Chip since iOS shadowOffset is not animatable
// through Reanimated.
export function CampaignCard({
  title,
  listerHandle,
  priceCents,
  currency = 'USD',
  preConditionSummary,
  status,
  onPress,
  style,
  testID,
}: CampaignCardProps) {
  const reduced = useReducedMotion();
  const pressed = useSharedValue(0);
  const interactive = !!onPress;

  const animatedStyle = useAnimatedStyle(() => {
    const v = pressed.value;
    return {
      transform: [{ translateX: v * 3 }, { translateY: v * 3 }],
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

  return (
    <Pressable
      onPress={interactive ? onPress : undefined}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      disabled={!interactive}
      accessible={interactive}
      accessibilityRole={interactive ? 'button' : undefined}
      accessibilityLabel={interactive ? `${title} by ${listerHandle}` : undefined}
      testID={testID}
    >
      <Animated.View style={[styles.card, shadows.hard, animatedStyle, style]}>
        <Text style={[textStyles.h2, styles.title]} numberOfLines={2}>
          {title}
        </Text>
        <Text style={[textStyles.mono, styles.handle]} numberOfLines={1}>
          {listerHandle}
        </Text>
        {preConditionSummary ? (
          <Text style={[textStyles.caption, styles.preCondition]} numberOfLines={2}>
            {preConditionSummary}
          </Text>
        ) : null}
        <View style={styles.footerRow}>
          <Text style={[textStyles.h2, styles.price]}>{formatPrice(priceCents, currency)}</Text>
          {status ? <StatusPill status={status} /> : null}
        </View>
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.card,
    borderWidth: 2,
    borderColor: colors.ink,
    padding: spacing.base,
    gap: spacing.xs,
  },
  title: {
    color: colors.ink,
  },
  handle: {
    color: colors.ink70,
  },
  preCondition: {
    color: colors.ink70,
    marginTop: spacing.xs,
  },
  footerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.sm,
  },
  price: {
    color: colors.ink,
  },
});

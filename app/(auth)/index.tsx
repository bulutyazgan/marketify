import { useCallback, useState } from 'react';
import { Pressable, SafeAreaView, StyleSheet, Text, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  type WithSpringConfig,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { Building2, Video, type LucideIcon } from 'lucide-react-native';
import { colors, radii, shadows, spacing } from '@/design/tokens';
import { SPRING_SOFT, withReducedMotion } from '@/design/motion';
import { useReducedMotion } from '@/design/useReducedMotion';
import { textStyles } from '@/design/typography';
import { ButtonPrimary, ButtonSecondary } from '@/components/primitives/Button';
import { useToast } from '@/components/primitives/Toast';
import { useAuth, type AuthRole, type AuthUser } from '@/lib/auth';
import { supabase } from '@/lib/supabase';

// Role picker (docs/design.md §2.1 Welcome). Two large hard-shadow cards with
// 2px ink borders: "I'm a Creator" + "I'm a Company". Tapping routes forward
// to the role-specific signup screens that US-033/US-034 will flesh out.
// Press animation mirrors the CampaignCard pattern (Codebase Patterns #77,
// #78): animate shadowOpacity + translate on a single shared value; shadowOffset
// stays fixed because it isn't interpolatable through useAnimatedStyle.
export default function AuthIndex() {
  const router = useRouter();

  const goCreator = useCallback(() => {
    router.push('/(auth)/signup/creator');
  }, [router]);
  const goLister = useCallback(() => {
    router.push('/(auth)/signup/lister');
  }, [router]);

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        <View style={styles.hero}>
          <Text style={[textStyles.display, styles.title]}>Marketify</Text>
          <Text style={[textStyles.body, styles.subtitle]}>
            Creators claim bounties. Companies post them. Pick your side.
          </Text>
        </View>

        <View style={styles.cards}>
          <RolePickerCard
            icon={Video}
            title="I'm a Creator"
            body="Claim bounties and get paid for content you already make."
            accent={colors.primary}
            accentSoft={colors.primarySoft}
            onPress={goCreator}
            testID="auth-role-creator"
          />
          <RolePickerCard
            icon={Building2}
            title="I'm a Company"
            body="Post bounties and find creators who already fit your brief."
            accent={colors.cta}
            accentSoft={colors.warningSoft}
            onPress={goLister}
            testID="auth-role-lister"
          />
        </View>

        {__DEV__ ? <DevRolePicker /> : null}
      </View>
    </SafeAreaView>
  );
}

type RolePickerCardProps = {
  icon: LucideIcon;
  title: string;
  body: string;
  accent: string;
  accentSoft: string;
  onPress: () => void;
  testID?: string;
};

function RolePickerCard({
  icon: Icon,
  title,
  body,
  accent,
  accentSoft,
  onPress,
  testID,
}: RolePickerCardProps) {
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
    if (!onPress) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    pressed.value = withSpring(1, withReducedMotion<WithSpringConfig>(SPRING_SOFT, reduced));
  }, [onPress, pressed, reduced]);

  const handlePressOut = useCallback(() => {
    if (!onPress) return;
    pressed.value = withSpring(0, withReducedMotion<WithSpringConfig>(SPRING_SOFT, reduced));
  }, [onPress, pressed, reduced]);

  return (
    <Pressable
      onPress={onPress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityHint={body}
      testID={testID}
    >
      <Animated.View style={[styles.card, shadows.hard, animatedStyle]}>
        <View style={[styles.iconSquare, { backgroundColor: accentSoft, borderColor: accent }]}>
          <Icon size={32} strokeWidth={2.5} color={accent} />
        </View>
        <View style={styles.cardText}>
          <Text style={[textStyles.h1, styles.cardTitle]}>{title}</Text>
          <Text style={[textStyles.body, styles.cardBody]}>{body}</Text>
        </View>
      </Animated.View>
    </Pressable>
  );
}

// Dev-only signin bypass. Calls the `dev-signin` edge function, which
// idempotently authenticates two fixed accounts (`dev_creator` /
// `dev_lister`) — creating them on first call, looking them up on every
// subsequent call. Persistent accounts matter for demos: the lister who
// just created a campaign needs to be the same lister we sign back in as
// after switching to the creator role, otherwise the campaign isn't in
// "My Campaigns". Kept inside `__DEV__` so Metro strips the component
// from production bundles — top-level const declarations would survive
// dead-code removal (Codebase Patterns #96).
function DevRolePicker() {
  const router = useRouter();
  const { signIn } = useAuth();
  const { show: showToast } = useToast();
  const [busyRole, setBusyRole] = useState<AuthRole | null>(null);

  const devSignIn = useCallback(
    async (role: AuthRole) => {
      if (busyRole) return;
      setBusyRole(role);
      try {
        const { data, error } = await supabase.functions.invoke<{
          token: string;
          user_id: string;
          role: AuthRole;
          username: string;
          email: string | null;
          created_at: string;
          updated_at: string;
        }>('dev-signin', { body: { role } });
        if (error || !data?.token) throw error ?? new Error('NO_TOKEN');
        const nextUser: AuthUser = {
          id: data.user_id,
          username: data.username,
          email: data.email,
          role: data.role,
          created_at: data.created_at,
          updated_at: data.updated_at,
          deleted_at: null,
        };
        signIn(data.token, nextUser);
        router.replace(role === 'creator' ? '/(creator)/feed' : '/(lister)/dashboard');
      } catch (err) {
        console.error(`Dev ${role} signin failed`, err);
        showToast({ message: `Dev ${role} signin failed`, variant: 'error' });
      } finally {
        setBusyRole(null);
      }
    },
    [busyRole, router, showToast, signIn],
  );

  return (
    <View style={styles.devBlock}>
      <Text style={[textStyles.caption, styles.devCaption]}>DEV BYPASS</Text>
      <ButtonPrimary
        label="Sign in as creator"
        onPress={() => {
          void devSignIn('creator');
        }}
        loading={busyRole === 'creator'}
        disabled={busyRole !== null}
        accessibilityLabel="Dev sign in as creator"
        testID="dev-signin-creator"
      />
      <View style={styles.spacer} />
      <ButtonSecondary
        label="Sign in as lister"
        onPress={() => {
          void devSignIn('lister');
        }}
        loading={busyRole === 'lister'}
        disabled={busyRole !== null}
        accessibilityLabel="Dev sign in as lister"
        testID="dev-signin-lister"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.canvas,
  },
  content: {
    flex: 1,
    paddingHorizontal: spacing.base,
    paddingTop: spacing.xl,
    paddingBottom: spacing.base,
    gap: spacing.xl,
  },
  hero: {
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.base,
  },
  title: {
    color: colors.ink,
    textAlign: 'center',
  },
  subtitle: {
    color: colors.ink70,
    textAlign: 'center',
  },
  cards: {
    gap: spacing.base,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.card,
    borderWidth: 2,
    borderColor: colors.ink,
    padding: spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.base,
  },
  iconSquare: {
    width: 64,
    height: 64,
    borderRadius: radii.card,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardText: {
    flex: 1,
    gap: spacing.xs,
  },
  cardTitle: {
    color: colors.ink,
  },
  cardBody: {
    color: colors.ink70,
  },
  devBlock: {
    marginTop: 'auto',
    gap: spacing.sm,
    paddingTop: spacing.base,
    borderTopWidth: 1,
    borderTopColor: colors.hairline,
  },
  devCaption: {
    color: colors.ink40,
    textAlign: 'center',
    letterSpacing: 1,
  },
  spacer: {
    height: spacing.sm,
  },
});

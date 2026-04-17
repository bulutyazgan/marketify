import { SafeAreaView, StyleSheet, Text, View } from 'react-native';
import { ButtonPrimary, ButtonSecondary } from '@/components/primitives/Button';
import { colors, spacing } from '@/design/tokens';
import { textStyles } from '@/design/typography';
import { useAuth } from '@/lib/auth';

// Placeholder role picker — US-032 builds the two large pressables per
// docs/design.md §2.1. For US-031 this screen exists so the (auth) group has
// something to render; the __DEV__ buttons below let testers flip into a tab
// group without the real auth-* edge functions.
export default function AuthIndex() {
  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        <Text style={[textStyles.display, styles.title]}>Marketify</Text>
        <Text style={[textStyles.body, styles.subtitle]}>
          Pick your role to continue. The full picker lands in US-032.
        </Text>

        {__DEV__ ? <DevRolePicker /> : null}
      </View>
    </SafeAreaView>
  );
}

// Dev-only role picker. Declared inside an `__DEV__` branch so Metro strips
// the whole component (and the fake token / UUID constants it closes over)
// from production bundles — top-level `const`s would survive dead-code removal.
function DevRolePicker() {
  const { signIn } = useAuth();

  const creatorUser = {
    id: '00000000-0000-0000-0000-000000000001',
    username: 'dev_creator',
    email: null,
    role: 'creator' as const,
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
    deleted_at: null,
  };
  const listerUser = {
    id: '00000000-0000-0000-0000-000000000002',
    username: 'dev_lister',
    email: 'dev-lister@example.com',
    role: 'lister' as const,
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
    deleted_at: null,
  };

  return (
    <View style={styles.devBlock}>
      <Text style={[textStyles.caption, styles.devCaption]}>DEV ONLY</Text>
      <ButtonPrimary
        label="Sign in as creator"
        onPress={() => signIn('dev-creator-token', creatorUser)}
        accessibilityLabel="Dev sign in as creator"
        testID="dev-signin-creator"
      />
      <View style={styles.spacer} />
      <ButtonSecondary
        label="Sign in as lister"
        onPress={() => signIn('dev-lister-token', listerUser)}
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
    alignItems: 'stretch',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
    gap: spacing.base,
  },
  title: {
    color: colors.ink,
    textAlign: 'center',
  },
  subtitle: {
    color: colors.ink70,
    textAlign: 'center',
    marginBottom: spacing.xxl,
  },
  devBlock: {
    gap: spacing.sm,
  },
  devCaption: {
    color: colors.ink40,
    textAlign: 'center',
    letterSpacing: 1,
  },
  spacer: {
    height: spacing.md,
  },
});

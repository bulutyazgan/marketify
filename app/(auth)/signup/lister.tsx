import { SafeAreaView, StyleSheet, Text, View } from 'react-native';
import { colors, spacing } from '@/design/tokens';
import { textStyles } from '@/design/typography';

// Stub destination for US-032's role picker. The real lister signup flow
// (username + email + org name → auth-signup-lister) lands in US-033.
export default function SignupLister() {
  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        <Text style={[textStyles.h1, styles.title]}>Company signup</Text>
        <Text style={[textStyles.body, styles.body]}>
          Username + email + org name form lands here in US-033.
        </Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.canvas,
  },
  content: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
    gap: spacing.md,
  },
  title: {
    color: colors.ink,
    textAlign: 'center',
  },
  body: {
    color: colors.ink70,
    textAlign: 'center',
  },
});

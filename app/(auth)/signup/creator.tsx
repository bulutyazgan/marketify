import { SafeAreaView, StyleSheet, Text, View } from 'react-native';
import { colors, spacing } from '@/design/tokens';
import { textStyles } from '@/design/typography';

// Stub destination for US-032's role picker. The real creator signup flow
// (username + handles + Apify kickoff) lands in US-034.
export default function SignupCreator() {
  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        <Text style={[textStyles.h1, styles.title]}>Creator signup</Text>
        <Text style={[textStyles.body, styles.body]}>
          Handle inputs + metrics fetch land here in US-034.
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

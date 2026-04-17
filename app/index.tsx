import { SafeAreaView, StyleSheet, Text, View } from 'react-native';
import { ButtonPrimary, ButtonSecondary } from '@/components/primitives/Button';
import { colors, spacing } from '@/design/tokens';
import { textStyles } from '@/design/typography';

export default function Index() {
  return (
    <SafeAreaView style={styles.container}>
      <Text style={[textStyles.display, styles.title]}>Marketify</Text>
      <View style={styles.stack}>
        <ButtonPrimary label="Primary CTA" onPress={() => {}} testID="btn-primary" />
        <ButtonSecondary label="Secondary" onPress={() => {}} testID="btn-secondary" />
        <ButtonPrimary label="Disabled" onPress={() => {}} disabled testID="btn-disabled" />
        <ButtonPrimary label="Loading" onPress={() => {}} loading testID="btn-loading" />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.canvas,
    paddingHorizontal: spacing.xl,
  },
  title: {
    color: colors.ink,
    marginBottom: spacing.xxl,
  },
  stack: {
    alignSelf: 'stretch',
    gap: spacing.base,
  },
});

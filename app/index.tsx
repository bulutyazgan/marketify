import { Redirect } from 'expo-router';
import { SafeAreaView, StyleSheet, Text, View } from 'react-native';
import { colors } from '@/design/tokens';
import { textStyles } from '@/design/typography';

export default function Index() {
  if (__DEV__) {
    return <Redirect href="/(dev)/primitives" />;
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        <Text style={[textStyles.display, styles.title]}>Marketify</Text>
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
  },
  title: {
    color: colors.ink,
  },
});

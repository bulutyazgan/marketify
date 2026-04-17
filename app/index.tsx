import { StyleSheet, Text, View } from 'react-native';
import { colors } from '@/design/tokens';
import { textStyles } from '@/design/typography';

export default function Index() {
  return (
    <View style={styles.container}>
      <Text style={[textStyles.display, styles.title]}>Marketify</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.canvas,
  },
  title: {
    color: colors.ink,
  },
});

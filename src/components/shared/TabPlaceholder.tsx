import { SafeAreaView, StyleSheet, Text, View, type ViewProps } from 'react-native';
import { colors, spacing } from '@/design/tokens';
import { textStyles } from '@/design/typography';

// Placeholder surface for tab screens whose real implementation lives in later
// stories (US-035+). Keeps US-031 focused on routing + nav chrome without
// prematurely committing to per-screen content shapes.
export type TabPlaceholderProps = {
  title: string;
  subtitle: string;
  children?: ViewProps['children'];
};

export function TabPlaceholder({ title, subtitle, children }: TabPlaceholderProps) {
  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        <Text style={[textStyles.display, styles.title]}>{title}</Text>
        <Text style={[textStyles.body, styles.subtitle]}>{subtitle}</Text>
      </View>
      {children}
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
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.xxl,
  },
  title: {
    color: colors.ink,
  },
  subtitle: {
    color: colors.ink70,
    marginTop: spacing.sm,
  },
});

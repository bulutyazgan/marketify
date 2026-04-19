import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SvgXml } from 'react-native-svg';
import { colors, radii, shadows, spacing } from '@/design/tokens';
import { textStyles } from '@/design/typography';
import {
  ILLUSTRATIONS,
  type EmptyStateIllustrationKey,
} from './emptyStateIllustrations';

// US-063 — Shared error state per docs/design.md §2.5 ("hard-shadow card
// with 'Can't reach servers' + 'Try again'") and §6 Component Library.
// Rendered in the same slot as EmptyState when a screen's initial load
// fails; every list/detail screen that calls the network must surface this
// instead of an inline danger-tinted Text so the user always has a retry.
//
// Illustration key defaults to 'network_error' (the spec's canonical image
// for the offline/connection-lost case); detail screens can override to
// 'not_found' for 404s. Copy defaults match §2.5 verbatim.

export type ErrorStateProps = {
  illustration?: Extract<EmptyStateIllustrationKey, 'network_error' | 'not_found'>;
  title?: string;
  body?: string;
  retryLabel?: string;
  onRetry: () => void;
  testID?: string;
};

const ILLUSTRATION_SIZE = 120;

export function ErrorState({
  illustration = 'network_error',
  title = "Can't reach servers",
  body,
  retryLabel = 'Try again',
  onRetry,
  testID,
}: ErrorStateProps) {
  const xml = ILLUSTRATIONS[illustration];

  return (
    <View style={styles.root} testID={testID}>
      <SvgXml
        xml={xml}
        width={ILLUSTRATION_SIZE}
        height={ILLUSTRATION_SIZE}
        accessibilityRole="image"
        accessibilityLabel={title}
      />
      <Text style={[textStyles.h1, styles.title]} maxFontSizeMultiplier={1.3}>
        {title}
      </Text>
      {body ? (
        <Text style={[textStyles.body, styles.body]} maxFontSizeMultiplier={1.3}>
          {body}
        </Text>
      ) : null}
      <Pressable
        style={({ pressed }) => [
          styles.retryCard,
          shadows.hard,
          pressed ? styles.retryCardPressed : null,
        ]}
        onPress={onRetry}
        accessibilityRole="button"
        accessibilityLabel={retryLabel}
        testID={testID ? `${testID}-retry` : 'error-state-retry'}
      >
        <Text style={[textStyles.h2, styles.retryLabel]} maxFontSizeMultiplier={1.3}>
          {retryLabel}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.base,
  },
  title: {
    color: colors.ink,
    textAlign: 'center',
    marginTop: spacing.xs,
  },
  body: {
    color: colors.ink70,
    textAlign: 'center',
  },
  retryCard: {
    alignSelf: 'stretch',
    backgroundColor: colors.surface,
    borderColor: colors.ink,
    borderWidth: 2,
    borderRadius: radii.card,
    padding: spacing.base,
    alignItems: 'center',
    marginTop: spacing.xs,
  },
  retryCardPressed: {
    opacity: 0.85,
    backgroundColor: colors.primarySoft,
  },
  retryLabel: {
    color: colors.ink,
  },
});

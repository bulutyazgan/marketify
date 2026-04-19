import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SvgXml } from 'react-native-svg';
import { colors, radii, shadows, spacing } from '@/design/tokens';
import { textStyles } from '@/design/typography';
import {
  ILLUSTRATIONS,
  type EmptyStateIllustrationKey,
} from './emptyStateIllustrations';

// US-062 — Shared empty state per docs/design.md §6 (EmptyState) and §5.5
// (Discover "no eligible" shape). One illustration, one title, one body,
// and up to two action cards. The action-card shape matches §5.5 so the
// Discover empty state can use the same primitive: `caption` becomes the
// second line inside the pressable card. When no caption is supplied the
// action still renders as a card but with just the label — good enough
// for single-CTA empty states (e.g. "Post a bounty").
//
// Illustrations come from the string-keyed registry in
// `./emptyStateIllustrations.ts`; per the design checklist no caller may
// pass a loose SVG.

export type EmptyStateAction = {
  label: string;
  caption?: string;
  onPress: () => void;
  testID?: string;
  accessibilityLabel?: string;
};

export type EmptyStateProps = {
  illustration: EmptyStateIllustrationKey;
  title: string;
  body?: string;
  primaryAction?: EmptyStateAction;
  secondaryAction?: EmptyStateAction;
  testID?: string;
};

const ILLUSTRATION_SIZE = 120;

export function EmptyState({
  illustration,
  title,
  body,
  primaryAction,
  secondaryAction,
  testID,
}: EmptyStateProps) {
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
      {primaryAction ? <ActionCard action={primaryAction} /> : null}
      {secondaryAction ? <ActionCard action={secondaryAction} /> : null}
    </View>
  );
}

function ActionCard({ action }: { action: EmptyStateAction }) {
  return (
    <Pressable
      style={({ pressed }) => [
        styles.actionCard,
        shadows.hard,
        pressed ? styles.actionCardPressed : null,
      ]}
      onPress={action.onPress}
      accessibilityRole="button"
      accessibilityLabel={action.accessibilityLabel ?? action.label}
      testID={action.testID}
    >
      <Text style={[textStyles.h2, styles.actionLabel]} maxFontSizeMultiplier={1.3}>
        {action.label}
      </Text>
      {action.caption ? (
        <Text style={[textStyles.caption, styles.actionCaption]} maxFontSizeMultiplier={1.3}>
          {action.caption}
        </Text>
      ) : null}
    </Pressable>
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
  actionCard: {
    alignSelf: 'stretch',
    backgroundColor: colors.surface,
    borderColor: colors.ink,
    borderWidth: 2,
    borderRadius: radii.card,
    padding: spacing.base,
    gap: spacing.xs,
    marginTop: spacing.xs,
  },
  actionCardPressed: {
    opacity: 0.85,
    backgroundColor: colors.primarySoft,
  },
  actionLabel: {
    color: colors.ink,
  },
  actionCaption: {
    color: colors.ink70,
  },
});

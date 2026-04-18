import { Slot, router, usePathname } from 'expo-router';
import {
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { colors, radii, shadows, spacing } from '@/design/tokens';
import { textStyles } from '@/design/typography';

// US-058 — Lister Inbox layout. Owns the "Inbox" display header + the
// parent Applications / Submissions segmented control. Children
// (applications.tsx, submissions.tsx) render only their own content and
// their own sub-segment (Pending / Approved / Rejected) inside the Slot.
//
// Route-group parens are stripped by expo-router at URL time: the literal
// route `/(lister)/inbox/applications` surfaces as `/inbox/applications`
// via `usePathname`, which is why the matcher keys off that shape.
//
// router.replace (not push) per docs/design.md §3.2 — a segmented control
// is a view-state toggle, not a drill-down; pushing would grow the back
// stack as the user flips tabs.

type ParentTab = { key: 'applications' | 'submissions'; label: string; path: string };

const PARENT_TABS: readonly ParentTab[] = [
  { key: 'applications', label: 'Applications', path: '/(lister)/inbox/applications' },
  { key: 'submissions', label: 'Submissions', path: '/(lister)/inbox/submissions' },
];

export default function ListerInboxLayout() {
  const pathname = usePathname();
  const active: ParentTab['key'] = pathname.endsWith('/submissions')
    ? 'submissions'
    : 'applications';

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.headerBlock}>
        <Text style={[textStyles.display, styles.heading]}>Inbox</Text>
        <View style={styles.tabRow} accessibilityRole="tablist">
          {PARENT_TABS.map((t) => (
            <ParentTabButton
              key={t.key}
              label={t.label}
              selected={active === t.key}
              onPress={() => {
                if (active === t.key) return;
                router.replace(t.path as never);
              }}
              testID={`inbox-tab-${t.key}`}
            />
          ))}
        </View>
      </View>
      <View style={styles.content}>
        <Slot />
      </View>
    </SafeAreaView>
  );
}

type ParentTabButtonProps = {
  label: string;
  selected: boolean;
  onPress: () => void;
  testID?: string;
};

function ParentTabButton({ label, selected, onPress, testID }: ParentTabButtonProps) {
  const bg = selected ? colors.primarySoft : colors.surface;
  const textColor = selected ? colors.primaryDeep : colors.ink;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="tab"
      accessibilityState={{ selected }}
      accessibilityLabel={label}
      style={[styles.tab, { backgroundColor: bg }, shadows.hard]}
      testID={testID}
    >
      <Text style={[textStyles.micro, { color: textColor }]} allowFontScaling={false}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas },
  headerBlock: {
    paddingHorizontal: spacing.base,
    paddingTop: spacing.base,
    paddingBottom: spacing.sm,
    gap: spacing.sm,
  },
  heading: {
    color: colors.ink,
  },
  tabRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  tab: {
    minHeight: 36,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
    borderRadius: radii.pill,
    borderWidth: 2,
    borderColor: colors.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  content: { flex: 1 },
});

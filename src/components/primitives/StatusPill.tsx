import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { colors, radii, shadows, spacing } from '@/design/tokens';
import { textStyles } from '@/design/typography';

export type StatusPillStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

export type StatusPillProps = {
  status: StatusPillStatus;
  label?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

// Read-only status pill — semantic color trio per docs/design.md §1.2 (soft bg +
// solid fg). Micro typography (uppercase). `animateTo(newStatus)` worklet from
// §7 component inventory is intentionally deferred — the color-wash + shake
// transitions live in US-060 (approval/rejection animations) alongside the
// shared celebration/shake effects.
const PALETTE: Record<StatusPillStatus, { fg: string; bg: string; label: string }> = {
  pending: { fg: colors.warning, bg: colors.warningSoft, label: 'Pending' },
  approved: { fg: colors.success, bg: colors.successSoft, label: 'Approved' },
  rejected: { fg: colors.danger, bg: colors.dangerSoft, label: 'Rejected' },
  cancelled: { fg: colors.cancelled, bg: colors.cancelledSoft, label: 'Cancelled' },
};

export function StatusPill({ status, label, style, testID }: StatusPillProps) {
  const palette = PALETTE[status];
  const text = label ?? palette.label;
  return (
    <View
      style={[styles.base, { backgroundColor: palette.bg, borderColor: palette.fg }, style]}
      accessible
      accessibilityLabel={`Status: ${text}`}
      testID={testID}
    >
      <Text style={[textStyles.micro, { color: palette.fg }]} allowFontScaling={false}>
        {text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  base: {
    alignSelf: 'flex-start',
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
    borderRadius: radii.pill,
    borderWidth: 2,
    ...shadows.hard,
  },
});

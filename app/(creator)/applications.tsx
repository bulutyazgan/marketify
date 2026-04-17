import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { router } from 'expo-router';
import { StatusPill, type StatusPillStatus } from '@/components/primitives/StatusPill';
import { SkeletonCard } from '@/components/primitives/SkeletonCard';
import { colors, radii, shadows, spacing } from '@/design/tokens';
import { textStyles } from '@/design/typography';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import { formatRelativeTime } from '@/lib/time';
import type { Database } from '@/types/supabase';

// US-043 — Creator "My Applications" tab. Calls the `list_my_applications`
// SECURITY DEFINER RPC which joins applications → listings → users (lister
// handle) → listing_versions (snapshot title) under the caller's auth.uid
// and returns a flat shape the UI can render directly. The RPC exists
// because a plain PostgREST embed would silently null the lister handle
// (users RLS is self-only) and the version title for non-active listings
// (listing_versions RLS is gated on listing.status='active').
//
// Segments: Pending / Approved / Rejected / Cancelled per AC.
// DB enum has 6 values; withdrawn + cancelled_listing_* all bucket to
// "Cancelled" per design §3.1 label + AC's 4-segment design. Route path
// matches docs/design.md:151 canonical URL `/(creator)/applications`.

type ApplicationStatus = Database['public']['Enums']['application_status'];
type Segment = 'pending' | 'approved' | 'rejected' | 'cancelled';
type ApplicationRow = Database['public']['Functions']['list_my_applications']['Returns'][number];

const STATUS_BUCKET: Record<ApplicationStatus, Segment> = {
  pending: 'pending',
  approved: 'approved',
  rejected: 'rejected',
  withdrawn: 'cancelled',
  cancelled_listing_edit: 'cancelled',
  cancelled_listing_closed: 'cancelled',
};

const SEGMENTS: readonly { key: Segment; label: string }[] = [
  { key: 'pending', label: 'Pending' },
  { key: 'approved', label: 'Approved' },
  { key: 'rejected', label: 'Rejected' },
  { key: 'cancelled', label: 'Cancelled' },
];

// Segmented control semantics: a11y role "tab" with single-select state.
// Chip primitive (checkbox role) is for multi-select filter rows — a
// segmented control needs single-select. Keeping this inline rather than
// promoting to a shared primitive until another screen needs it.
type SegmentControlProps = {
  active: Segment;
  onChange: (next: Segment) => void;
};

function SegmentControl({ active, onChange }: SegmentControlProps) {
  return (
    <View style={styles.segmentRow} accessibilityRole="tablist">
      {SEGMENTS.map((s) => (
        <SegmentButton
          key={s.key}
          label={s.label}
          selected={active === s.key}
          onPress={() => onChange(s.key)}
          testID={`segment-${s.key}`}
        />
      ))}
    </View>
  );
}

type SegmentButtonProps = {
  label: string;
  selected: boolean;
  onPress: () => void;
  testID?: string;
};

function SegmentButton({ label, selected, onPress, testID }: SegmentButtonProps) {
  const bg = selected ? colors.primarySoft : colors.surface;
  const textColor = selected ? colors.primaryDeep : colors.ink;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="tab"
      accessibilityState={{ selected }}
      accessibilityLabel={label}
      style={[styles.segment, { backgroundColor: bg }, shadows.hard]}
      testID={testID}
    >
      <Text style={[textStyles.micro, { color: textColor }]} allowFontScaling={false}>
        {label}
      </Text>
    </Pressable>
  );
}

export default function Applications() {
  const { user } = useAuth();
  const userId = user?.id ?? null;

  const [segment, setSegment] = useState<Segment>('pending');
  const [rows, setRows] = useState<ApplicationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    setError(null);
    const { data, error: rpcError } = await supabase.rpc('list_my_applications');
    if (rpcError) {
      setError("Couldn't load applications.");
      setRows([]);
    } else {
      setRows(data ?? []);
    }
    setLoading(false);
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  const byBucket = useMemo(() => {
    const map: Record<Segment, ApplicationRow[]> = {
      pending: [],
      approved: [],
      rejected: [],
      cancelled: [],
    };
    for (const r of rows) {
      map[STATUS_BUCKET[r.status]].push(r);
    }
    return map;
  }, [rows]);

  const visible = byBucket[segment];

  return (
    <SafeAreaView style={styles.root}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={[textStyles.display, styles.header]}>Applied</Text>
        <SegmentControl active={segment} onChange={setSegment} />

        {loading ? (
          <View style={styles.list} testID="applications-loading">
            <SkeletonCard />
            <SkeletonCard />
          </View>
        ) : error ? (
          <View style={styles.emptyBox}>
            <Text style={[textStyles.body, { color: colors.danger }]}>{error}</Text>
          </View>
        ) : visible.length === 0 ? (
          <View style={styles.emptyBox} testID={`applications-empty-${segment}`}>
            <Text style={[textStyles.body, { color: colors.ink70 }]}>
              {emptyMessageFor(segment)}
            </Text>
          </View>
        ) : (
          <View style={styles.list}>
            {visible.map((row) => (
              <ApplicationRowCard key={row.id} row={row} />
            ))}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function emptyMessageFor(segment: Segment): string {
  switch (segment) {
    case 'pending':
      return 'No pending applications yet. Apply from Discover.';
    case 'approved':
      return 'Nothing approved yet — keep applying.';
    case 'rejected':
      return 'No rejections here.';
    case 'cancelled':
      return 'No cancelled applications.';
  }
}

type ApplicationRowCardProps = {
  row: ApplicationRow;
  style?: StyleProp<ViewStyle>;
};

// Title fallback: prefer listings.title (current), fall back to the
// version snapshot title (what the creator originally applied against),
// then a generic. Both fields come from the RPC so both are always
// populated for rows the caller owns.
function resolveTitle(row: ApplicationRow): string {
  return row.listing_title || row.version_title || 'Untitled campaign';
}

function ApplicationRowCard({ row, style }: ApplicationRowCardProps) {
  const title = resolveTitle(row);
  const handle = row.lister_handle;
  const pillStatus: StatusPillStatus = STATUS_BUCKET[row.status];
  const relative = formatRelativeTime(new Date(row.created_at));

  const onPress = useCallback(() => {
    router.push(`/(creator)/listing/${row.listing_id}`);
  }, [row.listing_id]);

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${title}${handle ? ` by @${handle}` : ''}, ${pillStatus}, applied ${relative}`}
      style={[styles.card, shadows.hard, style]}
      testID={`application-${row.id}`}
    >
      <View style={styles.cardTopRow}>
        <View style={styles.cardTitleBlock}>
          <Text style={[textStyles.h2, { color: colors.ink }]} numberOfLines={2}>
            {title}
          </Text>
          {handle ? (
            <Text style={[textStyles.caption, { color: colors.ink70 }]}>@{handle}</Text>
          ) : null}
        </View>
        <StatusPill status={pillStatus} />
      </View>
      <Text style={[textStyles.caption, { color: colors.ink70 }]}>Applied {relative}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas },
  scroll: {
    padding: spacing.base,
    gap: spacing.md,
    paddingBottom: spacing.xxxl,
  },
  header: {
    color: colors.ink,
    marginBottom: spacing.xs,
  },
  segmentRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginBottom: spacing.xs,
  },
  segment: {
    minHeight: 32,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
    borderRadius: radii.pill,
    borderWidth: 2,
    borderColor: colors.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  list: {
    gap: spacing.md,
  },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.ink,
    borderWidth: 2,
    borderRadius: radii.card,
    padding: spacing.base,
    gap: spacing.sm,
  },
  cardTopRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'flex-start',
  },
  cardTitleBlock: {
    flex: 1,
    gap: spacing.xs,
  },
  emptyBox: {
    padding: spacing.lg,
    alignItems: 'center',
  },
});

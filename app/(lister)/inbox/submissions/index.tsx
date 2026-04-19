import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { router } from 'expo-router';
import { Repeat2 } from 'lucide-react-native';
import { StatusPill, type StatusPillStatus } from '@/components/primitives/StatusPill';
import { SkeletonCard } from '@/components/primitives/SkeletonCard';
import { useToast } from '@/components/primitives/Toast';
import { EmptyState } from '@/components/shared/EmptyState';
import { colors, radii, shadows, spacing } from '@/design/tokens';
import { fontFamilies, textStyles } from '@/design/typography';
import { useAuth } from '@/lib/auth';
import { getCachedToken } from '@/lib/storage';
import { supabase } from '@/lib/supabase';
import { formatRelativeTime } from '@/lib/time';
import type { Database } from '@/types/supabase';

// US-058 — Lister Inbox, Submissions sub-tab. Calls the
// `list_my_submissions_as_lister` SECURITY DEFINER RPC (companion migration
// `us_058_list_my_submissions_as_lister_rpc`) which joins submissions →
// applications → listings → users → social_links under an explicit
// `listings.lister_id = current_user_id()` ownership gate and returns one
// flat row per submission — creator username + platform handles + first
// submission_video + `reuse_count` via the existing
// `public.submission_reuse_count(uuid)` helper (us_009). Same list-my-rows
// pattern as US-056 (Codebase Pattern #118, #141).
//
// Segments: Pending / Approved / Rejected — the submission_status enum
// has exactly those three values today, but the sub-segment still exists
// to keep shape parity with the Applications tab and to survive a future
// enum addition cleanly.
//
// Grouping: per docs/design.md §3.2 the inbox groups rows by campaign
// with inline SectionHeader separators. The RPC returns rows in
// `created_at desc`, so within each group rows remain recency-ordered;
// the group order is driven by the most-recent submission within each
// group.
//
// ReuseBadge: docs/design.md §4.6 + §4.7 — "also submitted to N other
// campaigns" chip on the submission row. The RPC returns the precomputed
// reuse_count so the UI just conditionally renders the badge. US-058
// scope is the inline (row) variant; US-059's review screen will host
// the header variant + the tap-sheet listing the other campaigns. The
// badge uses warning-soft styling (design §1.2) — non-blocking flag.
//
// Realtime INSERT subscription: submissions is in the
// supabase_realtime publication (US-044). We subscribe with no client
// filter because submissions has no lister_id column — the
// `submissions_lister_read` RLS policy is the join-through-listings
// security boundary (Codebase Pattern #123). Because the raw INSERT
// payload lacks the joined creator + video metadata, on each insert we
// re-run the RPC rather than patching locally. A toast ("New submission
// received", info variant) gives the lister an in-app cue. Toast cooldown
// (3s) prevents stacked banners when two submissions land back-to-back.
//
// Tap behavior: US-059 wires each row to the review screen
// (`/(lister)/inbox/submissions/[id]`). The list file moved from
// `submissions.tsx` to `submissions/index.tsx` to coexist with the
// dynamic-route sibling — Expo Router can't have a leaf file and a
// directory of the same name.

type SubmissionStatus = Database['public']['Enums']['submission_status'];
type Row = Database['public']['Functions']['list_my_submissions_as_lister']['Returns'][number];

const SEGMENTS: readonly { key: SubmissionStatus; label: string }[] = [
  { key: 'pending', label: 'Pending' },
  { key: 'approved', label: 'Approved' },
  { key: 'rejected', label: 'Rejected' },
];

type SegmentControlProps = {
  active: SubmissionStatus;
  counts: Record<SubmissionStatus, number>;
  onChange: (next: SubmissionStatus) => void;
};

function SegmentControl({ active, counts, onChange }: SegmentControlProps) {
  return (
    <View style={styles.segmentRow} accessibilityRole="tablist">
      {SEGMENTS.map((s) => (
        <SegmentButton
          key={s.key}
          label={`${s.label} (${counts[s.key]})`}
          selected={active === s.key}
          onPress={() => onChange(s.key)}
          testID={`submission-segment-${s.key}`}
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

// SectionHeader matches the Applications tab (docs/design.md §6). Kept
// inline here until a third consumer justifies promotion to a shared
// primitive.
function SectionHeader({ title }: { title: string }) {
  return (
    <View style={styles.sectionHeaderRow} accessibilityRole="header">
      <View style={styles.sectionRule} />
      <Text
        style={[textStyles.micro, { color: colors.ink }]}
        allowFontScaling={false}
        numberOfLines={1}
      >
        {title}
      </Text>
      <View style={styles.sectionRule} />
    </View>
  );
}

export default function ListerInboxSubmissions() {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const { show: showToast } = useToast();

  const [segment, setSegment] = useState<SubmissionStatus>('pending');
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!userId) return;
    setError(null);
    const { data, error: rpcError } = await supabase.rpc('list_my_submissions_as_lister');
    if (rpcError) {
      setError("Couldn't load submissions.");
      setRows([]);
    } else {
      setRows(data ?? []);
    }
  }, [userId]);

  // Mirror `load` through a ref so the realtime effect can call the
  // latest closure without re-subscribing every time (Pattern #82/#106).
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  // Toast cooldown matches the Applications tab — two INSERTs arriving
  // within 3s collapse into a single banner.
  const lastToastAtRef = useRef(0);
  const TOAST_COOLDOWN_MS = 3000;

  useEffect(() => {
    setLoading(true);
    void load().finally(() => setLoading(false));
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  // Realtime INSERT subscription. No client-side filter: submissions has
  // no lister_id column to filter on, and `submissions_lister_read` RLS
  // is the authoritative boundary (the broker drops any row the caller
  // can't SELECT). Same `supabase.realtime.setAuth(token)` flow as
  // US-036 / US-044 / US-056 (Codebase Pattern #105).
  useEffect(() => {
    if (!userId) return;
    const token = getCachedToken();
    if (!token) return;
    let cancelled = false;
    let activeChannel: ReturnType<typeof supabase.channel> | null = null;
    void supabase.realtime.setAuth(token).then(() => {
      if (cancelled) return;
      activeChannel = supabase
        .channel(`lister-inbox-submissions-${userId}`)
        .on(
          'postgres_changes',
          {
            event: 'INSERT',
            schema: 'public',
            table: 'submissions',
          },
          () => {
            void loadRef.current();
            const now = Date.now();
            if (now - lastToastAtRef.current >= TOAST_COOLDOWN_MS) {
              lastToastAtRef.current = now;
              showToast({
                message: 'New submission received',
                variant: 'info',
              });
            }
          },
        )
        .subscribe();
    });
    return () => {
      cancelled = true;
      if (activeChannel) void supabase.removeChannel(activeChannel);
    };
  }, [userId, showToast]);

  const byStatus = useMemo(() => {
    const map: Record<SubmissionStatus, Row[]> = { pending: [], approved: [], rejected: [] };
    for (const r of rows) {
      map[r.status].push(r);
    }
    return map;
  }, [rows]);

  const counts = useMemo<Record<SubmissionStatus, number>>(
    () => ({
      pending: byStatus.pending.length,
      approved: byStatus.approved.length,
      rejected: byStatus.rejected.length,
    }),
    [byStatus],
  );

  const grouped = useMemo(() => groupByListing(byStatus[segment]), [byStatus, segment]);
  const visibleCount = byStatus[segment].length;

  return (
    <ScrollView
      contentContainerStyle={styles.scroll}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.ink} />
      }
    >
      <SegmentControl active={segment} counts={counts} onChange={setSegment} />

      {loading ? (
        <View style={styles.list} testID="submissions-loading">
          <SkeletonCard />
          <SkeletonCard />
        </View>
      ) : error ? (
        <View style={styles.emptyBox}>
          <Text style={[textStyles.body, { color: colors.danger }]}>{error}</Text>
        </View>
      ) : visibleCount === 0 ? (
        <EmptyState
          testID={`submissions-empty-${segment}`}
          illustration="lister_no_submissions"
          title={emptyTitleFor(segment)}
          body={emptyMessageFor(segment)}
        />
      ) : (
        <View style={styles.list}>
          {grouped.map((group) => (
            <View key={group.listingId} style={styles.group}>
              <SectionHeader title={group.listingTitle} />
              {group.rows.map((row) => (
                <SubmissionInboxRow key={row.submission_id} row={row} />
              ))}
            </View>
          ))}
        </View>
      )}
    </ScrollView>
  );
}

function emptyTitleFor(segment: SubmissionStatus): string {
  switch (segment) {
    case 'pending':
      return 'No submissions yet';
    case 'approved':
      return 'No approvals yet';
    case 'rejected':
      return 'No rejections yet';
  }
}

function emptyMessageFor(segment: SubmissionStatus): string {
  switch (segment) {
    case 'pending':
      return 'New submissions will land here in real time.';
    case 'approved':
      return 'Approved submissions would show up here.';
    case 'rejected':
      return 'Rejected submissions would show up here.';
  }
}

type ListingGroup = { listingId: string; listingTitle: string; rows: Row[] };

function groupByListing(rows: Row[]): ListingGroup[] {
  const order: string[] = [];
  const by = new Map<string, ListingGroup>();
  for (const r of rows) {
    let g = by.get(r.listing_id);
    if (!g) {
      g = { listingId: r.listing_id, listingTitle: r.listing_title, rows: [] };
      by.set(r.listing_id, g);
      order.push(r.listing_id);
    }
    g.rows.push(r);
  }
  return order.map((id) => by.get(id)!);
}

function SubmissionInboxRow({ row }: { row: Row }) {
  const pillStatus: StatusPillStatus = row.status;
  const relative = formatRelativeTime(new Date(row.created_at));
  const platformLabel = row.video_platform === 'tiktok' ? 'TikTok' : 'Instagram';
  const reuse = row.reuse_count ?? 0;

  const onPress = useCallback(() => {
    router.push(`/(lister)/inbox/submissions/${row.submission_id}` as never);
  }, [row.submission_id]);

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.card,
        shadows.hard,
        pressed ? styles.cardPressed : null,
      ]}
      accessibilityRole="button"
      accessibilityLabel={`Review submission from ${row.creator_username}, ${pillStatus}, submitted ${relative}`}
      testID={`submission-row-${row.submission_id}`}
    >
      <View style={styles.cardTopRow}>
        <Text style={[textStyles.h2, { color: colors.ink }]} numberOfLines={1}>
          @{row.creator_username}
        </Text>
        <StatusPill status={pillStatus} />
      </View>

      <View style={styles.handlesBlock}>
        <HandleLine platform="TikTok" handle={row.tiktok_handle} />
        <HandleLine platform="Instagram" handle={row.instagram_handle} />
      </View>

      <View style={styles.videoBlock}>
        <Text style={[textStyles.caption, { color: colors.ink70 }]}>
          {platformLabel} video
        </Text>
        <Text
          style={[textStyles.caption, styles.videoUrl]}
          numberOfLines={1}
          ellipsizeMode="middle"
          testID={`submission-video-${row.submission_id}`}
        >
          {row.video_url}
        </Text>
      </View>

      {reuse > 0 ? (
        <ReuseBadge count={reuse} testID={`reuse-badge-${row.submission_id}`} />
      ) : null}

      <Text style={[textStyles.caption, { color: colors.ink70 }]}>Submitted {relative}</Text>
    </Pressable>
  );
}

type HandleLineProps = {
  platform: string;
  handle: string | null;
};

function HandleLine({ platform, handle }: HandleLineProps) {
  if (!handle) {
    return (
      <View style={styles.handleRow}>
        <Text style={[textStyles.caption, { color: colors.ink70, width: 80 }]}>{platform}</Text>
        <Text style={[textStyles.caption, { color: colors.ink70 }]}>no handle linked</Text>
      </View>
    );
  }
  return (
    <View style={styles.handleRow}>
      <Text style={[textStyles.caption, { color: colors.ink70, width: 80 }]}>{platform}</Text>
      <Text style={styles.handleText} allowFontScaling={false} numberOfLines={1}>
        @{handle}
      </Text>
    </View>
  );
}

// Inline ReuseBadge, inline variant per docs/design.md §4.6 + §6.
// Warning-soft background, 2-px ink border, Lucide Repeat2 icon. The
// header variant + the tap-to-list-others sheet live in US-059.
function ReuseBadge({ count, testID }: { count: number; testID?: string }) {
  const label =
    count === 1
      ? 'Also submitted to 1 other campaign'
      : `Also submitted to ${count} other campaigns`;
  return (
    <View
      style={[styles.reuseBadge, shadows.hard]}
      accessibilityRole="text"
      accessibilityLabel={label}
      testID={testID}
    >
      <Repeat2 size={14} color={colors.ink} strokeWidth={2.5} />
      <Text style={[textStyles.micro, { color: colors.ink }]} allowFontScaling={false}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  scroll: {
    padding: spacing.base,
    gap: spacing.md,
    paddingBottom: spacing.xxxl,
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
    gap: spacing.lg,
  },
  group: {
    gap: spacing.md,
  },
  sectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  sectionRule: {
    flex: 1,
    height: 2,
    backgroundColor: colors.ink,
  },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.ink,
    borderWidth: 2,
    borderRadius: radii.card,
    padding: spacing.base,
    gap: spacing.sm,
  },
  cardPressed: {
    opacity: 0.85,
  },
  cardTopRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  handlesBlock: {
    gap: spacing.xs,
  },
  handleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    flexWrap: 'wrap',
  },
  handleText: {
    fontFamily: fontFamilies.mono,
    fontSize: 13,
    lineHeight: 18,
    color: colors.ink,
  },
  videoBlock: {
    gap: spacing.xs,
  },
  videoUrl: {
    color: colors.ink70,
    fontFamily: fontFamilies.mono,
  },
  reuseBadge: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radii.pill,
    borderWidth: 2,
    borderColor: colors.ink,
    backgroundColor: colors.warningSoft,
  },
  emptyBox: {
    padding: spacing.lg,
    alignItems: 'center',
  },
});

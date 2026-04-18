import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Pressable,
  RefreshControl,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { StatusPill, type StatusPillStatus } from '@/components/primitives/StatusPill';
import { SkeletonCard } from '@/components/primitives/SkeletonCard';
import { useToast } from '@/components/primitives/Toast';
import { colors, radii, shadows, spacing } from '@/design/tokens';
import { fontFamilies, textStyles } from '@/design/typography';
import { useAuth } from '@/lib/auth';
import { getCachedToken } from '@/lib/storage';
import { supabase } from '@/lib/supabase';
import { formatRelativeTime } from '@/lib/time';
import type { Database } from '@/types/supabase';

// US-056 — Lister Inbox, Applications sub-tab. Calls the
// `list_my_applications_as_lister` SECURITY DEFINER RPC (companion migration
// `us_056_list_my_applications_as_lister_rpc`) which joins applications →
// listings → users → creator_profiles → social_links under an explicit
// `listings.lister_id = current_user_id()` ownership gate and returns one
// flat row per application — creator username + platform handles + follower
// counts + IG avg views + pitch preview. Same list-my-rows pattern as
// US-043 / US-054 (Codebase Pattern #118).
//
// Segments: Pending / Approved / Rejected per AC. The RPC already excludes
// withdrawn + cancelled_listing_edit + cancelled_listing_closed — those are
// creator-initiated or cascade-driven cancellations that don't require
// lister review. They surface on the campaign-scoped detail screen
// (US-057+), not the inbox.
//
// Grouping: per docs/design.md §3.2 the inbox groups rows by campaign with
// inline SectionHeader separators. The RPC returns rows in
// `created_at desc`, so within each group rows remain recency-ordered; the
// group order is driven by the most-recent application within each group.
//
// Realtime INSERT subscription: applications is already in the
// supabase_realtime publication (US-044). We subscribe with no client
// filter because applications has no lister_id column — the
// `applications_lister_read` RLS policy is the join-through-listings
// security boundary (Codebase Pattern #123). Because the raw INSERT
// payload lacks the joined creator + platform metrics, on each insert we
// re-run the RPC rather than patching locally. A toast ("New application
// received", info variant) gives the lister an in-app cue.

type ApplicationStatus = Database['public']['Enums']['application_status'];
type Segment = 'pending' | 'approved' | 'rejected';
type Row = Database['public']['Functions']['list_my_applications_as_lister']['Returns'][number];

// Compile-time exhaustive mapping: if a new enum value is added the
// compiler flags the missing bucket (Codebase Pattern #121). The three
// enum values the RPC filters out are intentionally absent — they cannot
// reach this screen.
const STATUS_BUCKET: Record<
  Exclude<
    ApplicationStatus,
    'withdrawn' | 'cancelled_listing_edit' | 'cancelled_listing_closed'
  >,
  Segment
> = {
  pending: 'pending',
  approved: 'approved',
  rejected: 'rejected',
};

const SEGMENTS: readonly { key: Segment; label: string }[] = [
  { key: 'pending', label: 'Pending' },
  { key: 'approved', label: 'Approved' },
  { key: 'rejected', label: 'Rejected' },
];

type SegmentControlProps = {
  active: Segment;
  counts: Record<Segment, number>;
  onChange: (next: Segment) => void;
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

// SectionHeader per docs/design.md §6 — kept inline until a second consumer
// shows up. The `══════ Label ══════` visual uses horizontal rules bracketing
// the title; a single flex row with 2-px borders keeps it token-friendly.
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

function bucketFor(status: ApplicationStatus): Segment | null {
  if (status === 'withdrawn') return null;
  if (status === 'cancelled_listing_edit') return null;
  if (status === 'cancelled_listing_closed') return null;
  return STATUS_BUCKET[status];
}

export default function ListerInboxApplications() {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const { show: showToast } = useToast();

  const [segment, setSegment] = useState<Segment>('pending');
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!userId) return;
    setError(null);
    const { data, error: rpcError } = await supabase.rpc('list_my_applications_as_lister');
    if (rpcError) {
      setError("Couldn't load applications.");
      setRows([]);
    } else {
      setRows(data ?? []);
    }
  }, [userId]);

  // Mirror `load` through a ref so the realtime effect can call the latest
  // closure without re-subscribing every time `load` re-creates. Same
  // pattern as the creator realtime handler (Codebase Pattern #82/#106).
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  // Toast cooldown: two INSERTs arriving in the same second (e.g. a
  // creator applying to two listings back-to-back, or two creators
  // racing) would otherwise stack back-to-back toasts. The re-fetch
  // itself is idempotent — only the user-facing banner needs dedup.
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

  // Realtime INSERT subscription. No client-side filter: applications has
  // no lister_id column to filter on, and `applications_lister_read` RLS is
  // the authoritative boundary (the broker drops any row the caller can't
  // SELECT). supabase.realtime.setAuth(token) mirrors the US-036 +
  // US-044 pattern for authenticated websockets (Codebase Pattern #105).
  useEffect(() => {
    if (!userId) return;
    const token = getCachedToken();
    if (!token) return;
    let cancelled = false;
    let activeChannel: ReturnType<typeof supabase.channel> | null = null;
    void supabase.realtime.setAuth(token).then(() => {
      if (cancelled) return;
      activeChannel = supabase
        .channel(`lister-inbox-applications-${userId}`)
        .on(
          'postgres_changes',
          {
            event: 'INSERT',
            schema: 'public',
            table: 'applications',
          },
          () => {
            void loadRef.current();
            const now = Date.now();
            if (now - lastToastAtRef.current >= TOAST_COOLDOWN_MS) {
              lastToastAtRef.current = now;
              showToast({
                message: 'New application received',
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

  const byBucket = useMemo(() => {
    const map: Record<Segment, Row[]> = { pending: [], approved: [], rejected: [] };
    for (const r of rows) {
      const b = bucketFor(r.status);
      if (b) map[b].push(r);
    }
    return map;
  }, [rows]);

  const counts = useMemo<Record<Segment, number>>(
    () => ({
      pending: byBucket.pending.length,
      approved: byBucket.approved.length,
      rejected: byBucket.rejected.length,
    }),
    [byBucket],
  );

  const grouped = useMemo(() => groupByListing(byBucket[segment]), [byBucket, segment]);
  const visibleCount = byBucket[segment].length;

  return (
    <SafeAreaView style={styles.root}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.ink} />
        }
      >
        <Text style={[textStyles.display, styles.header]}>Inbox</Text>
        <SegmentControl active={segment} counts={counts} onChange={setSegment} />

        {loading ? (
          <View style={styles.list} testID="applications-loading">
            <SkeletonCard />
            <SkeletonCard />
          </View>
        ) : error ? (
          <View style={styles.emptyBox}>
            <Text style={[textStyles.body, { color: colors.danger }]}>{error}</Text>
          </View>
        ) : visibleCount === 0 ? (
          <View style={styles.emptyBox} testID={`applications-empty-${segment}`}>
            <Text style={[textStyles.body, { color: colors.ink70, textAlign: 'center' }]}>
              {emptyMessageFor(segment)}
            </Text>
          </View>
        ) : (
          <View style={styles.list}>
            {grouped.map((group) => (
              <View key={group.listingId} style={styles.group}>
                <SectionHeader title={group.listingTitle} />
                {group.rows.map((row) => (
                  <ApplicationInboxRow key={row.application_id} row={row} />
                ))}
              </View>
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
      return 'No pending applications. New applications will land here in real time.';
    case 'approved':
      return 'No approvals yet.';
    case 'rejected':
      return 'No rejections yet.';
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

function ApplicationInboxRow({ row }: { row: Row }) {
  const pillStatus: StatusPillStatus =
    row.status === 'pending' || row.status === 'approved' || row.status === 'rejected'
      ? row.status
      : 'cancelled';
  const relative = formatRelativeTime(new Date(row.created_at));
  const pitch = row.cover_note?.trim() ?? '';

  return (
    <View
      style={[styles.card, shadows.hard]}
      accessibilityLabel={`Application from ${row.creator_username}, ${pillStatus}, applied ${relative}`}
      testID={`application-${row.application_id}`}
    >
      <View style={styles.cardTopRow}>
        <Text style={[textStyles.h2, { color: colors.ink }]} numberOfLines={1}>
          @{row.creator_username}
        </Text>
        <StatusPill status={pillStatus} />
      </View>

      <View style={styles.metricsBlock}>
        <MetricLine
          platform="TikTok"
          handle={row.tiktok_handle}
          primary={row.tiktok_follower_count}
          primaryLabel="followers"
          testID={`metrics-tiktok-${row.application_id}`}
        />
        <MetricLine
          platform="Instagram"
          handle={row.instagram_handle}
          primary={row.instagram_follower_count}
          primaryLabel="followers"
          secondary={row.instagram_avg_views_last_10}
          secondaryLabel="avg views"
          testID={`metrics-ig-${row.application_id}`}
        />
      </View>

      {pitch ? (
        <Text
          style={[textStyles.body, { color: colors.ink70 }]}
          numberOfLines={2}
          testID={`pitch-${row.application_id}`}
        >
          {pitch}
        </Text>
      ) : null}

      <Text style={[textStyles.caption, { color: colors.ink70 }]}>Applied {relative}</Text>
    </View>
  );
}

type MetricLineProps = {
  platform: string;
  handle: string | null;
  primary: number | null;
  primaryLabel: string;
  secondary?: number | null;
  secondaryLabel?: string;
  testID?: string;
};

function MetricLine({
  platform,
  handle,
  primary,
  primaryLabel,
  secondary,
  secondaryLabel,
  testID,
}: MetricLineProps) {
  if (!handle) {
    return (
      <View style={styles.metricRow} testID={testID}>
        <Text style={[textStyles.caption, { color: colors.ink70, width: 80 }]}>{platform}</Text>
        <Text style={[textStyles.caption, { color: colors.ink70 }]}>no handle linked</Text>
      </View>
    );
  }
  return (
    <View style={styles.metricRow} testID={testID}>
      <Text style={[textStyles.caption, { color: colors.ink70, width: 80 }]}>{platform}</Text>
      <Text style={styles.metricHandle} allowFontScaling={false} numberOfLines={1}>
        @{handle}
      </Text>
      <Text style={[textStyles.caption, { color: colors.ink }]}>
        {formatCount(primary)} {primaryLabel}
        {secondary != null && secondaryLabel
          ? ` · ${formatCount(secondary)} ${secondaryLabel}`
          : ''}
      </Text>
    </View>
  );
}

// Compact thousands formatter: 12_345 → "12.3K", 1_200_000 → "1.2M". Keeps
// inbox rows dense and matches the other social-metric callouts on the
// discover + detail screens.
function formatCount(n: number | null): string {
  if (n == null || n < 0) return '—';
  if (n < 1_000) return n.toLocaleString('en-US');
  if (n < 1_000_000) return `${(n / 1_000).toFixed(n < 10_000 ? 1 : 0)}K`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
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
  cardTopRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  metricsBlock: {
    gap: spacing.xs,
  },
  metricRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    flexWrap: 'wrap',
  },
  metricHandle: {
    fontFamily: fontFamilies.mono,
    fontSize: 13,
    lineHeight: 18,
    color: colors.ink,
  },
  emptyBox: {
    padding: spacing.lg,
    alignItems: 'center',
  },
});

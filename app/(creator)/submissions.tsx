import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import {
  CelebrationBurst,
  type CelebrationBurstHandle,
} from '@/components/effects/CelebrationBurst';
import { ShakeOnError, type ShakeOnErrorHandle } from '@/components/effects/ShakeOnError';
import { StatusPill, type StatusPillStatus } from '@/components/primitives/StatusPill';
import { SkeletonCard } from '@/components/primitives/SkeletonCard';
import { useToast } from '@/components/primitives/Toast';
import { EmptyState } from '@/components/shared/EmptyState';
import { colors, radii, shadows, spacing } from '@/design/tokens';
import { textStyles } from '@/design/typography';
import { useAuth } from '@/lib/auth';
import { getCachedToken } from '@/lib/storage';
import { supabase } from '@/lib/supabase';
import { formatRelativeTime } from '@/lib/time';
import type { Database } from '@/types/supabase';

// US-047 — Creator "My Submissions" tab. Mirrors the US-043 applications
// screen: calls `list_my_submissions` (SECURITY DEFINER, scoped to the
// caller's applications) and renders three segments matching the
// submission_status enum (pending / approved / rejected). Press routes
// to the listing detail so creators can re-read the brief; submissions
// have no dedicated detail screen in v1.
//
// Realtime: subscribes to UPDATE events on public.submissions. The
// submissions table has no direct creator_id column, so we omit the
// server-side filter and let the broker's RLS evaluation
// (`submissions_creator_rw`, join-through-applications) gate visibility.
// Same `supabase.realtime.setAuth(token)` flow as US-044. Publication
// update lands in the companion migration
// `us_047_submissions_realtime_publication`. Under the DevRolePicker
// session the literal dev token is rejected by the broker (Codebase
// Pattern #122) — empty-state screenshots verify wiring only.
//
// Spec gap: AC text calls the file `submitted.tsx`, but the TabBar
// route established in US-031 is `/(creator)/submissions`. Renaming the
// file would invalidate the established routing convention, so the file
// name stays as `submissions.tsx` while the header renders "Submitted"
// per docs/design.md §3.1 tab label.

type SubmissionStatus = Database['public']['Enums']['submission_status'];
type SubmissionRow = Database['public']['Functions']['list_my_submissions']['Returns'][number];

const SEGMENTS: readonly { key: SubmissionStatus; label: string }[] = [
  { key: 'pending', label: 'Pending' },
  { key: 'approved', label: 'Approved' },
  { key: 'rejected', label: 'Rejected' },
];

type SegmentControlProps = {
  active: SubmissionStatus;
  onChange: (next: SubmissionStatus) => void;
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

export default function Submissions() {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const { show: showToast } = useToast();

  const [segment, setSegment] = useState<SubmissionStatus>('pending');
  const [rows, setRows] = useState<SubmissionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const rowsRef = useRef<SubmissionRow[]>([]);
  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);

  // US-060 — approval/rejection animation dispatch. Same pattern as
  // applications.tsx: CelebrationBurst mounts once at screen level;
  // ShakeOnError wraps each row's StatusPill via a callback-ref-registered
  // imperative handle so the realtime handler can shake by row id.
  const burstRef = useRef<CelebrationBurstHandle | null>(null);
  const shakeRefs = useRef<Map<string, ShakeOnErrorHandle>>(new Map());
  const registerShake = useCallback(
    (id: string, handle: ShakeOnErrorHandle | null) => {
      if (handle) shakeRefs.current.set(id, handle);
      else shakeRefs.current.delete(id);
    },
    [],
  );

  const load = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    setError(null);
    const { data, error: rpcError } = await supabase.rpc('list_my_submissions');
    if (rpcError) {
      setError("Couldn't load submissions.");
      setRows([]);
    } else {
      setRows(data ?? []);
    }
    setLoading(false);
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Subscribe to UPDATE events on the caller's own submissions. RLS is
  // the security boundary (no direct creator_id filter available — see
  // the header comment). Only the `status` field flips under the lister
  // decision flow; we patch the row in state so it jumps to the new
  // segment without a manual refresh.
  useEffect(() => {
    if (!userId) return;
    const token = getCachedToken();
    if (!token) return;
    let cancelled = false;
    let activeChannel: ReturnType<typeof supabase.channel> | null = null;
    void supabase.realtime.setAuth(token).then(() => {
      if (cancelled) return;
      activeChannel = supabase
        .channel(`creator-submissions-${userId}`)
        .on(
          'postgres_changes',
          {
            event: 'UPDATE',
            schema: 'public',
            table: 'submissions',
          },
          (payload) => {
            const next = payload.new as { id?: string; status?: SubmissionStatus };
            if (!next.id || !next.status) return;
            const prior = rowsRef.current.find((r) => r.id === next.id);
            if (!prior) return;
            if (prior.status === next.status) return;
            const nextStatus = next.status;
            // US-060: fire the animation BEFORE patching state so the row
            // is still mounted when shake() is called. docs/design.md §5.3
            // drives the shape — approved: confetti-lite + success banner;
            // rejected: row shake + silent landing (no confetti, no banner).
            if (nextStatus === 'approved') {
              burstRef.current?.burst();
            } else if (nextStatus === 'rejected') {
              shakeRefs.current.get(next.id)?.shake();
            }
            setRows((cur) =>
              cur.map((r) => (r.id === next.id ? { ...r, status: nextStatus } : r)),
            );
            if (nextStatus === 'approved') {
              showToast({
                message: 'Approved — nice work!',
                variant: 'success',
              });
            }
            // Rejected path is intentionally silent per §5.3 — no banner.
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
    const map: Record<SubmissionStatus, SubmissionRow[]> = {
      pending: [],
      approved: [],
      rejected: [],
    };
    for (const r of rows) {
      map[r.status].push(r);
    }
    return map;
  }, [rows]);

  const visible = byStatus[segment];

  return (
    <SafeAreaView style={styles.root}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={[textStyles.display, styles.header]}>Submitted</Text>
        <SegmentControl active={segment} onChange={setSegment} />

        {loading ? (
          <View style={styles.list} testID="submissions-loading">
            <SkeletonCard />
            <SkeletonCard />
          </View>
        ) : error ? (
          <View style={styles.emptyBox}>
            <Text style={[textStyles.body, { color: colors.danger }]}>{error}</Text>
          </View>
        ) : visible.length === 0 ? (
          <EmptyState
            testID={`submissions-empty-${segment}`}
            illustration="no_submissions"
            title={emptyTitleFor(segment)}
            body={emptyMessageFor(segment)}
            primaryAction={
              segment === 'pending'
                ? {
                    label: 'Go to Applied',
                    caption: 'Submit a video from an approved application.',
                    onPress: () => router.push('/(creator)/applications'),
                    testID: 'submissions-empty-cta-pending',
                  }
                : undefined
            }
          />
        ) : (
          <View style={styles.list}>
            {visible.map((row) => (
              <SubmissionRowCard key={row.id} row={row} registerShake={registerShake} />
            ))}
          </View>
        )}
      </ScrollView>
      <CelebrationBurst ref={burstRef} />
    </SafeAreaView>
  );
}

function emptyTitleFor(segment: SubmissionStatus): string {
  switch (segment) {
    case 'pending':
      return 'No pending submissions';
    case 'approved':
      return 'Nothing approved yet';
    case 'rejected':
      return 'No rejections here';
  }
}

function emptyMessageFor(segment: SubmissionStatus): string {
  switch (segment) {
    case 'pending':
      return 'Approved applications unlock the submit flow.';
    case 'approved':
      return 'Your accepted videos will show up here.';
    case 'rejected':
      return 'Rejected submissions would appear here.';
  }
}

function resolveTitle(row: SubmissionRow): string {
  return row.listing_title || row.version_title || 'Untitled campaign';
}

type SubmissionRowCardProps = {
  row: SubmissionRow;
  registerShake?: (id: string, handle: ShakeOnErrorHandle | null) => void;
  style?: StyleProp<ViewStyle>;
};

function SubmissionRowCard({ row, registerShake, style }: SubmissionRowCardProps) {
  const title = resolveTitle(row);
  const handle = row.lister_handle;
  const pillStatus: StatusPillStatus = row.status;
  const relative = formatRelativeTime(new Date(row.created_at));

  const onPress = useCallback(() => {
    router.push(`/(creator)/listing/${row.listing_id}`);
  }, [row.listing_id]);

  const shakeRef = useCallback(
    (instance: ShakeOnErrorHandle | null) => {
      if (registerShake) registerShake(row.id, instance);
    },
    [registerShake, row.id],
  );

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${title}${handle ? ` by @${handle}` : ''}, ${pillStatus}, submitted ${relative}`}
      style={[styles.card, shadows.hard, style]}
      testID={`submission-${row.id}`}
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
        <ShakeOnError ref={shakeRef}>
          <StatusPill status={pillStatus} />
        </ShakeOnError>
      </View>
      {row.video_url ? (
        <Text
          style={[textStyles.caption, styles.videoUrl]}
          numberOfLines={1}
          ellipsizeMode="middle"
        >
          {row.video_url}
        </Text>
      ) : null}
      <Text style={[textStyles.caption, { color: colors.ink70 }]}>Submitted {relative}</Text>
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
  videoUrl: {
    color: colors.ink70,
    fontFamily: 'monospace',
  },
  emptyBox: {
    padding: spacing.lg,
    alignItems: 'center',
  },
});

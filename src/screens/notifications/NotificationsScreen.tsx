import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Pressable,
  RefreshControl,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { router, type Href } from 'expo-router';
import {
  AlertCircle,
  BellRing,
  CheckCircle2,
  FileEdit,
  Inbox,
  XCircle,
  type LucideIcon,
} from 'lucide-react-native';
import { SkeletonCard } from '@/components/primitives/SkeletonCard';
import { colors, radii, shadows, spacing } from '@/design/tokens';
import { textStyles } from '@/design/typography';
import { useAuth } from '@/lib/auth';
import { getCachedToken } from '@/lib/storage';
import { supabase } from '@/lib/supabase';
import { formatRelativeTime } from '@/lib/time';
import type { Database } from '@/types/supabase';

// US-061 — Activity inbox shared by the (creator) and (lister) notifications
// routes. Reads `public.notifications` directly via PostgREST under the
// `notifications_self_rw` RLS policy (us_009); no RPC wrapper is needed
// because every displayed column is on the table itself and the policy is
// self-scoped.
//
// Ordering: unread first (read_at IS NULL), then newest-first by created_at.
// Supabase-js exposes nulls-first ordering via `order(col, { nullsFirst })`;
// sorting on read_at with nullsFirst=true + descending on created_at nets
// exactly the two-tier sort the AC asks for.
//
// Realtime: subscribes to INSERT + UPDATE on the caller's rows. The
// `notifications` table joined the `supabase_realtime` publication in the
// US-061 migration. On INSERT we prepend; on UPDATE we refetch (the most
// common UPDATE is mark-as-read, which is already client-issued locally;
// backend-driven updates are rare, so a pull-all-rows refresh is cheaper
// than diffing in-place).
//
// Tap behavior: marks the row read (direct UPDATE under RLS self-rw) and
// routes to the most-relevant destination for the kind. Deep-link map lives
// per-role because creator and lister inbox/profile routes differ.

type NotificationRow = Database['public']['Tables']['notifications']['Row'];
type NotificationKind = Database['public']['Enums']['notification_kind'];

type Role = 'creator' | 'lister';

export type NotificationsScreenProps = {
  role: Role;
};

// Visual presentation per kind: icon + tone + human-readable title/body
// derived from payload. Payload shapes vary by emitter (see progress.txt
// learnings on cascade trigger + decide_submission_rpc); the renderer is
// defensive about missing fields and falls back to generic copy.
type Tone = 'success' | 'danger' | 'warning' | 'info';

const TONE_COLORS: Record<Tone, { fg: string; bg: string }> = {
  success: { fg: colors.success, bg: colors.successSoft },
  danger: { fg: colors.danger, bg: colors.dangerSoft },
  warning: { fg: colors.warning, bg: colors.warningSoft },
  info: { fg: colors.ink, bg: colors.primarySoft },
};

const KIND_VISUAL: Record<NotificationKind, { icon: LucideIcon; tone: Tone }> = {
  application_approved: { icon: CheckCircle2, tone: 'success' },
  application_rejected: { icon: XCircle, tone: 'danger' },
  application_cancelled: { icon: FileEdit, tone: 'warning' },
  submission_received: { icon: Inbox, tone: 'info' },
  submission_approved: { icon: CheckCircle2, tone: 'success' },
  submission_rejected: { icon: XCircle, tone: 'danger' },
  listing_version_changed: { icon: FileEdit, tone: 'warning' },
  metrics_refresh_failed: { icon: AlertCircle, tone: 'danger' },
};

type PayloadShape = {
  listing_title?: string | null;
  creator_handle?: string | null;
  decision_note?: string | null;
  application_id?: string | null;
  submission_id?: string | null;
  listing_id?: string | null;
};

function readPayload(payload: NotificationRow['payload']): PayloadShape {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return {};
  }
  return payload as PayloadShape;
}

function titleFor(row: NotificationRow): string {
  const p = readPayload(row.payload);
  const title = p.listing_title ?? 'Campaign';
  switch (row.kind) {
    case 'application_approved':
      return `Approved: ${title}`;
    case 'application_rejected':
      return `Rejected: ${title}`;
    case 'application_cancelled':
      return `Cancelled: ${title}`;
    case 'submission_received':
      return p.creator_handle
        ? `New submission from @${p.creator_handle}`
        : 'New submission received';
    case 'submission_approved':
      return `Submission approved: ${title}`;
    case 'submission_rejected':
      return `Submission rejected: ${title}`;
    case 'listing_version_changed':
      return 'Campaign was edited';
    case 'metrics_refresh_failed':
      return "Couldn't refresh your metrics";
  }
}

function bodyFor(row: NotificationRow): string | null {
  const p = readPayload(row.payload);
  switch (row.kind) {
    case 'application_approved':
      return 'Time to submit your video.';
    case 'application_rejected':
      return p.decision_note ?? null;
    case 'application_cancelled':
      return 'Your application was cancelled because the campaign changed.';
    case 'submission_received':
      return p.listing_title ? `on "${p.listing_title}"` : null;
    case 'submission_approved':
      return 'Nice work — the campaign owner accepted your video.';
    case 'submission_rejected':
      return p.decision_note ?? null;
    case 'listing_version_changed':
      return p.listing_title ?? null;
    case 'metrics_refresh_failed':
      return 'Try again from your profile in a bit.';
  }
}

function routeFor(row: NotificationRow, role: Role): Href {
  const p = readPayload(row.payload);
  if (role === 'creator') {
    switch (row.kind) {
      case 'application_approved':
      case 'application_rejected':
      case 'application_cancelled':
      case 'listing_version_changed':
        return '/(creator)/applications';
      case 'submission_approved':
      case 'submission_rejected':
        return '/(creator)/submissions';
      case 'submission_received':
        // Creators don't receive this kind, but fall through defensively.
        return p.listing_id ? `/(creator)/listing/${p.listing_id}` : '/(creator)/feed';
      case 'metrics_refresh_failed':
        return '/(creator)/profile';
    }
  }
  switch (row.kind) {
    case 'submission_received':
      return '/(lister)/inbox';
    case 'submission_approved':
    case 'submission_rejected':
      return '/(lister)/inbox';
    case 'application_approved':
    case 'application_rejected':
    case 'application_cancelled':
    case 'listing_version_changed':
      return '/(lister)/inbox';
    case 'metrics_refresh_failed':
      return '/(lister)/dashboard';
  }
}

export function NotificationsScreen({ role }: NotificationsScreenProps) {
  const { user } = useAuth();
  const userId = user?.id ?? null;

  const [rows, setRows] = useState<NotificationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (mode: 'initial' | 'refresh' = 'initial') => {
      if (!userId) return;
      if (mode === 'initial') setLoading(true);
      else setRefreshing(true);
      setError(null);
      const { data, error: rpcError } = await supabase
        .from('notifications')
        .select('*')
        .order('read_at', { ascending: true, nullsFirst: true })
        .order('created_at', { ascending: false })
        .limit(100);
      if (rpcError) {
        setError("Couldn't load notifications.");
        setRows([]);
      } else {
        setRows(data ?? []);
      }
      if (mode === 'initial') setLoading(false);
      else setRefreshing(false);
    },
    [userId],
  );

  useEffect(() => {
    void load('initial');
  }, [load]);

  // Realtime: INSERT prepends (keeping unread-first invariant since new rows
  // are unread by definition); UPDATE triggers a list refresh to pick up
  // status changes initiated elsewhere (e.g. another device tapping a
  // notification).
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    let activeChannel: ReturnType<typeof supabase.channel> | null = null;

    const token = getCachedToken();
    if (!token) return;

    const setup = async () => {
      await supabase.realtime.setAuth(token);
      if (cancelled) return;
      activeChannel = supabase
        .channel(`notifications-inbox-${userId}`)
        .on(
          'postgres_changes',
          {
            event: 'INSERT',
            schema: 'public',
            table: 'notifications',
            filter: `user_id=eq.${userId}`,
          },
          (payload) => {
            const fresh = payload.new as NotificationRow;
            setRows((cur) => {
              if (cur.some((r) => r.id === fresh.id)) return cur;
              return [fresh, ...cur];
            });
          },
        )
        .on(
          'postgres_changes',
          {
            event: 'UPDATE',
            schema: 'public',
            table: 'notifications',
            filter: `user_id=eq.${userId}`,
          },
          (payload) => {
            const fresh = payload.new as NotificationRow;
            setRows((cur) => cur.map((r) => (r.id === fresh.id ? { ...r, ...fresh } : r)));
          },
        )
        .subscribe();
    };

    void setup();
    return () => {
      cancelled = true;
      if (activeChannel) void supabase.removeChannel(activeChannel);
    };
  }, [userId]);

  const onTap = useCallback(
    async (row: NotificationRow) => {
      // Optimistic mark-read; if the server fails the next refresh restores.
      // The user_id filter is a throughput guard — RLS already scopes the
      // update, but pairing the predicates prevents a broader UPDATE if the
      // policy is ever relaxed.
      if (!row.read_at && userId) {
        const readAt = new Date().toISOString();
        setRows((cur) =>
          cur.map((r) => (r.id === row.id ? { ...r, read_at: readAt } : r)),
        );
        void supabase
          .from('notifications')
          .update({ read_at: readAt })
          .eq('id', row.id)
          .eq('user_id', userId);
      }
      router.push(routeFor(row, role));
    },
    [role, userId],
  );

  const onRefresh = useCallback(() => {
    void load('refresh');
  }, [load]);

  const unreadCount = useMemo(() => rows.filter((r) => !r.read_at).length, [rows]);

  return (
    <SafeAreaView style={styles.root}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        <View style={styles.headerRow}>
          <Text style={[textStyles.display, { color: colors.ink }]}>Activity</Text>
          {unreadCount > 0 ? (
            <Text style={[textStyles.caption, { color: colors.ink70 }]}>
              {unreadCount} unread
            </Text>
          ) : null}
        </View>

        {loading ? (
          <View style={styles.list} testID="notifications-loading">
            <SkeletonCard />
            <SkeletonCard />
          </View>
        ) : error ? (
          <View style={styles.emptyBox}>
            <Text style={[textStyles.body, { color: colors.danger }]}>{error}</Text>
          </View>
        ) : rows.length === 0 ? (
          <View style={styles.emptyBox} testID="notifications-empty">
            <BellRing size={32} color={colors.ink40} strokeWidth={1.5} />
            <Text style={[textStyles.body, styles.emptyTitle]}>
              Nothing here yet
            </Text>
            <Text style={[textStyles.caption, { color: colors.ink70 }]}>
              We&apos;ll let you know as soon as something happens.
            </Text>
          </View>
        ) : (
          <View style={styles.list}>
            {rows.map((row) => (
              <NotificationRowCard key={row.id} row={row} onPress={() => void onTap(row)} />
            ))}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

type NotificationRowCardProps = {
  row: NotificationRow;
  onPress: () => void;
};

function NotificationRowCard({ row, onPress }: NotificationRowCardProps) {
  const visual = KIND_VISUAL[row.kind];
  const tone = TONE_COLORS[visual.tone];
  const Icon = visual.icon;
  const isUnread = !row.read_at;
  const title = titleFor(row);
  const body = bodyFor(row);
  const relative = formatRelativeTime(new Date(row.created_at));

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${isUnread ? 'Unread: ' : ''}${title}${body ? `. ${body}` : ''}, ${relative}`}
      style={[
        styles.card,
        shadows.hard,
        isUnread ? styles.cardUnread : null,
      ]}
      testID={`notification-${row.id}`}
    >
      <View style={[styles.iconBubble, { backgroundColor: tone.bg, borderColor: tone.fg }]}>
        <Icon size={20} color={tone.fg} strokeWidth={2} />
      </View>
      <View style={styles.cardBody}>
        <View style={styles.cardTopRow}>
          <Text
            style={[textStyles.h2, styles.title]}
            numberOfLines={2}
            maxFontSizeMultiplier={1.3}
          >
            {title}
          </Text>
          {isUnread ? <View style={styles.unreadDot} accessibilityElementsHidden /> : null}
        </View>
        {body ? (
          <Text
            style={[textStyles.body, { color: colors.ink70 }]}
            numberOfLines={2}
            maxFontSizeMultiplier={1.3}
          >
            {body}
          </Text>
        ) : null}
        <Text style={[textStyles.caption, { color: colors.ink40 }]}>{relative}</Text>
      </View>
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
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    marginBottom: spacing.xs,
  },
  list: {
    gap: spacing.md,
  },
  card: {
    flexDirection: 'row',
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderColor: colors.ink,
    borderWidth: 2,
    borderRadius: radii.card,
    padding: spacing.base,
  },
  cardUnread: {
    backgroundColor: colors.primarySoft,
  },
  iconBubble: {
    width: 40,
    height: 40,
    borderRadius: 999,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardBody: {
    flex: 1,
    gap: spacing.xs,
  },
  cardTopRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
  },
  title: {
    flex: 1,
    color: colors.ink,
  },
  unreadDot: {
    marginTop: 6,
    width: 10,
    height: 10,
    borderRadius: 999,
    backgroundColor: colors.primary,
    borderWidth: 2,
    borderColor: colors.ink,
  },
  emptyBox: {
    padding: spacing.xl,
    alignItems: 'center',
    gap: spacing.sm,
  },
  emptyTitle: {
    color: colors.ink,
    marginTop: spacing.sm,
  },
});

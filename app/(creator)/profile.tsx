import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform as RNPlatform,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  type WithSpringConfig,
} from 'react-native-reanimated';
import { BottomSheet } from '@/components/primitives/BottomSheet';
import { ButtonPrimary, ButtonSecondary } from '@/components/primitives/Button';
import { useToast } from '@/components/primitives/Toast';
import { SPRING_SNAPPY, withReducedMotion } from '@/design/motion';
import { colors, radii, shadows, spacing } from '@/design/tokens';
import { textStyles } from '@/design/typography';
import { useReducedMotion } from '@/design/useReducedMotion';
import { useAuth } from '@/lib/auth';
import { getCachedToken } from '@/lib/storage';
import { supabase } from '@/lib/supabase';
import { formatRelativeTime, formatRetryAfter } from '@/lib/time';
import type { Database } from '@/types/supabase';

// US-035 — creator profile. Shows TikTok + Instagram handles with their
// denormalized follower counts / avg views, a "Stale" chip when the latest
// metric_snapshot was flipped to status='stale' by the hourly cron, and an
// Add / Unlink flow wired to the manage-social-link edge function.
//
// Spec gap: the story AC says "Stale chip appears when metrics_stale_at is
// non-null", but there is no metrics_stale_at column on creator_profiles
// (see us_004 + the us_011 cron which flips metric_snapshots.status='stale'
// instead). The chip is therefore derived from
// metric_snapshots WHERE is_latest = true AND status = 'stale', which is
// the signal the cron actually produces per docs/tech-architecture.md §16.
//
// US-036 extends this screen with per-platform pull-to-refresh that calls
// the metrics-refresh edge function. On 429 we surface the server's
// retry_after_sec as "Try again in Xh Ym". On success we optimistically
// bump `last_refreshed_at` locally and subscribe to metric_snapshots
// inserts so webhook-driven denorm updates roll in without a reload.

type SocialPlatform = Database['public']['Enums']['platform'];
type SocialLink = Database['public']['Tables']['social_links']['Row'];
type CreatorProfileRow = Database['public']['Tables']['creator_profiles']['Row'];
type MetricStatus = Database['public']['Enums']['metric_status'];
type SnapshotEntry = { status: MetricStatus; fetched_at: string };

const HANDLE_RE = /^[a-zA-Z0-9_.]{1,30}$/;
const PLATFORMS: readonly SocialPlatform[] = ['tiktok', 'instagram'];
const REFRESH_THRESHOLD = 64;
const REFRESH_MAX_DRAG = 140;

export default function CreatorProfile() {
  const { user, signOut } = useAuth();
  const { show: showToast } = useToast();

  const [profile, setProfile] = useState<CreatorProfileRow | null>(null);
  const [links, setLinks] = useState<SocialLink[]>([]);
  const [snapshotByLink, setSnapshotByLink] = useState<Map<string, SnapshotEntry>>(new Map());
  const [loading, setLoading] = useState(true);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [sheetPlatform, setSheetPlatform] = useState<SocialPlatform | null>(null);
  const [refreshingLinkId, setRefreshingLinkId] = useState<string | null>(null);
  // Synchronous lock — React state updates are async, so the useCallback
  // closure's refreshingLinkId can be stale if two gestures fire back-to-back.
  // A ref gives us a write-on-call guard that every subsequent invocation
  // observes immediately (Codebase Pattern #82 — same stale-capture rule
  // that applies to Reanimated worklets applies to rapid JS-side event
  // handlers too).
  const refreshLock = useRef(false);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const [profileRes, linksRes] = await Promise.all([
        supabase
          .from('creator_profiles')
          .select('*')
          .eq('user_id', user.id)
          .maybeSingle(),
        supabase
          .from('social_links')
          .select('*')
          .eq('user_id', user.id)
          .neq('status', 'unlinked'),
      ]);
      if (profileRes.error) throw profileRes.error;
      if (linksRes.error) throw linksRes.error;
      const linkRows = linksRes.data ?? [];
      const linkIds = linkRows.map((l) => l.id);
      const snapshotMap = new Map<string, SnapshotEntry>();
      if (linkIds.length > 0) {
        const snapsRes = await supabase
          .from('metric_snapshots')
          .select('social_link_id, status, fetched_at')
          .eq('is_latest', true)
          .in('social_link_id', linkIds);
        if (snapsRes.error) throw snapsRes.error;
        for (const row of snapsRes.data ?? []) {
          snapshotMap.set(row.social_link_id, {
            status: row.status,
            fetched_at: row.fetched_at,
          });
        }
      }
      setProfile(profileRes.data ?? null);
      setLinks(linkRows);
      setSnapshotByLink(snapshotMap);
    } catch (err) {
      console.error('Profile load failed', err);
      showToast({ message: 'Could not load profile.', variant: 'error' });
    } finally {
      setLoading(false);
    }
  }, [user, showToast]);

  useEffect(() => {
    void load();
  }, [load]);

  // Realtime: when the apify-webhook (or cron) inserts a fresh/stale
  // metric_snapshots row for one of this creator's linked handles, the
  // denorm trigger also updates creator_profiles — reload everything so
  // the "Last refreshed" stamp + the denorm metric counts roll forward.
  // Keyed on a stable string of sorted link ids to avoid resubscribing on
  // every setLinks reference flip.
  const linkIdKey = useMemo(
    () => links.map((l) => l.id).sort().join(','),
    [links],
  );

  useEffect(() => {
    if (!user || linkIdKey === '') return;
    const ids = linkIdKey.split(',');
    const token = getCachedToken();
    if (!token) return;
    let cancelled = false;
    let activeChannel: ReturnType<typeof supabase.channel> | null = null;
    // Realtime runs over a websocket — the marketifyFetch Authorization
    // wrapper in src/lib/supabase.ts only covers HTTP, so inject the JWT
    // into the Realtime client explicitly before subscribing. RLS then
    // applies metric_snapshots_self_read (us_035) to the stream.
    void supabase.realtime.setAuth(token).then(() => {
      if (cancelled) return;
      activeChannel = supabase
        .channel(`creator-metrics-${user.id}`)
        .on(
          'postgres_changes',
          {
            event: 'INSERT',
            schema: 'public',
            table: 'metric_snapshots',
            filter: `social_link_id=in.(${ids.join(',')})`,
          },
          (payload) => {
            const row = payload.new as { is_latest?: boolean; status?: MetricStatus };
            if (row.is_latest === true && (row.status === 'fresh' || row.status === 'stale')) {
              void load();
            }
          },
        )
        .subscribe();
    });
    return () => {
      cancelled = true;
      if (activeChannel) void supabase.removeChannel(activeChannel);
    };
  }, [user, linkIdKey, load]);

  const onRefresh = useCallback(
    async (link: SocialLink) => {
      if (refreshLock.current) return;
      refreshLock.current = true;
      setRefreshingLinkId(link.id);
      try {
        const { data, error } = await supabase.functions.invoke<{
          status?: 'queued' | 'already_fresh';
        }>('metrics-refresh', { body: { social_link_id: link.id } });
        if (error) {
          const ctx = (error as { context?: unknown }).context;
          if (
            ctx &&
            typeof ctx === 'object' &&
            'status' in ctx &&
            typeof (ctx as { json?: unknown }).json === 'function'
          ) {
            const res = ctx as Response;
            let body: { error?: string; retry_after_sec?: number } = {};
            try {
              body = (await res.json()) as { error?: string; retry_after_sec?: number };
            } catch {
              // non-JSON body — fall through to generic toast
            }
            if (res.status === 429 && typeof body.retry_after_sec === 'number') {
              showToast({
                message: `Try again in ${formatRetryAfter(body.retry_after_sec)}`,
                variant: 'error',
              });
              return;
            }
            if (res.status === 422 && body.error === 'LINK_UNLINKED') {
              showToast({ message: 'Handle is no longer linked.', variant: 'error' });
              return;
            }
          }
          showToast({ message: 'Could not refresh metrics.', variant: 'error' });
          return;
        }
        if (data?.status === 'queued') {
          // Optimistic stamp so "Last refreshed" reads "just now" until the
          // Apify webhook lands and realtime triggers a reload. Scoped to
          // the queued path only — for `already_fresh` the server-side
          // fetched_at is already accurate (could be up to 6h old) and
          // bumping it would fake a fresh refresh on stale data.
          setSnapshotByLink((prev) => {
            const next = new Map(prev);
            const existing = next.get(link.id);
            next.set(link.id, {
              status: existing?.status ?? 'fresh',
              fetched_at: new Date().toISOString(),
            });
            return next;
          });
          showToast({ message: 'Refreshing metrics…', variant: 'success' });
        }
      } finally {
        refreshLock.current = false;
        setRefreshingLinkId(null);
      }
    },
    [showToast],
  );

  const sections = useMemo(() => {
    return PLATFORMS.map((platform) => {
      const link = links.find((l) => l.platform === platform) ?? null;
      const snap = link ? snapshotByLink.get(link.id) ?? null : null;
      const isStale = snap?.status === 'stale';
      const lastRefreshedAt = snap?.fetched_at ?? null;
      return { platform, link, isStale, lastRefreshedAt };
    });
  }, [links, snapshotByLink]);

  const onAdd = useCallback(
    async (platform: SocialPlatform, rawHandle: string) => {
      const handle = rawHandle.trim().replace(/^@+/, '').trim();
      if (!HANDLE_RE.test(handle)) {
        showToast({
          message: 'Handle must be letters, numbers, underscores, or dots.',
          variant: 'error',
        });
        return;
      }
      setPendingAction(`add:${platform}`);
      try {
        const { data, error } = await supabase.functions.invoke<{ social_link_id: string }>(
          'manage-social-link',
          { body: { action: 'add', platform, handle } },
        );
        if (error) {
          const ctx = (error as { context?: unknown }).context;
          if (
            ctx &&
            typeof ctx === 'object' &&
            'status' in ctx &&
            typeof (ctx as { json?: unknown }).json === 'function'
          ) {
            const res = ctx as Response;
            let body: { error?: string } = {};
            try {
              body = (await res.json()) as { error?: string };
            } catch {
              // non-JSON body — fall through to generic toast
            }
            if (res.status === 409 && body.error === 'ALREADY_LINKED') {
              showToast({
                message: `You already have a ${platformLabel(platform)} handle linked.`,
                variant: 'error',
              });
              return;
            }
            if (res.status === 409 && body.error === 'HANDLE_TAKEN') {
              showToast({
                message: 'That handle is already linked to another account.',
                variant: 'error',
              });
              return;
            }
          }
          showToast({ message: 'Could not add handle.', variant: 'error' });
          return;
        }
        if (!data?.social_link_id) {
          showToast({ message: 'Could not add handle.', variant: 'error' });
          return;
        }
        setSheetPlatform(null);
        showToast({
          message: `${platformLabel(platform)} handle added.`,
          variant: 'success',
        });
        await load();
      } finally {
        setPendingAction(null);
      }
    },
    [showToast, load],
  );

  const onUnlink = useCallback(
    async (link: SocialLink) => {
      setPendingAction(`unlink:${link.id}`);
      try {
        const { error } = await supabase.functions.invoke('manage-social-link', {
          body: { action: 'unlink', social_link_id: link.id },
        });
        if (error) {
          showToast({ message: 'Could not unlink handle.', variant: 'error' });
          return;
        }
        showToast({
          message: `${platformLabel(link.platform)} handle unlinked.`,
          variant: 'success',
        });
        await load();
      } finally {
        setPendingAction(null);
      }
    },
    [showToast, load],
  );

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <View style={styles.header}>
          <Text style={[textStyles.display, { color: colors.ink }]}>Profile</Text>
          {user ? (
            <Text style={[textStyles.mono, styles.usernameRow]}>@{user.username}</Text>
          ) : null}
        </View>

        {loading && profile === null ? (
          <View style={styles.loadingBlock}>
            <ActivityIndicator color={colors.ink} />
          </View>
        ) : (
          <View style={styles.sections}>
            {sections.map(({ platform, link, isStale, lastRefreshedAt }) => (
              <PlatformCard
                key={platform}
                platform={platform}
                link={link}
                profile={profile}
                isStale={isStale}
                lastRefreshedAt={lastRefreshedAt}
                pendingAction={pendingAction}
                refreshing={link !== null && refreshingLinkId === link.id}
                onOpenAdd={() => setSheetPlatform(platform)}
                onUnlink={onUnlink}
                onRefresh={onRefresh}
              />
            ))}
          </View>
        )}

        <View style={styles.signOutWrap}>
          <ButtonSecondary
            label="Sign out"
            onPress={signOut}
            accessibilityLabel="Sign out"
            testID="creator-signout"
          />
        </View>
      </ScrollView>

      <AddHandleSheet
        platform={sheetPlatform}
        onDismiss={() => setSheetPlatform(null)}
        onSubmit={onAdd}
        submitting={sheetPlatform !== null && pendingAction === `add:${sheetPlatform}`}
      />
    </SafeAreaView>
  );
}

type PlatformCardProps = {
  platform: SocialPlatform;
  link: SocialLink | null;
  profile: CreatorProfileRow | null;
  isStale: boolean;
  lastRefreshedAt: string | null;
  pendingAction: string | null;
  refreshing: boolean;
  onOpenAdd: () => void;
  onUnlink: (link: SocialLink) => void;
  onRefresh: (link: SocialLink) => void;
};

function PlatformCard({
  platform,
  link,
  profile,
  isStale,
  lastRefreshedAt,
  pendingAction,
  refreshing,
  onOpenAdd,
  onUnlink,
  onRefresh,
}: PlatformCardProps) {
  const { follower, avgViews } = extractMetrics(platform, profile);
  const lastRefreshedLabel = lastRefreshedAt
    ? formatRelativeTime(new Date(lastRefreshedAt))
    : 'Never';
  const unlinkLoading = link ? pendingAction === `unlink:${link.id}` : false;

  const cardBody = (
    <>
      <View style={styles.cardHeader}>
        <Text style={[textStyles.h2, { color: colors.ink }]}>{platformLabel(platform)}</Text>
        {isStale && link ? <StaleChip /> : null}
      </View>

      {link ? (
        <>
          <Text style={[textStyles.mono, styles.handleRow]}>@{link.handle}</Text>
          <View style={styles.metricsRow}>
            <Metric label="Followers" value={formatCount(follower)} />
            <Metric label="Avg views (last 10)" value={formatCount(avgViews)} />
          </View>
          <Text style={[textStyles.caption, styles.lastRefreshed]}>
            Last refreshed {lastRefreshedLabel}
          </Text>
          <View style={styles.cardAction}>
            <ButtonSecondary
              label="Unlink handle"
              onPress={() => onUnlink(link)}
              loading={unlinkLoading}
              disabled={unlinkLoading}
              accessibilityLabel={`Unlink ${platformLabel(platform)} handle`}
              testID={`unlink-${platform}`}
            />
          </View>
        </>
      ) : (
        <>
          <Text style={[textStyles.body, styles.emptyRow]}>
            No {platformLabel(platform)} handle linked.
          </Text>
          <View style={styles.cardAction}>
            <ButtonPrimary
              label={`Add ${platformLabel(platform)} handle`}
              onPress={onOpenAdd}
              accessibilityLabel={`Add ${platformLabel(platform)} handle`}
              testID={`add-${platform}`}
            />
          </View>
        </>
      )}
    </>
  );

  if (!link) {
    return <View style={styles.card}>{cardBody}</View>;
  }

  return (
    <RefreshablePlatformCard
      link={link}
      refreshing={refreshing}
      onRefresh={onRefresh}
      testID={`refresh-${platform}`}
    >
      {cardBody}
    </RefreshablePlatformCard>
  );
}

function RefreshablePlatformCard({
  link,
  refreshing,
  onRefresh,
  testID,
  children,
}: {
  link: SocialLink;
  refreshing: boolean;
  onRefresh: (link: SocialLink) => void;
  testID?: string;
  children: React.ReactNode;
}) {
  const reduced = useReducedMotion();
  const offset = useSharedValue(0);
  const locked = useSharedValue(false);

  useEffect(() => {
    locked.value = refreshing;
  }, [refreshing, locked]);

  const triggerRefresh = useCallback(() => {
    onRefresh(link);
  }, [onRefresh, link]);

  const pan = useMemo(
    () =>
      Gesture.Pan()
        // activeOffsetY: [positive, ∞] — only activate on a meaningful
        // DOWNWARD pull (> 15pt). Upward drags (negative translationY) and
        // short vertical wobbles fall through to the outer ScrollView's
        // native pan, so a normal page scroll doesn't accidentally trigger
        // a refresh. failOffsetX cancels the pan entirely when the user
        // is clearly swiping horizontally.
        .activeOffsetY([15, 9999])
        .failOffsetX([-20, 20])
        .onUpdate((e) => {
          if (locked.value) return;
          // Dampen past the threshold so the card resists further pull.
          const raw = Math.max(0, e.translationY);
          const damped =
            raw <= REFRESH_THRESHOLD
              ? raw
              : REFRESH_THRESHOLD + (raw - REFRESH_THRESHOLD) * 0.35;
          offset.value = Math.min(damped, REFRESH_MAX_DRAG);
        })
        .onEnd(() => {
          if (locked.value) return;
          if (offset.value >= REFRESH_THRESHOLD) {
            runOnJS(triggerRefresh)();
          }
          offset.value = withSpring(
            0,
            withReducedMotion<WithSpringConfig>(SPRING_SNAPPY, reduced),
          );
        })
        .onFinalize(() => {
          if (locked.value) return;
          offset.value = withSpring(
            0,
            withReducedMotion<WithSpringConfig>(SPRING_SNAPPY, reduced),
          );
        }),
    [reduced, offset, locked, triggerRefresh],
  );

  const cardStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: offset.value }],
  }));

  const spinnerStyle = useAnimatedStyle(() => {
    const progress = Math.min(1, offset.value / REFRESH_THRESHOLD);
    return {
      opacity: progress,
      transform: [{ scale: 0.9 + progress * 0.1 }],
    };
  });

  return (
    <View style={styles.refreshSlot} testID={testID}>
      <Animated.View
        pointerEvents="none"
        style={[styles.spinnerTrack, spinnerStyle]}
        accessible={false}
        importantForAccessibility="no"
      >
        <ActivityIndicator color={colors.ink} />
      </Animated.View>
      {refreshing ? (
        <View
          style={styles.spinnerLocked}
          accessible
          accessibilityRole="progressbar"
          accessibilityLabel="Refreshing metrics"
          testID={`${testID}-spinner`}
        >
          <ActivityIndicator color={colors.ink} />
        </View>
      ) : null}
      <GestureDetector gesture={pan}>
        <Animated.View style={[styles.card, cardStyle]}>{children}</Animated.View>
      </GestureDetector>
    </View>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metric}>
      <Text style={[textStyles.caption, { color: colors.ink70 }]}>{label}</Text>
      <Text style={[textStyles.h1, { color: colors.ink }]}>{value}</Text>
    </View>
  );
}

function StaleChip() {
  return (
    <View
      style={[styles.stalePill, shadows.hard]}
      accessible
      accessibilityLabel="Metrics are stale"
      testID="stale-chip"
    >
      <Text style={[textStyles.micro, { color: colors.warning }]} allowFontScaling={false}>
        Stale
      </Text>
    </View>
  );
}

function AddHandleSheet({
  platform,
  onDismiss,
  onSubmit,
  submitting,
}: {
  platform: SocialPlatform | null;
  onDismiss: () => void;
  onSubmit: (platform: SocialPlatform, handle: string) => void;
  submitting: boolean;
}) {
  const [value, setValue] = useState('');
  useEffect(() => {
    if (platform !== null) setValue('');
  }, [platform]);
  const normalized = value.trim().replace(/^@+/, '').trim();

  return (
    <BottomSheet
      visible={platform !== null}
      onDismiss={onDismiss}
      snapPoints={[0.5]}
      accessibilityLabel="Add handle"
    >
      {platform ? (
        <KeyboardAvoidingView
          behavior={RNPlatform.OS === 'ios' ? 'padding' : undefined}
          style={styles.sheetBody}
        >
          <Text style={[textStyles.h1, { color: colors.ink }]}>
            Add {platformLabel(platform)} handle
          </Text>
          <Text style={[textStyles.body, styles.sheetHint]}>
            We&apos;ll pull your latest stats on next refresh.
          </Text>
          <View style={[styles.inputWrap, shadows.hard]}>
            <TextInput
              value={value}
              onChangeText={setValue}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              placeholder={platform === 'tiktok' ? '@yourtiktok' : '@yourinsta'}
              placeholderTextColor={colors.ink40}
              style={[textStyles.mono, styles.input]}
              editable={!submitting}
              accessibilityLabel={`${platformLabel(platform)} handle`}
              testID={`sheet-handle-input-${platform}`}
            />
          </View>
          <ButtonPrimary
            label="Add handle"
            onPress={() => onSubmit(platform, value)}
            loading={submitting}
            disabled={submitting || normalized.length === 0}
            accessibilityLabel={`Add ${platformLabel(platform)} handle`}
            testID={`sheet-add-${platform}`}
          />
        </KeyboardAvoidingView>
      ) : null}
    </BottomSheet>
  );
}

function extractMetrics(
  platform: SocialPlatform,
  profile: CreatorProfileRow | null,
): { follower: number | null; avgViews: number | null } {
  if (!profile) return { follower: null, avgViews: null };
  if (platform === 'tiktok') {
    return {
      follower: profile.tiktok_follower_count,
      avgViews: profile.tiktok_avg_views_last_10,
    };
  }
  return {
    follower: profile.instagram_follower_count,
    avgViews: profile.instagram_avg_views_last_10,
  };
}

function platformLabel(p: SocialPlatform): string {
  return p === 'tiktok' ? 'TikTok' : 'Instagram';
}

function formatCount(n: number | null): string {
  if (n === null) return '—';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}m`;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.canvas,
  },
  scrollContent: {
    padding: spacing.base,
    gap: spacing.xl,
    paddingBottom: spacing.xxxl,
  },
  header: {
    gap: spacing.xs,
    paddingTop: spacing.base,
  },
  usernameRow: {
    color: colors.ink70,
  },
  loadingBlock: {
    alignItems: 'center',
    paddingVertical: spacing.xxl,
  },
  sections: {
    gap: spacing.base,
  },
  refreshSlot: {
    position: 'relative',
  },
  spinnerTrack: {
    position: 'absolute',
    top: -spacing.xxl,
    left: 0,
    right: 0,
    alignItems: 'center',
    justifyContent: 'center',
    height: spacing.xxl,
  },
  spinnerLocked: {
    position: 'absolute',
    top: -spacing.xxl,
    left: 0,
    right: 0,
    alignItems: 'center',
    justifyContent: 'center',
    height: spacing.xxl,
  },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.ink,
    borderWidth: 2,
    borderRadius: radii.card,
    padding: spacing.base,
    ...shadows.hard,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing.sm,
  },
  handleRow: {
    color: colors.ink,
    marginTop: spacing.sm,
  },
  metricsRow: {
    flexDirection: 'row',
    gap: spacing.xl,
    marginTop: spacing.md,
  },
  metric: {
    gap: spacing.xs,
  },
  lastRefreshed: {
    color: colors.ink70,
    marginTop: spacing.md,
  },
  emptyRow: {
    color: colors.ink70,
    marginTop: spacing.sm,
  },
  cardAction: {
    marginTop: spacing.md,
  },
  stalePill: {
    backgroundColor: colors.warningSoft,
    borderColor: colors.warning,
    borderWidth: 2,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
  },
  signOutWrap: {
    paddingTop: spacing.md,
  },
  sheetBody: {
    gap: spacing.base,
  },
  sheetHint: {
    color: colors.ink70,
  },
  inputWrap: {
    backgroundColor: colors.surface,
    borderRadius: radii.input,
    borderWidth: 2,
    borderColor: colors.ink,
  },
  input: {
    paddingHorizontal: spacing.base,
    paddingVertical: spacing.md,
    color: colors.ink,
    minHeight: 48,
  },
});

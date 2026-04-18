import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Keyboard,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { BottomSheet } from '@/components/primitives/BottomSheet';
import { ButtonPrimary, ButtonSecondary } from '@/components/primitives/Button';
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
//
// US-057 — pending rows are tappable; tap opens a ReviewApplicationSheet
// (bottom sheet, design.md §3.3). The sheet shows full creator metrics +
// pitch and exposes an optional "Note" field plus Approve / Reject
// buttons. Both buttons POST to the `decide-application` edge function.
//
// Approve flow:
//   1. POST { action:'approve', application_id, decision_note? }
//   2a. 200 {ok:true} → toast "Application approved", refresh list, close
//   2b. 200 {ok:false, drift:[...]} → close the review sheet and open the
//       OverrideEligibilityDialog (centered modal, design.md §5.2 — "modals
//       except confirmations are bottom sheets" + Codebase Pattern #129).
//   2c. Override "Approve anyway" → POST again with override_ineligible:true,
//       which skips eligibility AND skips the version pin per the
//       force-approve semantics in the RPC's docblock.
//
// Reject flow:
//   1. POST { action:'reject', application_id, decision_note? }
//   2. Toast "Application rejected", refresh list, close.
//
// LISTING_VERSION_CHANGED — surfaces a "Listing was updated" toast and
// re-loads. Same backstop as the creator-side ApplySheet.

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

type Drift = {
  metric: string;
  platform: 'tiktok' | 'instagram' | null;
  required: number | boolean;
  actual: number | boolean | null;
};

type DecideResponse = {
  ok?: boolean;
  status?: string;
  decided_at?: string;
  drift?: Drift[];
};

type DecideErrorBody = {
  error?: string;
  current_version_id?: string;
};

type OverrideContext = {
  row: Row;
  drift: Drift[];
  decisionNote: string | null;
};

export default function ListerInboxApplications() {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const { show: showToast } = useToast();

  const [segment, setSegment] = useState<Segment>('pending');
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reviewRow, setReviewRow] = useState<Row | null>(null);
  const [overrideContext, setOverrideContext] = useState<OverrideContext | null>(null);
  const [overrideSubmitting, setOverrideSubmitting] = useState(false);

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

  // Centralized decide invocation. Returns the parsed response so the
  // caller (review sheet vs override dialog) can branch on drift vs ok.
  // Keeping the network call here lets both surfaces share toast/refresh.
  const invokeDecide = useCallback(
    async (params: {
      applicationId: string;
      action: 'approve' | 'reject';
      decisionNote: string | null;
      override: boolean;
    }): Promise<
      | { kind: 'ok'; status: string }
      | { kind: 'drift'; drift: Drift[] }
      | { kind: 'failed' }
    > => {
      try {
        const { data, error: invokeError } = await supabase.functions.invoke<DecideResponse>(
          'decide-application',
          {
            body: {
              application_id: params.applicationId,
              action: params.action,
              ...(params.decisionNote ? { decision_note: params.decisionNote } : {}),
              ...(params.override ? { override_ineligible: true } : {}),
            },
          },
        );

        if (invokeError) {
          const body = await readDecideErrorBody(invokeError);
          if (body?.error === 'LISTING_VERSION_CHANGED') {
            showToast({
              message: 'Listing was updated. Refreshing.',
              variant: 'info',
            });
            await load();
            return { kind: 'failed' };
          }
          if (body?.error === 'NOT_PENDING') {
            showToast({
              message: 'This application was already decided.',
              variant: 'info',
            });
            await load();
            return { kind: 'failed' };
          }
          if (body?.error === 'APPLICATION_NOT_FOUND') {
            showToast({
              message: 'Application no longer exists.',
              variant: 'error',
            });
            await load();
            return { kind: 'failed' };
          }
          showToast({
            message: 'Could not save decision. Try again.',
            variant: 'error',
          });
          return { kind: 'failed' };
        }

        if (data && data.ok === false && Array.isArray(data.drift)) {
          return { kind: 'drift', drift: data.drift };
        }
        if (data?.ok && data.status) {
          return { kind: 'ok', status: data.status };
        }
        showToast({
          message: 'Could not save decision. Try again.',
          variant: 'error',
        });
        return { kind: 'failed' };
      } catch (err) {
        console.error('decide-application threw', err);
        showToast({
          message: 'Could not save decision. Try again.',
          variant: 'error',
        });
        return { kind: 'failed' };
      }
    },
    [showToast, load],
  );

  const handleDecide = useCallback(
    async (action: 'approve' | 'reject', decisionNote: string | null) => {
      const row = reviewRow;
      if (!row) return false;
      const result = await invokeDecide({
        applicationId: row.application_id,
        action,
        decisionNote,
        override: false,
      });
      if (result.kind === 'drift') {
        setReviewRow(null);
        setOverrideContext({ row, drift: result.drift, decisionNote });
        return true;
      }
      if (result.kind === 'ok') {
        showToast({
          message: action === 'approve' ? 'Application approved' : 'Application rejected',
          variant: action === 'approve' ? 'success' : 'info',
        });
        setReviewRow(null);
        await load();
        return true;
      }
      // 'failed' — toast + refresh already handled inside invokeDecide for
      // structured errors; close the sheet only when the underlying row is
      // no longer pending (load already ran), otherwise leave it open so
      // the lister can retry without re-tapping.
      return false;
    },
    [reviewRow, invokeDecide, showToast, load],
  );

  const handleOverrideConfirm = useCallback(async () => {
    const ctx = overrideContext;
    if (!ctx || overrideSubmitting) return;
    setOverrideSubmitting(true);
    const result = await invokeDecide({
      applicationId: ctx.row.application_id,
      action: 'approve',
      decisionNote: ctx.decisionNote,
      override: true,
    });
    setOverrideSubmitting(false);
    if (result.kind === 'ok') {
      showToast({ message: 'Application approved (override)', variant: 'success' });
      setOverrideContext(null);
      await load();
    } else if (result.kind === 'drift') {
      // The RPC skips the eligibility re-check on override, so getting
      // drift back here would mean the edge function ignored the override
      // flag — keep the dialog open so the user can cancel.
      console.warn('override path returned drift unexpectedly');
    } else {
      setOverrideContext(null);
    }
  }, [overrideContext, overrideSubmitting, invokeDecide, showToast, load]);

  const handleOverrideCancel = useCallback(() => {
    if (overrideSubmitting) return;
    setOverrideContext(null);
  }, [overrideSubmitting]);

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
                  <ApplicationInboxRow
                    key={row.application_id}
                    row={row}
                    onPress={
                      row.status === 'pending' ? () => setReviewRow(row) : undefined
                    }
                  />
                ))}
              </View>
            ))}
          </View>
        )}
      </ScrollView>

      <ReviewApplicationSheet
        row={reviewRow}
        onDismiss={() => setReviewRow(null)}
        onDecide={handleDecide}
      />

      <OverrideEligibilityDialog
        context={overrideContext}
        submitting={overrideSubmitting}
        onConfirm={handleOverrideConfirm}
        onCancel={handleOverrideCancel}
      />
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

function ApplicationInboxRow({ row, onPress }: { row: Row; onPress?: () => void }) {
  const pillStatus: StatusPillStatus =
    row.status === 'pending' || row.status === 'approved' || row.status === 'rejected'
      ? row.status
      : 'cancelled';
  const relative = formatRelativeTime(new Date(row.created_at));
  const pitch = row.cover_note?.trim() ?? '';

  const body = (
    <>
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
    </>
  );

  if (onPress) {
    return (
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityHint="Opens the review sheet"
        accessibilityLabel={`Application from ${row.creator_username}, ${pillStatus}, applied ${relative}`}
        style={[styles.card, shadows.hard]}
        testID={`application-${row.application_id}`}
      >
        {body}
      </Pressable>
    );
  }

  return (
    <View
      style={[styles.card, shadows.hard]}
      accessibilityLabel={`Application from ${row.creator_username}, ${pillStatus}, applied ${relative}`}
      testID={`application-${row.application_id}`}
    >
      {body}
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

// Client-side UX cap on decision_note. The server (decide-application
// edge function) accepts up to 2000 chars as an abuse limit; the inbox
// review sheet caps at 280 to keep the field UI-friendly. Same split as
// the cover_note caps in apply-to-listing (2000 server) vs ApplySheet
// (280 client) — the lower client number is the displayed counter.
const DECISION_NOTE_MAX_LEN = 280;
const OVERRIDE_CONFIRMATION_PHRASE = 'OVERRIDE';

type ReviewApplicationSheetProps = {
  row: Row | null;
  onDismiss: () => void;
  onDecide: (action: 'approve' | 'reject', decisionNote: string | null) => Promise<boolean>;
};

// US-057 — bottom-sheet review surface (design.md §3.3 — "modals except
// confirmations are bottom sheets"). Hosts the same metric block as the
// inbox row plus the full pitch (no clamp), an optional Note field, and
// Approve / Reject buttons. The sheet is the entry point for the override
// flow: when the parent's onDecide returns drift, the parent closes this
// sheet and opens the confirmation dialog instead.
function ReviewApplicationSheet({ row, onDismiss, onDecide }: ReviewApplicationSheetProps) {
  const [note, setNote] = useState('');
  const [pendingAction, setPendingAction] = useState<'approve' | 'reject' | null>(null);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  // Synchronous lock against rapid double-tap (Pattern #106). useState reads
  // in a callback can be stale across back-to-back invocations; a ref is
  // set before the first await.
  const submittingRef = useRef(false);

  // Reset whenever the sheet opens to a new row, so a half-typed note from
  // a prior review doesn't leak across application IDs.
  useEffect(() => {
    if (row) {
      setNote('');
      setPendingAction(null);
      submittingRef.current = false;
    }
  }, [row?.application_id, row]);

  // Same KAV workaround as ApplySheet (Pattern shared with US-042) — RN
  // Modal opens its own window so KeyboardAvoidingView can't measure
  // correctly. Listen to keyboard events and pad the bottom manually.
  useEffect(() => {
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEvt, (e) => {
      setKeyboardHeight(e.endCoordinates.height);
    });
    const hideSub = Keyboard.addListener(hideEvt, () => setKeyboardHeight(0));
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  const submit = useCallback(
    async (action: 'approve' | 'reject') => {
      if (submittingRef.current) return;
      submittingRef.current = true;
      setPendingAction(action);
      const trimmed = note.trim();
      const decisionNote = trimmed.length > 0 ? trimmed : null;
      try {
        await onDecide(action, decisionNote);
      } finally {
        submittingRef.current = false;
        setPendingAction(null);
      }
    },
    [note, onDecide],
  );

  if (!row) {
    return (
      <BottomSheet
        visible={false}
        onDismiss={onDismiss}
        accessibilityLabel="Review application"
      >
        <View />
      </BottomSheet>
    );
  }

  const relative = formatRelativeTime(new Date(row.created_at));
  const pitch = row.cover_note?.trim() ?? '';
  const submitting = pendingAction !== null;

  return (
    <BottomSheet
      visible={row !== null}
      onDismiss={submitting ? () => undefined : onDismiss}
      snapPoints={[0.85]}
      accessibilityLabel="Review application"
      testID="review-application-sheet"
    >
      <ScrollView
        contentContainerStyle={[styles.reviewScroll, { paddingBottom: keyboardHeight + spacing.lg }]}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={[textStyles.caption, { color: colors.ink70 }]}>
          Review application for
        </Text>
        <Text style={[textStyles.h1, { color: colors.ink }]} numberOfLines={2}>
          {row.listing_title}
        </Text>

        <View style={styles.reviewSection}>
          <Text style={[textStyles.h2, { color: colors.ink }]} numberOfLines={1}>
            @{row.creator_username}
          </Text>
          <Text style={[textStyles.caption, { color: colors.ink70 }]}>Applied {relative}</Text>
        </View>

        <View style={[styles.reviewSection, styles.metricsBlock]}>
          <MetricLine
            platform="TikTok"
            handle={row.tiktok_handle}
            primary={row.tiktok_follower_count}
            primaryLabel="followers"
            testID="review-metrics-tiktok"
          />
          <MetricLine
            platform="Instagram"
            handle={row.instagram_handle}
            primary={row.instagram_follower_count}
            primaryLabel="followers"
            secondary={row.instagram_avg_views_last_10}
            secondaryLabel="avg views"
            testID="review-metrics-ig"
          />
        </View>

        <View style={styles.reviewSection}>
          <Text style={[textStyles.caption, { color: colors.ink70 }]}>Pitch</Text>
          <Text style={[textStyles.body, { color: colors.ink }]} testID="review-pitch">
            {pitch.length > 0 ? pitch : 'No pitch provided.'}
          </Text>
        </View>

        <View style={styles.reviewSection}>
          <View style={styles.labelRow}>
            <Text style={[textStyles.caption, { color: colors.ink70 }]}>
              Note (optional)
            </Text>
            <Text
              style={[textStyles.caption, { color: colors.ink40 }]}
              testID="review-note-counter"
            >
              {note.length}/{DECISION_NOTE_MAX_LEN}
            </Text>
          </View>
          <View style={[styles.inputWrap, shadows.hard]}>
            <TextInput
              value={note}
              onChangeText={setNote}
              placeholder="Reason for rejection, or a welcome message…"
              placeholderTextColor={colors.ink40}
              multiline
              maxLength={DECISION_NOTE_MAX_LEN}
              editable={!submitting}
              style={[textStyles.body, styles.input]}
              accessibilityLabel="Decision note"
              testID="review-note-input"
            />
          </View>
        </View>

        <View style={styles.reviewActions}>
          <View style={styles.modalActionItem}>
            <ButtonSecondary
              label="Reject"
              onPress={() => void submit('reject')}
              disabled={submitting}
              loading={pendingAction === 'reject'}
              testID="review-reject"
            />
          </View>
          <View style={styles.modalActionItem}>
            <ButtonPrimary
              label="Approve"
              onPress={() => void submit('approve')}
              disabled={submitting}
              loading={pendingAction === 'approve'}
              testID="review-approve"
            />
          </View>
        </View>
      </ScrollView>
    </BottomSheet>
  );
}

type OverrideEligibilityDialogProps = {
  context: OverrideContext | null;
  submitting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

// US-057 §4.6 — centered confirmation modal (Pattern #129) for force-
// approving a creator who no longer meets the listing's pre-conditions.
// Lists the specific conditions that drifted so the lister knows exactly
// what they're overriding before tapping "Approve anyway".
//
// Typed confirmation gate per docs/design.md §4.6 — the lister must type
// "OVERRIDE" before the confirm button enables. This is intentional
// friction: overrides bypass the listing's pre-conditions, are auditable,
// and must not be a single accidental tap.
function OverrideEligibilityDialog({
  context,
  submitting,
  onConfirm,
  onCancel,
}: OverrideEligibilityDialogProps) {
  const visible = context !== null;
  const [confirmText, setConfirmText] = useState('');
  // Reset the typed confirmation each time a new override context opens.
  // Keying on the application id (not the context object identity) keeps
  // the input stable while the same dialog is mounted.
  const contextKey = context?.row.application_id ?? null;
  useEffect(() => {
    setConfirmText('');
  }, [contextKey]);
  const confirmReady = confirmText.trim() === OVERRIDE_CONFIRMATION_PHRASE;
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={onCancel}
      testID="override-eligibility-modal"
    >
      <View style={styles.modalRoot}>
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={submitting ? undefined : onCancel}
          accessible={false}
          importantForAccessibility="no"
        />
        <View
          style={[styles.modalCard, shadows.hard]}
          accessibilityViewIsModal
          accessibilityLabel="Confirm override approval"
        >
          <Text style={[textStyles.h2, styles.modalTitle]} maxFontSizeMultiplier={1.3}>
            Approve anyway?
          </Text>
          <Text style={[textStyles.body, styles.modalBody]} maxFontSizeMultiplier={1.3}>
            This creator no longer meets:
          </Text>
          <View style={styles.driftList} testID="override-drift-list">
            {(context?.drift ?? []).map((d, i) => (
              <Text
                key={`${d.metric}-${d.platform ?? 'any'}-${i}`}
                style={[textStyles.body, { color: colors.ink }]}
                testID={`override-drift-${i}`}
              >
                • {driftLabel(d)}
              </Text>
            ))}
          </View>
          <View>
            <Text
              style={[textStyles.caption, styles.modalBody, { marginBottom: spacing.xs }]}
              maxFontSizeMultiplier={1.3}
            >
              Type {OVERRIDE_CONFIRMATION_PHRASE} to confirm
            </Text>
            <View style={[styles.confirmInputWrap, shadows.hard]}>
              <TextInput
                value={confirmText}
                onChangeText={setConfirmText}
                placeholder={OVERRIDE_CONFIRMATION_PHRASE}
                placeholderTextColor={colors.ink40}
                autoCapitalize="characters"
                autoCorrect={false}
                editable={!submitting}
                style={[textStyles.body, styles.confirmInput]}
                accessibilityLabel={`Type ${OVERRIDE_CONFIRMATION_PHRASE} to confirm override`}
                testID="override-confirm-input"
              />
            </View>
          </View>
          <View style={styles.modalActions}>
            <View style={styles.modalActionItem}>
              <ButtonSecondary
                label="Cancel"
                onPress={onCancel}
                disabled={submitting}
                testID="override-cancel"
              />
            </View>
            <View style={styles.modalActionItem}>
              <ButtonPrimary
                label="Approve anyway"
                onPress={onConfirm}
                loading={submitting}
                disabled={submitting || !confirmReady}
                testID="override-confirm"
              />
            </View>
          </View>
        </View>
      </View>
    </Modal>
  );
}

// Same shape as the ApplySheet's drift labelling — keep them in sync so
// the lister and creator see consistent metric names. Numeric thresholds
// render as "need X, have Y"; bool thresholds render as "needs verified".
function driftLabel(d: Drift): string {
  const platform = d.platform ? platformLabel(d.platform) : '';
  const base = metricLabel(d.metric);
  const head = platform ? `${platform} ${base}` : base;
  if (typeof d.required === 'boolean') {
    return d.required ? `${head} (required)` : head;
  }
  const have = typeof d.actual === 'number'
    ? formatCount(d.actual)
    : d.actual === null
    ? '—'
    : String(d.actual);
  return `${head}: need ${formatCount(d.required)}, have ${have}`;
}

function platformLabel(p: 'tiktok' | 'instagram'): string {
  return p === 'tiktok' ? 'TikTok' : 'Instagram';
}

function metricLabel(metric: string): string {
  switch (metric) {
    case 'min_followers':
      return 'minimum followers';
    case 'min_avg_views_last_n':
      return 'avg views (last 10)';
    case 'min_total_likes':
      return 'total likes';
    case 'min_videos_posted':
      return 'videos posted';
    case 'verified_only':
      return 'verified account';
    default:
      return metric;
  }
}

// Decode the structured error body that supabase-js wraps inside a
// FunctionsHttpError. Same decoder shape as ApplySheet (Pattern #98).
async function readDecideErrorBody(error: unknown): Promise<DecideErrorBody | null> {
  const ctx = (error as { context?: unknown }).context;
  if (
    !ctx ||
    typeof ctx !== 'object' ||
    !('status' in ctx) ||
    typeof (ctx as { json?: unknown }).json !== 'function'
  ) {
    return null;
  }
  try {
    return (await (ctx as Response).json()) as DecideErrorBody;
  } catch {
    return null;
  }
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
  reviewScroll: {
    gap: spacing.md,
    paddingVertical: spacing.sm,
  },
  reviewSection: {
    gap: spacing.xs,
  },
  reviewActions: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  labelRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
  },
  inputWrap: {
    backgroundColor: colors.surface,
    borderColor: colors.ink,
    borderWidth: 2,
    borderRadius: radii.input,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    minHeight: 88,
  },
  input: {
    color: colors.ink,
    minHeight: 80,
    textAlignVertical: 'top',
  },
  modalRoot: {
    flex: 1,
    backgroundColor: `${colors.ink}73`,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.base,
  },
  modalCard: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: colors.surface,
    borderRadius: radii.card,
    borderWidth: 2,
    borderColor: colors.ink,
    padding: spacing.lg,
    gap: spacing.md,
  },
  modalTitle: { color: colors.ink },
  modalBody: { color: colors.ink70 },
  driftList: {
    gap: spacing.xs,
    paddingLeft: spacing.xs,
  },
  modalActions: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  modalActionItem: { flex: 1 },
  confirmInputWrap: {
    backgroundColor: colors.surface,
    borderColor: colors.ink,
    borderWidth: 2,
    borderRadius: radii.input,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  confirmInput: {
    color: colors.ink,
    paddingVertical: spacing.xs,
  },
});

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Keyboard,
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Check, ChevronLeft, X } from 'lucide-react-native';
import { WebView } from 'react-native-webview';
import { ButtonPrimary, ButtonSecondary } from '@/components/primitives/Button';
import { StatusPill, type StatusPillStatus } from '@/components/primitives/StatusPill';
import { useToast } from '@/components/primitives/Toast';
import { colors, radii, shadows, spacing } from '@/design/tokens';
import { fontFamilies, textStyles } from '@/design/typography';
import { supabase } from '@/lib/supabase';
import { formatRelativeTime } from '@/lib/time';
import type { Database } from '@/types/supabase';

// US-059 — Lister submission review screen. Reached from the Submissions
// inbox row tap (US-058 list → /(lister)/inbox/submissions/[id]).
//
// Data: a single round trip to `get_submission_for_lister_review`
// (companion migration `us_059_get_submission_for_lister_review_rpc`).
// The RPC is SECURITY DEFINER + ownership-gated and returns the
// submission base + parent application id + listing context + creator
// username + active TikTok/Instagram handles + the first
// submission_video + the listing CURRENT version's post-conditions
// packed as a jsonb array. One trip vs. four PostgREST round trips
// (Codebase Pattern #117 / #119).
//
// Embedded video: react-native-webview pointed at the platform's embed
// URL. TikTok: `https://www.tiktok.com/embed/v2/{external_id}`.
// Instagram: `https://www.instagram.com/p/{external_id}/embed`. Both
// work for the canonical IDs the submit-video edge function captures;
// shortlink submissions where external_id is null fall back to a
// "Open in app" card pointing at the raw URL.
//
// Checklist (design.md §4.6, ConditionChecklist `mode='review'`):
// 3-state cycling per row — unreviewed (☐) → passes (✓) → fails (✗) →
// unreviewed. The lister mentally evaluates each post-condition against
// the embedded video; the rules are subjective ("did the creator say
// cruelty-free?" can't be machine-checked) so we trust the lister's
// ticks. State is local-only; we never persist per-condition results.
//
// Decide flow:
//   1. Approve with no ✗ rows → POST { action:'approve', decision_note }.
//   2. Approve with any ✗ row → open OverrideEligibilityDialog
//      (centered modal, design.md §5.2 + Pattern #129). Lister types
//      "OVERRIDE" + a reason → POST with override_ineligible:true +
//      override_reason. Persists override_by_user_id +
//      override_reason on the submission row (audit trail).
//   3. Reject → POST { action:'reject', decision_note }. The override
//      dialog never opens for a reject; even ✗ rows are just data points.
//
// Already-decided submissions (status != 'pending') render in read-only
// mode: header pill, embedded video, the original decision note +
// decided_at timestamp. No checklist, no buttons. Avoids the "decide
// twice" trap when a stale list row is tapped after another lister
// session decided the row.

type SubmissionStatus = Database['public']['Enums']['submission_status'];
type Platform_ = Database['public']['Enums']['platform'];

type PostConditionRaw = {
  id: string;
  metric: string;
  operator: string;
  numeric_threshold: number | null;
  text_threshold: string | null;
  bool_threshold: boolean | null;
  platform: Platform_ | null;
};

type ReviewRow = {
  submission_id: string;
  status: SubmissionStatus;
  created_at: string;
  decided_at: string | null;
  decision_note: string | null;
  cover_note: string | null;
  application_id: string;
  listing_id: string;
  listing_title: string | null;
  creator_user_id: string;
  creator_username: string | null;
  tiktok_handle: string | null;
  instagram_handle: string | null;
  video_url: string | null;
  video_platform: Platform_ | null;
  video_external_id: string | null;
  post_conditions: PostConditionRaw[];
};

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; code: 'not_found' | 'generic' }
  | { kind: 'ok'; row: ReviewRow };

// Three-state cycle — undefined means unreviewed; true = passes; false = fails.
type CheckState = true | false | undefined;

const FEEDBACK_MAX_LEN = 240;
const OVERRIDE_REASON_MAX_LEN = 240;
const OVERRIDE_CONFIRMATION_PHRASE = 'OVERRIDE';

export default function SubmissionReviewScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { show: showToast } = useToast();

  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [checks, setChecks] = useState<Record<string, CheckState>>({});
  const [feedback, setFeedback] = useState('');
  const [pendingAction, setPendingAction] = useState<'approve' | 'reject' | null>(null);
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [overrideReason, setOverrideReason] = useState('');
  const [overrideSubmitting, setOverrideSubmitting] = useState(false);
  // Synchronous lock against rapid double-tap (Pattern #106).
  const submittingRef = useRef(false);

  const load = useCallback(async () => {
    if (!id) {
      setState({ kind: 'error', code: 'not_found' });
      return;
    }
    setState({ kind: 'loading' });
    const { data, error } = await supabase.rpc('get_submission_for_lister_review', {
      p_submission_id: id,
    });
    if (error) {
      console.error('get_submission_for_lister_review failed', error);
      setState({ kind: 'error', code: 'generic' });
      return;
    }
    const row = parseReviewRow(data);
    if (!row) {
      // Either the submission doesn't exist or the caller doesn't own
      // the listing — both surface as null from the RPC, both render as
      // not_found to avoid leaking ownership information.
      setState({ kind: 'error', code: 'not_found' });
      return;
    }
    setState({ kind: 'ok', row });
    setChecks(Object.fromEntries(row.post_conditions.map((c) => [c.id, undefined])));
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const onBack = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/(lister)/inbox');
  }, []);

  const cycleCheck = useCallback((conditionId: string) => {
    setChecks((cur) => {
      const next = { ...cur };
      const v = cur[conditionId];
      next[conditionId] = v === undefined ? true : v === true ? false : undefined;
      return next;
    });
  }, []);

  const failingLabels = useMemo<string[]>(() => {
    if (state.kind !== 'ok') return [];
    return state.row.post_conditions
      .filter((c) => checks[c.id] === false)
      .map((c) => postConditionLabel(c));
  }, [state, checks]);
  const failingCount = failingLabels.length;

  const decisionNoteOrNull = useCallback((): string | null => {
    const trimmed = feedback.trim();
    return trimmed.length > 0 ? trimmed : null;
  }, [feedback]);

  // POST to the decide-submission edge function and route the response.
  const invokeDecide = useCallback(
    async (params: {
      action: 'approve' | 'reject';
      decisionNote: string | null;
      override: boolean;
      overrideReason: string | null;
    }): Promise<{ ok: boolean; status?: SubmissionStatus }> => {
      if (state.kind !== 'ok') return { ok: false };
      try {
        const { data, error: invokeError } = await supabase.functions.invoke<{
          ok?: boolean;
          status?: SubmissionStatus;
          decided_at?: string;
        }>('decide-submission', {
          body: {
            submission_id: state.row.submission_id,
            action: params.action,
            ...(params.decisionNote ? { decision_note: params.decisionNote } : {}),
            ...(params.override
              ? {
                  override_ineligible: true,
                  ...(params.overrideReason
                    ? { override_reason: params.overrideReason }
                    : {}),
                }
              : {}),
          },
        });
        if (invokeError) {
          const body = await readDecideErrorBody(invokeError);
          if (body?.error === 'NOT_PENDING') {
            showToast({
              message: 'This submission was already decided.',
              variant: 'info',
            });
            await load();
            return { ok: false };
          }
          if (body?.error === 'SUBMISSION_NOT_FOUND') {
            showToast({
              message: 'Submission no longer exists.',
              variant: 'error',
            });
            setTimeout(onBack, 350);
            return { ok: false };
          }
          if (body?.error === 'OVERRIDE_REASON_REQUIRED') {
            showToast({
              message: 'Type a reason for the override before approving.',
              variant: 'error',
            });
            return { ok: false };
          }
          showToast({
            message: 'Could not save decision. Try again.',
            variant: 'error',
          });
          return { ok: false };
        }
        if (data?.ok && data.status) {
          return { ok: true, status: data.status };
        }
        showToast({
          message: 'Could not save decision. Try again.',
          variant: 'error',
        });
        return { ok: false };
      } catch (err) {
        console.error('decide-submission threw', err);
        showToast({
          message: 'Could not save decision. Try again.',
          variant: 'error',
        });
        return { ok: false };
      }
    },
    [state, showToast, load, onBack],
  );

  const onApprove = useCallback(async () => {
    if (submittingRef.current || state.kind !== 'ok') return;
    if (failingCount > 0) {
      // Open the override dialog — the lister marked rows as failing,
      // approving from here is the typed-OVERRIDE path.
      setOverrideReason('');
      setOverrideOpen(true);
      return;
    }
    submittingRef.current = true;
    setPendingAction('approve');
    const res = await invokeDecide({
      action: 'approve',
      decisionNote: decisionNoteOrNull(),
      override: false,
      overrideReason: null,
    });
    submittingRef.current = false;
    setPendingAction(null);
    if (res.ok) {
      showToast({ message: 'Submission approved', variant: 'success' });
      setTimeout(onBack, 350);
    }
  }, [state, failingCount, invokeDecide, decisionNoteOrNull, showToast, onBack]);

  const onReject = useCallback(async () => {
    if (submittingRef.current || state.kind !== 'ok') return;
    submittingRef.current = true;
    setPendingAction('reject');
    const res = await invokeDecide({
      action: 'reject',
      decisionNote: decisionNoteOrNull(),
      override: false,
      overrideReason: null,
    });
    submittingRef.current = false;
    setPendingAction(null);
    if (res.ok) {
      showToast({ message: 'Submission rejected', variant: 'info' });
      setTimeout(onBack, 350);
    }
  }, [state, invokeDecide, decisionNoteOrNull, showToast, onBack]);

  const onOverrideConfirm = useCallback(async () => {
    // Synchronous double-tap guard: `overrideSubmitting` is async state and
    // a fast double-tap can fire both invocations before the first re-render
    // flips the disabled flag. The ref short-circuits the second call.
    if (submittingRef.current || overrideSubmitting || state.kind !== 'ok') return;
    const reason = overrideReason.trim();
    if (reason.length === 0) return;
    submittingRef.current = true;
    setOverrideSubmitting(true);
    const res = await invokeDecide({
      action: 'approve',
      decisionNote: decisionNoteOrNull(),
      override: true,
      overrideReason: reason,
    });
    submittingRef.current = false;
    setOverrideSubmitting(false);
    if (res.ok) {
      setOverrideOpen(false);
      showToast({ message: 'Submission approved (override)', variant: 'success' });
      setTimeout(onBack, 350);
    }
  }, [
    overrideSubmitting,
    state,
    overrideReason,
    invokeDecide,
    decisionNoteOrNull,
    showToast,
    onBack,
  ]);

  const onOverrideCancel = useCallback(() => {
    if (overrideSubmitting) return;
    setOverrideOpen(false);
  }, [overrideSubmitting]);

  return (
    <SafeAreaView style={styles.container}>
      <Header onBack={onBack} />
      {state.kind === 'loading' ? (
        <View style={styles.centered}>
          <ActivityIndicator color={colors.ink} />
        </View>
      ) : state.kind === 'error' ? (
        <ErrorBody code={state.code} onBack={onBack} />
      ) : (
        <>
          <ScrollView
            contentContainerStyle={styles.scrollContent}
            keyboardShouldPersistTaps="handled"
          >
            <HeroCard row={state.row} />
            <VideoEmbed row={state.row} />
            {state.row.cover_note ? (
              <CoverNoteSection note={state.row.cover_note} />
            ) : null}
            {state.row.status !== 'pending' ? (
              <DecidedSummary row={state.row} />
            ) : (
              <>
                {state.row.post_conditions.length > 0 ? (
                  <ChecklistSection
                    conditions={state.row.post_conditions}
                    checks={checks}
                    onCycle={cycleCheck}
                  />
                ) : null}
                <FeedbackSection value={feedback} onChange={setFeedback} />
              </>
            )}
          </ScrollView>
          {state.row.status === 'pending' ? (
            <View style={styles.footer}>
              <View style={styles.footerActions}>
                <View style={styles.actionItem}>
                  <ButtonSecondary
                    label="Reject"
                    onPress={onReject}
                    disabled={pendingAction !== null}
                    loading={pendingAction === 'reject'}
                    testID="submission-reject"
                  />
                </View>
                <View style={styles.actionItem}>
                  <ButtonPrimary
                    label="Approve"
                    onPress={onApprove}
                    disabled={pendingAction !== null}
                    loading={pendingAction === 'approve'}
                    testID="submission-approve"
                  />
                </View>
              </View>
            </View>
          ) : null}
        </>
      )}
      <OverrideEligibilityDialog
        visible={overrideOpen}
        failingLabels={failingLabels}
        reason={overrideReason}
        onChangeReason={setOverrideReason}
        submitting={overrideSubmitting}
        onConfirm={onOverrideConfirm}
        onCancel={onOverrideCancel}
      />
    </SafeAreaView>
  );
}

function Header({ onBack }: { onBack: () => void }) {
  return (
    <View style={styles.header}>
      <Pressable
        onPress={onBack}
        hitSlop={spacing.md}
        accessibilityRole="button"
        accessibilityLabel="Back"
        testID="submission-back"
      >
        <ChevronLeft color={colors.ink} size={28} strokeWidth={2.5} />
      </Pressable>
      <Text style={[textStyles.h2, { color: colors.ink }]}>Review submission</Text>
      <View style={styles.headerSpacer} />
    </View>
  );
}

function ErrorBody({
  code,
  onBack,
}: {
  code: 'not_found' | 'generic';
  onBack: () => void;
}) {
  const copy =
    code === 'not_found'
      ? 'This submission is no longer available.'
      : 'Could not load this submission. Try again in a moment.';
  return (
    <View style={styles.centered}>
      <Text style={[textStyles.h1, { color: colors.ink, textAlign: 'center' }]}>
        Can&apos;t open
      </Text>
      <Text
        style={[
          textStyles.body,
          { color: colors.ink70, textAlign: 'center', marginTop: spacing.sm },
        ]}
      >
        {copy}
      </Text>
      <View style={{ marginTop: spacing.xl, minWidth: 180 }}>
        <ButtonPrimary label="Back" onPress={onBack} testID="submission-error-back" />
      </View>
    </View>
  );
}

function HeroCard({ row }: { row: ReviewRow }) {
  const pillStatus: StatusPillStatus =
    row.status === 'pending' || row.status === 'approved' || row.status === 'rejected'
      ? row.status
      : 'pending';
  const relative = formatRelativeTime(new Date(row.created_at));
  const handle = row.video_platform === 'tiktok' ? row.tiktok_handle : row.instagram_handle;
  return (
    <View style={[styles.heroCard, shadows.hard]} testID="submission-hero">
      <View style={styles.heroTopRow}>
        <Text style={[textStyles.display, { color: colors.ink }]} numberOfLines={2}>
          {row.listing_title ?? 'Untitled campaign'}
        </Text>
        <StatusPill status={pillStatus} />
      </View>
      <View style={styles.heroMeta}>
        <Text style={[textStyles.caption, { color: colors.ink70 }]}>From</Text>
        <Text style={styles.handleText} numberOfLines={1}>
          @{row.creator_username ?? 'unknown'}
        </Text>
        {handle ? (
          <Text style={[textStyles.caption, { color: colors.ink70 }]} numberOfLines={1}>
            · posted as @{handle}
          </Text>
        ) : null}
      </View>
      <Text style={[textStyles.caption, { color: colors.ink70 }]}>Submitted {relative}</Text>
    </View>
  );
}

function VideoEmbed({ row }: { row: ReviewRow }) {
  const embedUrl = useMemo(() => buildEmbedUrl(row), [row]);

  if (!embedUrl) {
    return (
      <View style={[styles.fallbackCard, shadows.hard]} testID="submission-video-fallback">
        <Text style={[textStyles.h2, { color: colors.ink }]}>Video preview unavailable</Text>
        <Text style={[textStyles.caption, { color: colors.ink70 }]}>
          {row.video_url
            ? 'This URL can\u2019t be embedded. Open it in the platform app to review.'
            : 'No video URL was attached to this submission.'}
        </Text>
        {row.video_url ? (
          <Text
            style={[textStyles.body, { color: colors.primaryDeep }]}
            selectable
            testID="submission-video-url"
          >
            {row.video_url}
          </Text>
        ) : null}
      </View>
    );
  }

  return (
    <View style={[styles.videoFrame, shadows.hard]} testID="submission-video-embed">
      <WebView
        source={{ uri: embedUrl }}
        style={styles.video}
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        javaScriptEnabled
        domStorageEnabled
        scrollEnabled={false}
        startInLoadingState
        renderLoading={() => (
          <View style={styles.videoLoading}>
            <ActivityIndicator color={colors.ink} />
          </View>
        )}
        testID="submission-video-webview"
      />
    </View>
  );
}

// Build an embed URL from the captured platform + external_id. Both
// platforms accept the canonical embed paths; if external_id is null
// (rare — the submit-video pipeline normally captures it) we return null
// and the fallback card renders. We deliberately do NOT pass arbitrary
// video_url into a WebView — the canonical embed URL constants above
// avoid an open-redirect-ish vector and keep the iframe sandboxed to
// the platform's own embed page.
function buildEmbedUrl(row: ReviewRow): string | null {
  if (!row.video_external_id || !row.video_platform) return null;
  if (row.video_platform === 'tiktok') {
    return `https://www.tiktok.com/embed/v2/${encodeURIComponent(row.video_external_id)}`;
  }
  if (row.video_platform === 'instagram') {
    return `https://www.instagram.com/p/${encodeURIComponent(row.video_external_id)}/embed`;
  }
  return null;
}

function CoverNoteSection({ note }: { note: string }) {
  return (
    <View style={styles.section}>
      <Text style={[textStyles.h2, { color: colors.ink }]}>Creator note</Text>
      <View style={[styles.noteCard, shadows.hard]}>
        <Text style={[textStyles.body, { color: colors.ink }]}>{note}</Text>
      </View>
    </View>
  );
}

function ChecklistSection({
  conditions,
  checks,
  onCycle,
}: {
  conditions: PostConditionRaw[];
  checks: Record<string, CheckState>;
  onCycle: (id: string) => void;
}) {
  return (
    <View style={styles.section}>
      <Text style={[textStyles.h2, { color: colors.ink }]}>Post requirements</Text>
      <Text style={[textStyles.caption, { color: colors.ink70 }]}>
        {'Tap each row to mark passes (\u2713) or fails (\u2717). Failed rows trigger an override step before approving.'}
      </Text>
      <View style={styles.checklist}>
        {conditions.map((c) => (
          <ChecklistRow
            key={c.id}
            label={postConditionLabel(c)}
            value={checks[c.id]}
            onPress={() => onCycle(c.id)}
            testID={`review-checklist-${c.id}`}
          />
        ))}
      </View>
    </View>
  );
}

function ChecklistRow({
  label,
  value,
  onPress,
  testID,
}: {
  label: string;
  value: CheckState;
  onPress: () => void;
  testID?: string;
}) {
  const accLabel =
    value === true
      ? `${label}, marked passing`
      : value === false
        ? `${label}, marked failing`
        : `${label}, unreviewed`;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accLabel}
      style={[styles.checklistRow, shadows.hard]}
      testID={testID}
    >
      <CheckBox state={value} />
      <Text style={[textStyles.body, styles.checklistText]}>{label}</Text>
    </Pressable>
  );
}

function CheckBox({ state }: { state: CheckState }) {
  if (state === true) {
    return (
      <View style={[styles.checkbox, styles.checkboxPass]}>
        <Check color={colors.surface} size={16} strokeWidth={3} />
      </View>
    );
  }
  if (state === false) {
    return (
      <View style={[styles.checkbox, styles.checkboxFail]}>
        <X color={colors.surface} size={16} strokeWidth={3} />
      </View>
    );
  }
  return <View style={styles.checkbox} />;
}

function FeedbackSection({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <View style={styles.section}>
      <View style={styles.labelRow}>
        <Text style={[textStyles.h2, { color: colors.ink }]}>Feedback (optional)</Text>
        <Text style={[textStyles.caption, { color: colors.ink40 }]}>
          {value.length}/{FEEDBACK_MAX_LEN}
        </Text>
      </View>
      <View style={[styles.inputWrap, shadows.hard]}>
        <TextInput
          value={value}
          onChangeText={(next) => onChange(next.slice(0, FEEDBACK_MAX_LEN))}
          placeholder="Notes for the creator (shared with the decision)…"
          placeholderTextColor={colors.ink40}
          multiline
          maxLength={FEEDBACK_MAX_LEN}
          style={[textStyles.body, styles.input]}
          accessibilityLabel="Decision feedback"
          testID="submission-feedback"
        />
      </View>
    </View>
  );
}

function DecidedSummary({ row }: { row: ReviewRow }) {
  const decided = row.decided_at ? formatRelativeTime(new Date(row.decided_at)) : 'previously';
  const verb = row.status === 'approved' ? 'Approved' : 'Rejected';
  return (
    <View style={[styles.noteCard, shadows.hard]} testID="submission-decided-summary">
      <Text style={[textStyles.h2, { color: colors.ink }]}>
        {verb} {decided}
      </Text>
      {row.decision_note ? (
        <Text style={[textStyles.body, { color: colors.ink, marginTop: spacing.xs }]}>
          {row.decision_note}
        </Text>
      ) : (
        <Text
          style={[textStyles.caption, { color: colors.ink70, marginTop: spacing.xs }]}
        >
          No feedback recorded.
        </Text>
      )}
    </View>
  );
}

type OverrideEligibilityDialogProps = {
  visible: boolean;
  failingLabels: string[];
  reason: string;
  onChangeReason: (next: string) => void;
  submitting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

function OverrideEligibilityDialog({
  visible,
  failingLabels,
  reason,
  onChangeReason,
  submitting,
  onConfirm,
  onCancel,
}: OverrideEligibilityDialogProps) {
  const failingCount = failingLabels.length;
  const [confirmText, setConfirmText] = useState('');
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  useEffect(() => {
    if (visible) setConfirmText('');
  }, [visible]);

  // Modal opens its own native window — KeyboardAvoidingView can't measure
  // the inset, so we listen to keyboard events directly (same workaround
  // as the applications review sheet).
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

  const phraseReady = confirmText.trim() === OVERRIDE_CONFIRMATION_PHRASE;
  const reasonReady = reason.trim().length > 0;
  const confirmReady = phraseReady && reasonReady && !submitting;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={onCancel}
      testID="submission-override-modal"
    >
      <View style={[styles.modalRoot, { paddingBottom: keyboardHeight }]}>
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
          <Text style={[textStyles.h2, { color: colors.ink }]} maxFontSizeMultiplier={1.3}>
            Approve anyway?
          </Text>
          <Text style={[textStyles.body, { color: colors.ink70 }]} maxFontSizeMultiplier={1.3}>
            {failingCount} requirement{failingCount === 1 ? '' : 's'} marked failing.
            Approving now records an override.
          </Text>
          <View style={styles.failingList} testID="submission-override-failing-list">
            {failingLabels.map((label, i) => (
              <Text
                key={`${i}-${label}`}
                style={[textStyles.body, { color: colors.ink }]}
                testID={`submission-override-failing-${i}`}
              >
                {`\u2022 ${label}`}
              </Text>
            ))}
          </View>

          <View>
            <Text
              style={[textStyles.caption, { color: colors.ink70, marginBottom: spacing.xs }]}
              maxFontSizeMultiplier={1.3}
            >
              Reason for override
            </Text>
            <View style={[styles.inputWrap, shadows.hard]}>
              <TextInput
                value={reason}
                onChangeText={(next) => onChangeReason(next.slice(0, OVERRIDE_REASON_MAX_LEN))}
                placeholder="Why is this still OK to approve?"
                placeholderTextColor={colors.ink40}
                multiline
                maxLength={OVERRIDE_REASON_MAX_LEN}
                editable={!submitting}
                style={[textStyles.body, styles.input]}
                accessibilityLabel="Override reason"
                testID="submission-override-reason"
              />
            </View>
          </View>

          <View>
            <Text
              style={[textStyles.caption, { color: colors.ink70, marginBottom: spacing.xs }]}
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
                testID="submission-override-confirm-input"
              />
            </View>
          </View>

          <View style={styles.modalActions}>
            <View style={styles.actionItem}>
              <ButtonSecondary
                label="Cancel"
                onPress={onCancel}
                disabled={submitting}
                testID="submission-override-cancel"
              />
            </View>
            <View style={styles.actionItem}>
              <ButtonPrimary
                label="Approve anyway"
                onPress={onConfirm}
                loading={submitting}
                disabled={!confirmReady}
                testID="submission-override-confirm"
              />
            </View>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function postConditionLabel(c: PostConditionRaw): string {
  switch (c.metric) {
    case 'post_family_friendly':
      return c.bool_threshold
        ? 'Video is family-friendly.'
        : 'Mature content allowed (per the listing).';
    case 'post_must_mention':
      return c.text_threshold ?? 'Required content rule was followed.';
    case 'post_must_tag_account':
      return c.text_threshold
        ? `Tagged @${c.text_threshold.replace(/^@/, '')}.`
        : 'Tagged the lister account.';
    case 'post_min_video_duration_sec':
      return c.numeric_threshold !== null
        ? `Video is at least ${c.numeric_threshold}s long.`
        : 'Video meets the minimum duration.';
    case 'post_max_video_duration_sec':
      return c.numeric_threshold !== null
        ? `Video is at most ${c.numeric_threshold}s long.`
        : 'Video is within the maximum duration.';
    case 'post_min_video_count':
      return c.numeric_threshold !== null
        ? `At least ${c.numeric_threshold} videos posted.`
        : 'Required number of videos posted.';
    default:
      return c.metric;
  }
}

function parseReviewRow(raw: unknown): ReviewRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.submission_id !== 'string') return null;
  const status = r.status;
  if (status !== 'pending' && status !== 'approved' && status !== 'rejected') return null;
  return {
    submission_id: r.submission_id,
    status,
    created_at: typeof r.created_at === 'string' ? r.created_at : new Date(0).toISOString(),
    decided_at: typeof r.decided_at === 'string' ? r.decided_at : null,
    decision_note: typeof r.decision_note === 'string' ? r.decision_note : null,
    cover_note:
      typeof r.cover_note === 'string' && r.cover_note.trim().length > 0
        ? r.cover_note
        : null,
    application_id: typeof r.application_id === 'string' ? r.application_id : '',
    listing_id: typeof r.listing_id === 'string' ? r.listing_id : '',
    listing_title: typeof r.listing_title === 'string' ? r.listing_title : null,
    creator_user_id: typeof r.creator_user_id === 'string' ? r.creator_user_id : '',
    creator_username:
      typeof r.creator_username === 'string' ? r.creator_username : null,
    tiktok_handle: typeof r.tiktok_handle === 'string' ? r.tiktok_handle : null,
    instagram_handle:
      typeof r.instagram_handle === 'string' ? r.instagram_handle : null,
    video_url: typeof r.video_url === 'string' ? r.video_url : null,
    video_platform:
      r.video_platform === 'tiktok' || r.video_platform === 'instagram'
        ? r.video_platform
        : null,
    video_external_id:
      typeof r.video_external_id === 'string' ? r.video_external_id : null,
    post_conditions: parsePostConditions(r.post_conditions),
  };
}

function parsePostConditions(raw: unknown): PostConditionRaw[] {
  if (!Array.isArray(raw)) return [];
  const out: PostConditionRaw[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.id !== 'string' || typeof e.metric !== 'string') continue;
    out.push({
      id: e.id,
      metric: e.metric,
      operator: typeof e.operator === 'string' ? e.operator : '',
      numeric_threshold:
        typeof e.numeric_threshold === 'number' ? e.numeric_threshold : null,
      text_threshold:
        typeof e.text_threshold === 'string' ? e.text_threshold : null,
      bool_threshold:
        typeof e.bool_threshold === 'boolean' ? e.bool_threshold : null,
      platform:
        e.platform === 'tiktok' || e.platform === 'instagram' ? e.platform : null,
    });
  }
  return out;
}

// Decode the structured error body that supabase-js wraps inside a
// FunctionsHttpError. Same decoder shape as the applications review sheet.
async function readDecideErrorBody(error: unknown): Promise<{ error?: string } | null> {
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
    return (await (ctx as Response).json()) as { error?: string };
  } catch {
    return null;
  }
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.canvas },
  header: {
    paddingHorizontal: spacing.base,
    paddingVertical: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: 2,
    borderBottomColor: colors.ink,
    backgroundColor: colors.canvas,
  },
  headerSpacer: { width: 28 },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
  },
  scrollContent: {
    padding: spacing.base,
    paddingBottom: spacing.xxxl * 2,
    gap: spacing.lg,
  },
  heroCard: {
    backgroundColor: colors.surface,
    borderColor: colors.ink,
    borderWidth: 2,
    borderRadius: radii.card,
    padding: spacing.base,
    gap: spacing.sm,
  },
  heroTopRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'flex-start',
    justifyContent: 'space-between',
  },
  heroMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    flexWrap: 'wrap',
  },
  handleText: {
    fontFamily: fontFamilies.mono,
    fontSize: 14,
    lineHeight: 20,
    color: colors.ink,
  },
  videoFrame: {
    backgroundColor: colors.ink,
    borderColor: colors.ink,
    borderWidth: 2,
    borderRadius: radii.card,
    overflow: 'hidden',
    aspectRatio: 9 / 16,
  },
  video: { flex: 1, backgroundColor: colors.ink },
  videoLoading: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
  },
  fallbackCard: {
    backgroundColor: colors.surface,
    borderColor: colors.ink,
    borderWidth: 2,
    borderRadius: radii.card,
    padding: spacing.base,
    gap: spacing.xs,
  },
  section: { gap: spacing.sm },
  noteCard: {
    backgroundColor: colors.surface,
    borderColor: colors.ink,
    borderWidth: 2,
    borderRadius: radii.card,
    padding: spacing.base,
  },
  checklist: { gap: spacing.sm },
  checklistRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderColor: colors.ink,
    borderWidth: 2,
    borderRadius: radii.card,
    padding: spacing.md,
  },
  checkbox: {
    width: 28,
    height: 28,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: colors.ink,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxPass: { backgroundColor: colors.success },
  checkboxFail: { backgroundColor: colors.danger },
  checklistText: { flex: 1, color: colors.ink },
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
  input: { color: colors.ink, minHeight: 80, textAlignVertical: 'top' },
  footer: {
    padding: spacing.base,
    backgroundColor: colors.canvas,
    borderTopWidth: 2,
    borderTopColor: colors.ink,
  },
  footerActions: { flexDirection: 'row', gap: spacing.sm },
  actionItem: { flex: 1 },
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
  failingList: { gap: spacing.xs, paddingLeft: spacing.xs },
  modalActions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xs },
  confirmInputWrap: {
    backgroundColor: colors.surface,
    borderColor: colors.ink,
    borderWidth: 2,
    borderRadius: radii.input,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  confirmInput: { color: colors.ink, paddingVertical: spacing.xs },
});

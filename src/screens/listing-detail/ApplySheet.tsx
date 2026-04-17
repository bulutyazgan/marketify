import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Keyboard,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableWithoutFeedback,
  View,
} from 'react-native';
import { BottomSheet } from '@/components/primitives/BottomSheet';
import { ButtonPrimary } from '@/components/primitives/Button';
import { useToast } from '@/components/primitives/Toast';
import { colors, radii, shadows, spacing } from '@/design/tokens';
import { textStyles } from '@/design/typography';
import { supabase } from '@/lib/supabase';

// US-042 — Apply modal on campaign detail. Bottom sheet with an optional
// pitch field that calls the apply-to-listing edge function (US-041).
//
// Spec alignment (docs/design.md §4.3 + docs/tech-architecture.md §5.5):
// - Header copy "You're applying to" + listing title
// - Pitch (optional) text area with character counter (story AC: 280-char
//   cap; design.md mock shows 0/160 — story AC value used; see Spec gap
//   in progress.txt for US-042)
// - "By applying you confirm you'll follow the campaign rules." disclaimer
// - "Send application" CTA
//
// Edge-function field is `cover_note` per spec §5.5 / `applications.cover_note`
// column (the story AC says "pitch" but cover_note is canonical — same
// resolution as US-041's edge function).
//
// Response handling: 200 → onApplied; structured errors decoded via the
// FunctionsHttpError context Response (Codebase Pattern #98). For
// INELIGIBLE 403 the toast surfaces a one-line summary derived from the
// first failed condition; spec-defined 409 codes (LISTING_NOT_ACTIVE,
// LISTING_VERSION_CHANGED, ALREADY_APPLIED) and 404 each get their own
// toast. The parent reloads the listing for any state-changing error so
// the eligibility rail and CTA reflect the new server reality.

const COVER_NOTE_MAX_LEN = 280;

type SocialPlatform = 'tiktok' | 'instagram';

type FailedCondition = {
  metric: string;
  platform: SocialPlatform | null;
  required: number | boolean;
  actual: number | boolean | null;
};

type ApplySuccess = {
  application_id: string;
  listing_version_id: string;
};

type ServerErrorBody = {
  error?: string;
  failed_conditions?: FailedCondition[];
  current_version_id?: string;
};

export type ApplyFailure =
  | { kind: 'ineligible' }
  | { kind: 'version_changed' }
  | { kind: 'already_applied' }
  | { kind: 'not_active' }
  | { kind: 'not_found' };

export type ApplySheetProps = {
  visible: boolean;
  listingId: string;
  listingTitle: string;
  onDismiss: () => void;
  onApplied: () => void;
  onServerStateChanged: (failure: ApplyFailure) => void;
};

export function ApplySheet({
  visible,
  listingId,
  listingTitle,
  onDismiss,
  onApplied,
  onServerStateChanged,
}: ApplySheetProps) {
  const { show: showToast } = useToast();
  const [pitch, setPitch] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  // Synchronous submit lock (Pattern #106 — useState reads in the callback can
  // be stale across rapid double-taps; a ref is set before any await).
  const submittingRef = useRef(false);

  // Reset the pitch + submitting flags whenever the sheet re-opens, so a prior
  // half-typed message doesn't leak into a fresh attempt.
  useEffect(() => {
    if (visible) {
      setPitch('');
      setSubmitting(false);
      submittingRef.current = false;
    }
  }, [visible]);

  // KeyboardAvoidingView doesn't reliably push content up when nested inside a
  // RN <Modal> (the modal opens its own window so KAV's measured frame and the
  // keyboard's reported frame disagree). Listen to keyboard events directly
  // and apply the height as bottom padding so the CTA stays above the keyboard.
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

  const onSubmit = useCallback(async () => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    const trimmed = pitch.trim();
    try {
      const { data, error } = await supabase.functions.invoke<ApplySuccess>(
        'apply-to-listing',
        {
          body: {
            listing_id: listingId,
            ...(trimmed.length > 0 ? { cover_note: trimmed } : {}),
          },
        },
      );

      if (error) {
        const body = await readErrorBody(error);
        const failure = mapErrorBodyToFailure(body);
        if (failure) {
          showToast({
            message: toastForFailure(failure, body),
            variant: 'error',
          });
          onServerStateChanged(failure);
          return;
        }
        showToast({
          message: 'Could not send application. Try again.',
          variant: 'error',
        });
        return;
      }

      if (!data?.application_id) {
        showToast({
          message: 'Could not send application. Try again.',
          variant: 'error',
        });
        return;
      }

      onApplied();
    } catch (err) {
      console.error('apply-to-listing threw', err);
      showToast({
        message: 'Could not send application. Try again.',
        variant: 'error',
      });
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }, [pitch, listingId, showToast, onApplied, onServerStateChanged]);

  return (
    <BottomSheet
      visible={visible}
      onDismiss={onDismiss}
      snapPoints={[0.85]}
      accessibilityLabel="Apply to campaign"
      testID="apply-sheet"
    >
      <View style={[styles.flex, { paddingBottom: keyboardHeight }]}>
        <View style={styles.header}>
          <Text style={[textStyles.caption, { color: colors.ink70 }]}>
            You&apos;re applying to
          </Text>
          <Text
            style={[textStyles.h1, { color: colors.ink }]}
            numberOfLines={2}
            testID="apply-sheet-title"
          >
            {listingTitle}
          </Text>
        </View>

        <View style={styles.fieldGroup}>
          <View style={styles.labelRow}>
            <Text style={[textStyles.caption, { color: colors.ink70 }]}>
              Pitch (optional)
            </Text>
            <Text
              style={[textStyles.caption, { color: colors.ink40 }]}
              testID="apply-sheet-counter"
            >
              {pitch.length}/{COVER_NOTE_MAX_LEN}
            </Text>
          </View>
          <View style={[styles.inputWrap, shadows.hard]}>
            <TextInput
              value={pitch}
              onChangeText={setPitch}
              placeholder="Why are you a fit?"
              placeholderTextColor={colors.ink40}
              multiline
              maxLength={COVER_NOTE_MAX_LEN}
              style={[textStyles.body, styles.input]}
              accessibilityLabel="Pitch"
              testID="apply-sheet-pitch"
            />
          </View>
        </View>

        <TouchableWithoutFeedback onPress={Keyboard.dismiss} accessible={false}>
          <Text style={[textStyles.caption, styles.disclaimer]}>
            By applying you confirm you&apos;ll follow the campaign rules.
          </Text>
        </TouchableWithoutFeedback>

        <View style={styles.cta}>
          <ButtonPrimary
            label="Send application"
            onPress={onSubmit}
            loading={submitting}
            disabled={submitting}
            testID="apply-sheet-submit"
          />
        </View>
      </View>
    </BottomSheet>
  );
}

async function readErrorBody(
  error: unknown,
): Promise<ServerErrorBody | null> {
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
    return (await (ctx as Response).json()) as ServerErrorBody;
  } catch {
    return null;
  }
}

function mapErrorBodyToFailure(
  body: ServerErrorBody | null,
): ApplyFailure | null {
  if (!body?.error) return null;
  switch (body.error) {
    case 'INELIGIBLE':
      return { kind: 'ineligible' };
    case 'LISTING_VERSION_CHANGED':
      return { kind: 'version_changed' };
    case 'ALREADY_APPLIED':
      return { kind: 'already_applied' };
    case 'LISTING_NOT_ACTIVE':
      return { kind: 'not_active' };
    case 'LISTING_NOT_FOUND':
      return { kind: 'not_found' };
    default:
      return null;
  }
}

function toastForFailure(
  failure: ApplyFailure,
  body: ServerErrorBody | null,
): string {
  switch (failure.kind) {
    case 'ineligible': {
      const first = body?.failed_conditions?.[0];
      return first
        ? `You no longer meet ${conditionLabel(first)}.`
        : 'You no longer meet this campaign\u2019s requirements.';
    }
    case 'version_changed':
      return 'This campaign was updated. Refreshing the details.';
    case 'already_applied':
      return 'You\u2019ve already applied to this campaign.';
    case 'not_active':
      return 'This campaign is no longer accepting applications.';
    case 'not_found':
      return 'This campaign is no longer available.';
  }
}

function conditionLabel(f: FailedCondition): string {
  const platform = f.platform ? platformLabel(f.platform) : '';
  const base = metricLabel(f.metric);
  return platform ? `${platform} ${base}` : base;
}

function platformLabel(p: SocialPlatform): string {
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

const styles = StyleSheet.create({
  flex: { flex: 1 },
  header: {
    gap: spacing.xs,
    marginBottom: spacing.lg,
  },
  fieldGroup: {
    gap: spacing.sm,
  },
  labelRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
  },
  inputWrap: {
    backgroundColor: colors.surface,
    borderRadius: radii.input,
    borderWidth: 2,
    borderColor: colors.ink,
  },
  input: {
    minHeight: 110,
    paddingHorizontal: spacing.base,
    paddingVertical: spacing.md,
    color: colors.ink,
    textAlignVertical: 'top',
  },
  disclaimer: {
    color: colors.ink70,
    marginTop: spacing.lg,
  },
  cta: {
    marginTop: 'auto',
    paddingTop: spacing.lg,
  },
});

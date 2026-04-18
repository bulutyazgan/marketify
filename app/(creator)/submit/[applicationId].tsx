import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
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
import { Check, ChevronLeft } from 'lucide-react-native';
import { ButtonPrimary } from '@/components/primitives/Button';
import { useToast } from '@/components/primitives/Toast';
import { colors, radii, shadows, spacing } from '@/design/tokens';
import { textStyles } from '@/design/typography';
import {
  classifyVideoUrl,
  fetchTikTokOembed,
  type TikTokOembedPreview,
  type UrlClassification,
} from '@/lib/oembed';
import { supabase } from '@/lib/supabase';
import type { Database } from '@/types/supabase';

// US-046 — Submission composer. Canonical creator-side entry to the
// submit-video edge function (US-045). Fetches the single-application
// context via the get_my_application_for_submit SECURITY DEFINER RPC
// so we see the pinned listing_version_id's POST conditions and the
// lister handle even if the listing has since been paused or closed
// (listing_conditions RLS is gated on listing.status='active').
//
// The story AC pins the route to `/(creator)/submit/[applicationId]`
// (design.md §3.1 line 153 lists an alternate nested path, but the
// story AC wins per Ralph convention when the two disagree).
//
// Client-side preview via TikTok oEmbed (docs/tech-architecture.md §3h)
// is a UX nicety — the server re-classifies + re-fetches on submit so
// a missing preview never blocks and a present preview never bypasses
// server validation. Instagram URLs classify but skip the oembed call
// because the Meta Graph endpoint needs an app-token we don't ship in
// the bundle.
//
// Checklist semantics (design.md §2 line 608): mode='self' composer is
// two-state ☐/☑, every row starts unchecked, Submit is disabled until
// every row is checked + URL is a valid TikTok/Instagram shape. The
// server-side INCOMPLETE_AFFIRMATIONS gate is the source of truth; the
// client gate mirrors it for responsiveness. If the server surfaces
// missing ids anyway (e.g. a race where the listing's post-condition
// set changed), we surface a toast and stay put so the creator can
// re-check.

type ApplicationRow =
  Database['public']['Functions']['get_my_application_for_submit']['Returns'][number];

type PostConditionRaw = {
  id: string;
  metric: string;
  operator: string;
  numeric_threshold: number | null;
  text_threshold: string | null;
  bool_threshold: boolean | null;
  platform: Database['public']['Enums']['platform'] | null;
};

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; code: 'not_found' | 'not_approved' | 'generic' }
  | { kind: 'ok'; application: ApplicationRow; conditions: PostConditionRaw[] };

type PreviewState =
  | { kind: 'idle' }
  | { kind: 'invalid' }
  | { kind: 'fetching'; classification: UrlClassification }
  | { kind: 'ready'; classification: UrlClassification; preview: TikTokOembedPreview | null }
  | { kind: 'error'; classification: UrlClassification };

const URL_MAX_LEN = 2048;
const OEMBED_DEBOUNCE_MS = 500;

export default function SubmitVideoComposer() {
  const { applicationId } = useLocalSearchParams<{ applicationId: string }>();
  const { show: showToast } = useToast();

  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [url, setUrl] = useState('');
  const [preview, setPreview] = useState<PreviewState>({ kind: 'idle' });
  const [affirmations, setAffirmations] = useState<Record<string, boolean>>({});
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    if (!applicationId) {
      setState({ kind: 'error', code: 'not_found' });
      return;
    }
    setState({ kind: 'loading' });
    const { data, error } = await supabase.rpc('get_my_application_for_submit', {
      p_application_id: applicationId,
    });
    if (error) {
      console.error('get_my_application_for_submit failed', error);
      setState({ kind: 'error', code: 'generic' });
      return;
    }
    const row = data?.[0];
    if (!row) {
      setState({ kind: 'error', code: 'not_found' });
      return;
    }
    if (row.application_status !== 'approved') {
      setState({ kind: 'error', code: 'not_approved' });
      return;
    }
    const conditions = parsePostConditions(row.post_conditions);
    setState({ kind: 'ok', application: row, conditions });
    setAffirmations(Object.fromEntries(conditions.map((c) => [c.id, false])));
  }, [applicationId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Debounced oEmbed fetch. A new keystroke cancels any in-flight request so
  // we only render the latest URL's preview. AbortController covers the
  // network-inflight case; the state check covers the pre-fetch delay.
  useEffect(() => {
    const trimmed = url.trim();
    if (trimmed.length === 0) {
      setPreview({ kind: 'idle' });
      return;
    }
    const classification = classifyVideoUrl(trimmed);
    if (!classification) {
      setPreview({ kind: 'invalid' });
      return;
    }
    if (classification.platform === 'instagram') {
      // No client-side IG oEmbed (Meta app token is not in the bundle).
      setPreview({ kind: 'ready', classification, preview: null });
      return;
    }
    setPreview({ kind: 'fetching', classification });
    const controller = new AbortController();
    const handle = setTimeout(() => {
      fetchTikTokOembed(trimmed, controller.signal)
        .then((result) => {
          if (controller.signal.aborted) return;
          setPreview({ kind: 'ready', classification, preview: result });
        })
        .catch((err) => {
          if (controller.signal.aborted) return;
          console.warn('TikTok oembed client fetch failed', err);
          setPreview({ kind: 'error', classification });
        });
    }, OEMBED_DEBOUNCE_MS);
    return () => {
      clearTimeout(handle);
      controller.abort();
    };
  }, [url]);

  const toggleAffirmation = useCallback((id: string) => {
    setAffirmations((cur) => ({ ...cur, [id]: !cur[id] }));
  }, []);

  const canSubmit = useMemo(() => {
    if (state.kind !== 'ok') return false;
    if (submitting) return false;
    const classification = classifyVideoUrl(url.trim());
    if (!classification) return false;
    // Wait for the TikTok oEmbed round-trip before enabling Submit so the
    // creator sees the preview confirm the URL resolves. IG never fetches
    // (no Meta app-token in the client) so its preview synchronously flips
    // to 'ready' and this gate is a no-op.
    if (classification.platform === 'tiktok' && preview.kind === 'fetching') {
      return false;
    }
    for (const c of state.conditions) {
      if (!affirmations[c.id]) return false;
    }
    return true;
  }, [state, url, preview, affirmations, submitting]);

  const onBack = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/(creator)/applications');
  }, []);

  const onSubmit = useCallback(async () => {
    if (!canSubmit || state.kind !== 'ok') return;
    setSubmitting(true);
    const { data, error } = await supabase.functions.invoke<{
      submission_id: string;
      platform: 'tiktok' | 'instagram';
    }>('submit-video', {
      body: {
        application_id: state.application.application_id,
        video_url: url.trim(),
        post_condition_affirmations: affirmations,
      },
    });
    if (error) {
      const decoded = await decodeErrorCode(error);
      // INCOMPLETE_AFFIRMATIONS needs access to the current condition set
      // to tell a real "forgot to tick a box" case (IDs we render) from a
      // race where the lister edited the listing's post-conditions between
      // page-open and submit (IDs we do NOT render — ticking more boxes
      // client-side would loop forever). Handled inline so the helper
      // stays pure and reusable.
      if (decoded.code === 'INCOMPLETE_AFFIRMATIONS') {
        const knownIds = new Set(state.conditions.map((c) => c.id));
        const hasUnknown = decoded.missing?.some((id) => !knownIds.has(id)) ?? false;
        setSubmitting(false);
        if (hasUnknown) {
          showToast({
            message: 'This campaign\u2019s requirements changed. Please review and resubmit.',
            variant: 'error',
          });
          void load();
        } else {
          if (decoded.missing && decoded.missing.length > 0) {
            setAffirmations((cur) => {
              const next = { ...cur };
              for (const id of decoded.missing!) next[id] = false;
              return next;
            });
          }
          showToast({
            message: 'Some checklist items still need to be confirmed.',
            variant: 'error',
          });
        }
        return;
      }
      handleSubmitError(decoded, {
        showToast,
        setSubmitting,
        onAlreadySubmitted: () => {
          setTimeout(() => router.replace('/(creator)/submissions'), 350);
        },
        onNoLongerApproved: () => {
          setTimeout(() => router.replace('/(creator)/applications'), 350);
        },
      });
      return;
    }
    if (!data) {
      setSubmitting(false);
      showToast({ message: 'Submission failed. Try again.', variant: 'error' });
      return;
    }
    showToast({ message: 'Submission sent.', variant: 'success' });
    setTimeout(() => router.replace('/(creator)/submissions'), 350);
  }, [canSubmit, state, url, affirmations, showToast, load]);

  return (
    <SafeAreaView style={styles.container}>
      <Header onBack={onBack} />
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={0}
      >
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
              <HeroCard application={state.application} />
              <UrlSection
                url={url}
                onChangeUrl={setUrl}
                preview={preview}
              />
              {state.conditions.length > 0 ? (
                <ChecklistSection
                  conditions={state.conditions}
                  affirmations={affirmations}
                  onToggle={toggleAffirmation}
                />
              ) : null}
            </ScrollView>
            <View style={styles.footer}>
              <ButtonPrimary
                label={submitting ? 'Sending…' : 'Send for review'}
                onPress={onSubmit}
                disabled={!canSubmit}
                loading={submitting}
                testID="submit-cta"
              />
            </View>
          </>
        )}
      </KeyboardAvoidingView>
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
        testID="submit-back"
      >
        <ChevronLeft color={colors.ink} size={28} strokeWidth={2.5} />
      </Pressable>
      <Text style={[textStyles.h2, { color: colors.ink }]}>Submit video</Text>
      <View style={styles.headerSpacer} />
    </View>
  );
}

function ErrorBody({
  code,
  onBack,
}: {
  code: 'not_found' | 'not_approved' | 'generic';
  onBack: () => void;
}) {
  const copy =
    code === 'not_found'
      ? 'This application is no longer available.'
      : code === 'not_approved'
        ? 'Only approved applications can accept video submissions.'
        : 'Could not load this application. Try again in a moment.';
  return (
    <View style={styles.centered}>
      <Text style={[textStyles.h1, { color: colors.ink, textAlign: 'center' }]}>
        Can&apos;t submit
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
        <ButtonPrimary label="Back" onPress={onBack} testID="submit-error-back" />
      </View>
    </View>
  );
}

function HeroCard({ application }: { application: ApplicationRow }) {
  const title =
    application.listing_title || application.version_title || 'Untitled campaign';
  return (
    <View style={styles.heroCard} testID="submit-hero">
      <Text style={[textStyles.display, { color: colors.ink }]}>{title}</Text>
      {application.lister_handle ? (
        <Text style={[textStyles.caption, { color: colors.ink70 }]}>
          @{application.lister_handle}
        </Text>
      ) : null}
    </View>
  );
}

function UrlSection({
  url,
  onChangeUrl,
  preview,
}: {
  url: string;
  onChangeUrl: (next: string) => void;
  preview: PreviewState;
}) {
  return (
    <View style={styles.section}>
      <Text style={[textStyles.h2, { color: colors.ink }]}>Your video URL</Text>
      <Text style={[textStyles.caption, { color: colors.ink70 }]}>
        Paste the TikTok or Instagram post URL.
      </Text>
      <TextInput
        value={url}
        onChangeText={(next) =>
          onChangeUrl(next.length <= URL_MAX_LEN ? next : next.slice(0, URL_MAX_LEN))
        }
        placeholder="https://www.tiktok.com/@handle/video/…"
        placeholderTextColor={colors.ink40}
        style={[textStyles.mono, styles.input]}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        returnKeyType="done"
        testID="submit-url-input"
      />
      <PreviewCard preview={preview} url={url} />
    </View>
  );
}

function PreviewCard({ preview, url }: { preview: PreviewState; url: string }) {
  if (preview.kind === 'idle') return null;

  if (preview.kind === 'invalid') {
    if (url.trim().length === 0) return null;
    return (
      <View style={[styles.previewCard, styles.previewCardError]} testID="submit-preview-invalid">
        <Text style={[textStyles.body, { color: colors.danger }]}>
          This doesn&apos;t look like a TikTok or Instagram post URL.
        </Text>
      </View>
    );
  }

  if (preview.kind === 'fetching') {
    return (
      <View style={styles.previewCard} testID="submit-preview-loading">
        <ActivityIndicator color={colors.ink} />
        <Text style={[textStyles.caption, { color: colors.ink70 }]}>
          Fetching preview…
        </Text>
      </View>
    );
  }

  if (preview.kind === 'error') {
    return (
      <View style={styles.previewCard} testID="submit-preview-error">
        <Text style={[textStyles.body, { color: colors.ink }]}>
          {preview.classification.platform === 'tiktok' ? 'TikTok' : 'Instagram'} post
        </Text>
        <Text style={[textStyles.caption, { color: colors.ink70 }]}>
          Couldn&apos;t load a preview. You can still submit — we&apos;ll re-verify
          the link on our side.
        </Text>
      </View>
    );
  }

  if (preview.classification.platform === 'instagram') {
    return (
      <View style={styles.previewCard} testID="submit-preview-instagram">
        <Text style={[textStyles.body, { color: colors.ink }]}>Instagram post</Text>
        <Text style={[textStyles.caption, { color: colors.ink70 }]}>
          Previews aren&apos;t available for Instagram yet, but the URL looks valid.
        </Text>
      </View>
    );
  }

  const { preview: data } = preview;
  const caption = data?.title ?? 'TikTok video';
  const handle = data?.authorHandle ? `@${data.authorHandle}` : 'TikTok';
  return (
    <View style={styles.previewCard} testID="submit-preview-tiktok">
      {data?.thumbnailUrl ? (
        <Image
          source={{ uri: data.thumbnailUrl }}
          style={styles.previewThumb}
          accessibilityIgnoresInvertColors
        />
      ) : null}
      <View style={styles.previewText}>
        <Text style={[textStyles.body, { color: colors.ink }]} numberOfLines={3}>
          {caption}
        </Text>
        <Text style={[textStyles.caption, { color: colors.ink70 }]}>{handle}</Text>
      </View>
    </View>
  );
}

function ChecklistSection({
  conditions,
  affirmations,
  onToggle,
}: {
  conditions: PostConditionRaw[];
  affirmations: Record<string, boolean>;
  onToggle: (id: string) => void;
}) {
  return (
    <View style={styles.section}>
      <Text style={[textStyles.h2, { color: colors.ink }]}>Confirm before sending</Text>
      <Text style={[textStyles.caption, { color: colors.ink70 }]}>
        Tick every item so the lister knows your video meets the brief.
      </Text>
      <View style={styles.checklist}>
        {conditions.map((c) => (
          <ChecklistRow
            key={c.id}
            label={postConditionLabel(c)}
            checked={!!affirmations[c.id]}
            onPress={() => onToggle(c.id)}
            testID={`submit-checklist-${c.id}`}
          />
        ))}
      </View>
    </View>
  );
}

function ChecklistRow({
  label,
  checked,
  onPress,
  testID,
}: {
  label: string;
  checked: boolean;
  onPress: () => void;
  testID?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      accessibilityLabel={label}
      style={[styles.checklistRow, shadows.hard]}
      testID={testID}
    >
      <View style={[styles.checkbox, checked && styles.checkboxChecked]}>
        {checked ? <Check color={colors.surface} size={16} strokeWidth={3} /> : null}
      </View>
      <Text style={[textStyles.body, styles.checklistText]}>{label}</Text>
    </Pressable>
  );
}

type SubmitErrorCode =
  | 'INVALID_VIDEO_URL'
  | 'INCOMPLETE_AFFIRMATIONS'
  | 'SUBMISSION_EXISTS'
  | 'APPLICATION_NOT_APPROVED'
  | 'APPLICATION_NOT_FOUND'
  | 'OEMBED_UNAVAILABLE'
  | 'UNKNOWN';

type DecodedError = {
  code: SubmitErrorCode;
  missing?: string[];
};

async function decodeErrorCode(error: unknown): Promise<DecodedError> {
  const ctx = (error as { context?: unknown }).context;
  if (
    ctx &&
    typeof ctx === 'object' &&
    'status' in ctx &&
    typeof (ctx as { json?: unknown }).json === 'function'
  ) {
    const res = ctx as Response;
    try {
      const body = (await res.json()) as {
        error?: string;
        missing_condition_ids?: unknown;
      };
      const missing = Array.isArray(body.missing_condition_ids)
        ? (body.missing_condition_ids.filter((x) => typeof x === 'string') as string[])
        : undefined;
      if (
        body.error === 'INVALID_VIDEO_URL' ||
        body.error === 'INCOMPLETE_AFFIRMATIONS' ||
        body.error === 'SUBMISSION_EXISTS' ||
        body.error === 'APPLICATION_NOT_APPROVED' ||
        body.error === 'APPLICATION_NOT_FOUND' ||
        body.error === 'OEMBED_UNAVAILABLE'
      ) {
        return { code: body.error, missing };
      }
    } catch {
      // fall through
    }
  }
  return { code: 'UNKNOWN' };
}

function handleSubmitError(
  decoded: DecodedError,
  deps: {
    showToast: (t: { message: string; variant?: 'success' | 'error' | 'info' }) => void;
    setSubmitting: React.Dispatch<React.SetStateAction<boolean>>;
    onAlreadySubmitted: () => void;
    onNoLongerApproved: () => void;
  },
): void {
  const { showToast, setSubmitting, onAlreadySubmitted, onNoLongerApproved } = deps;
  setSubmitting(false);
  switch (decoded.code) {
    case 'INVALID_VIDEO_URL':
      showToast({
        message: 'TikTok couldn\u2019t find that post. Check the URL.',
        variant: 'error',
      });
      return;
    case 'SUBMISSION_EXISTS':
      showToast({
        message: 'You already submitted a video for this application.',
        variant: 'info',
      });
      onAlreadySubmitted();
      return;
    case 'APPLICATION_NOT_APPROVED':
      showToast({
        message: 'This application is no longer approved.',
        variant: 'error',
      });
      onNoLongerApproved();
      return;
    case 'APPLICATION_NOT_FOUND':
      showToast({ message: 'Application not found.', variant: 'error' });
      onNoLongerApproved();
      return;
    case 'OEMBED_UNAVAILABLE':
      showToast({
        message: 'TikTok is unreachable right now. Try again shortly.',
        variant: 'error',
      });
      return;
    default:
      showToast({ message: 'Submission failed. Try again.', variant: 'error' });
  }
}

function parsePostConditions(raw: unknown): PostConditionRaw[] {
  if (!Array.isArray(raw)) return [];
  const out: PostConditionRaw[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const r = entry as Record<string, unknown>;
    if (typeof r.id !== 'string' || typeof r.metric !== 'string') continue;
    out.push({
      id: r.id,
      metric: r.metric,
      operator: typeof r.operator === 'string' ? r.operator : '',
      numeric_threshold:
        typeof r.numeric_threshold === 'number' ? r.numeric_threshold : null,
      text_threshold:
        typeof r.text_threshold === 'string' ? r.text_threshold : null,
      bool_threshold:
        typeof r.bool_threshold === 'boolean' ? r.bool_threshold : null,
      platform:
        r.platform === 'tiktok' || r.platform === 'instagram' ? r.platform : null,
    });
  }
  return out;
}

function postConditionLabel(c: PostConditionRaw): string {
  switch (c.metric) {
    case 'post_family_friendly':
      return c.bool_threshold
        ? 'My video is family-friendly.'
        : 'My video may be mature, as allowed.';
    case 'post_must_mention':
      return c.text_threshold
        ? `I mention "${c.text_threshold}" in the video.`
        : 'I include the required mention.';
    case 'post_must_tag_account':
      return c.text_threshold
        ? `I tag @${c.text_threshold.replace(/^@/, '')}.`
        : 'I tag the lister account.';
    case 'post_min_video_duration_sec':
      return c.numeric_threshold !== null
        ? `My video is at least ${c.numeric_threshold} seconds long.`
        : 'My video meets the minimum duration.';
    case 'post_max_video_duration_sec':
      return c.numeric_threshold !== null
        ? `My video is at most ${c.numeric_threshold} seconds long.`
        : 'My video is within the maximum duration.';
    case 'post_min_video_count':
      return c.numeric_threshold !== null
        ? `I posted at least ${c.numeric_threshold} videos.`
        : 'I posted the required number of videos.';
    default:
      return c.metric;
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.canvas,
  },
  flex: {
    flex: 1,
  },
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
  headerSpacer: {
    width: 28,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
  },
  scrollContent: {
    padding: spacing.base,
    paddingBottom: spacing.xxxl * 2,
    gap: spacing.xl,
  },
  heroCard: {
    backgroundColor: colors.surface,
    borderColor: colors.ink,
    borderWidth: 2,
    borderRadius: radii.card,
    padding: spacing.base,
    gap: spacing.xs,
    ...shadows.hard,
  },
  section: {
    gap: spacing.sm,
  },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.ink,
    borderWidth: 2,
    borderRadius: radii.input,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    color: colors.ink,
    minHeight: 52,
    ...shadows.hard,
  },
  previewCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderColor: colors.ink,
    borderWidth: 2,
    borderRadius: radii.card,
    padding: spacing.md,
    marginTop: spacing.sm,
  },
  previewCardError: {
    backgroundColor: colors.dangerSoft,
    borderColor: colors.danger,
  },
  previewThumb: {
    width: 72,
    height: 96,
    borderRadius: radii.image,
    borderWidth: 2,
    borderColor: colors.ink,
    backgroundColor: colors.hairline,
  },
  previewText: {
    flex: 1,
    gap: spacing.xs,
  },
  checklist: {
    gap: spacing.sm,
  },
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
    width: 24,
    height: 24,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: colors.ink,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxChecked: {
    backgroundColor: colors.ink,
  },
  checklistText: {
    flex: 1,
    color: colors.ink,
  },
  footer: {
    padding: spacing.base,
    backgroundColor: colors.canvas,
    borderTopWidth: 2,
    borderTopColor: colors.ink,
  },
});

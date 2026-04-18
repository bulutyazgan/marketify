import { useCallback, useMemo, useRef, useState } from 'react';
import {
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { router } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import { ButtonPrimary } from '@/components/primitives/Button';
import { useToast } from '@/components/primitives/Toast';
import { colors, radii, shadows, spacing } from '@/design/tokens';
import { textStyles } from '@/design/typography';
import { classifyVideoUrl } from '@/lib/oembed';
import { supabase } from '@/lib/supabase';
import {
  useWizard,
  type WizardCurrency,
  type WizardDraft,
  type WizardPreConditionMetric,
  type WizardPreConditionPlatform,
} from '@/screens/campaign-wizard/WizardStore';

// US-053 — Create-campaign wizard step 5 (review + publish). Renders the draft
// as a creator would see it (via the same primitives the detail screen uses
// in spirit — neubrutalist cards, sectioned sample videos, pre/post rules),
// then POSTs the normalized payload to the `create-listing` edge function.
//
// Payload shape mirrors the edge function contract in
// `supabase/functions/create-listing/index.ts`. We do a final client-side
// validation pass (title/description non-empty after trim, each pre-condition
// threshold > 0, each post-condition text non-empty, each sample URL that
// survives the filter is recognized by `classifyVideoUrl`) so the Publish CTA
// surfaces a local reason when the wizard isn't in a shippable state and the
// server never sees an obvious-reject request.
//
// On 201 we drop the AsyncStorage draft via `resetDraft`, show a success toast,
// and route-replace to the Campaigns tab so Back doesn't return to step-5.
// Any other outcome lands as an error toast; the draft is preserved so the
// user can retry without re-keying everything (Codebase Pattern #128 — the
// wizard persists on every edit, so even if the app backgrounds during a
// retry the state is safe).

const CURRENCY_SYMBOL: Record<WizardCurrency, string> = {
  USD: '$',
  EUR: '€',
  GBP: '£',
};

const METRIC_LABEL: Record<WizardPreConditionMetric, string> = {
  followers: 'Followers',
  avg_views: 'Avg views',
};

const PLATFORM_LABEL: Record<WizardPreConditionPlatform, string> = {
  tiktok: 'TikTok',
  instagram: 'Instagram',
};

type PublishRequest = {
  title: string;
  description: string;
  price_cents: number;
  currency: WizardCurrency;
  max_submissions: number | null;
  pre_conditions: {
    platform: WizardPreConditionPlatform;
    metric: WizardPreConditionMetric;
    threshold: number;
  }[];
  post_conditions: { id: string; text: string }[];
  sample_urls: string[];
};

type PublishSuccess = {
  listing_id: string;
  version_id: string;
};

type ServerErrorBody = {
  error?: string;
  field?: string;
};

// Returns either a request body ready for the edge function OR a human-
// readable reason the current draft isn't shippable. Empty sample rows are
// filtered out (mirrors the server) and whitespace-only text fields reject
// locally so the user sees the failure before the network round-trip.
function buildRequest(
  draft: WizardDraft,
): { ok: true; body: PublishRequest } | { ok: false; reason: string } {
  const title = draft.title.trim();
  if (title.length === 0) return { ok: false, reason: 'Add a title in step 1.' };
  const description = draft.description.trim();
  if (description.length === 0) {
    return { ok: false, reason: 'Add a description in step 1.' };
  }

  for (const row of draft.preConditions) {
    if (!Number.isFinite(row.threshold) || row.threshold <= 0) {
      return {
        ok: false,
        reason: 'Each eligibility rule needs a threshold above 0.',
      };
    }
  }

  const postConditions: { id: string; text: string }[] = [];
  for (const row of draft.postConditions) {
    const text = row.text.trim();
    if (text.length === 0) {
      return { ok: false, reason: 'Fill in every content rule or remove it.' };
    }
    postConditions.push({ id: row.id, text });
  }

  const sampleUrls: string[] = [];
  for (const raw of draft.sampleUrls) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    if (!classifyVideoUrl(trimmed)) {
      return {
        ok: false,
        reason: 'Sample URLs must be TikTok or Instagram videos.',
      };
    }
    sampleUrls.push(trimmed);
  }

  return {
    ok: true,
    body: {
      title,
      description,
      price_cents: draft.priceCents ?? 0,
      currency: draft.currency,
      max_submissions: draft.maxSubmissions,
      pre_conditions: draft.preConditions.map((row) => ({
        platform: row.platform,
        metric: row.metric,
        threshold: row.threshold,
      })),
      post_conditions: postConditions,
      sample_urls: sampleUrls,
    },
  };
}

function formatPrice(cents: number | null, currency: WizardCurrency): string {
  if (cents === null) return 'Not set';
  const symbol = CURRENCY_SYMBOL[currency];
  if (cents % 100 === 0) return `${symbol}${cents / 100}`;
  return `${symbol}${(cents / 100).toFixed(2)}`;
}

function formatThreshold(n: number): string {
  // 5,000 → "5,000". Keeps the review screen readable for large thresholds
  // without a third-party number formatter.
  return n.toLocaleString('en-US');
}

async function readErrorBody(error: unknown): Promise<ServerErrorBody | null> {
  // Pattern #98 — FunctionsHttpError carries the raw Response on `.context`.
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

export default function CampaignWizardStep5() {
  const { draft, resetDraft } = useWizard();
  const { show: showToast } = useToast();
  const submittingRef = useRef(false);
  const [submitting, setSubmitting] = useState(false);

  const validation = useMemo(() => buildRequest(draft), [draft]);
  const canPublish = validation.ok && !submitting;

  const onBack = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/(lister)/campaigns/new/step-4');
  }, []);

  const onPublish = useCallback(async () => {
    if (submittingRef.current) return;
    if (!validation.ok) {
      showToast({ message: validation.reason, variant: 'error' });
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    try {
      const { data, error } = await supabase.functions.invoke<PublishSuccess>(
        'create-listing',
        { body: validation.body },
      );

      if (error) {
        const body = await readErrorBody(error);
        const message = body?.error === 'INVALID_REQUEST' && body.field
          ? `Please re-check ${body.field.replaceAll('_', ' ')}.`
          : "Couldn't publish. Try again.";
        showToast({ message, variant: 'error' });
        return;
      }

      if (!data?.listing_id) {
        showToast({
          message: "Couldn't publish. Try again.",
          variant: 'error',
        });
        return;
      }

      // Surface success and navigate before clearing the draft, then kick the
      // draft-clear off best-effort. Awaiting `resetDraft` first would let an
      // AsyncStorage.removeItem failure drop us into the catch below and
      // surface a "couldn't publish" toast even though the listing really was
      // created — the user would then retry and duplicate the listing.
      // `replace` (not `push`) so Back from Campaigns doesn't bounce into a
      // now-stale review screen.
      showToast({ message: 'Campaign published.', variant: 'success' });
      router.replace('/(lister)/campaigns');
      void resetDraft().catch((err) => {
        console.error('resetDraft after publish failed', err);
      });
    } catch (err) {
      console.error('create-listing threw', err);
      showToast({ message: "Couldn't publish. Try again.", variant: 'error' });
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }, [validation, showToast, resetDraft]);

  const visibleSampleUrls = draft.sampleUrls.filter((u) => u.trim().length > 0);

  return (
    <SafeAreaView style={styles.root}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.header}>
          <Pressable
            onPress={onBack}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            accessibilityRole="button"
            accessibilityLabel="Back"
            testID="wizard-step5-back"
            style={styles.backBtn}
          >
            <ChevronLeft size={24} color={colors.ink} />
          </Pressable>
          <Text style={[textStyles.micro, styles.stepLabel]} allowFontScaling={false}>
            Step 5 of 5
          </Text>
          <Text style={[textStyles.display, styles.title]} maxFontSizeMultiplier={1.3}>
            Review & publish
          </Text>
          <Text style={[textStyles.body, styles.subtitle]} maxFontSizeMultiplier={1.3}>
            Here&apos;s what creators will see when they open your campaign.
          </Text>
        </View>

        <View style={[styles.card, shadows.hard]} testID="wizard-step5-basics">
          <Text style={[textStyles.caption, styles.sectionLabel]} maxFontSizeMultiplier={1.3}>
            Basics
          </Text>
          <Text style={[textStyles.display, styles.bigTitle]} maxFontSizeMultiplier={1.3}>
            {draft.title.trim().length > 0 ? draft.title : 'Untitled campaign'}
          </Text>
          <Text style={[textStyles.body, styles.descriptionText]} maxFontSizeMultiplier={1.3}>
            {draft.description.trim().length > 0
              ? draft.description
              : 'No description yet.'}
          </Text>
          <View style={styles.metaRow}>
            <View style={styles.metaItem}>
              <Text style={[textStyles.micro, styles.metaLabel]} allowFontScaling={false}>
                Price
              </Text>
              <Text style={[textStyles.body, styles.metaValue]} maxFontSizeMultiplier={1.3}>
                {formatPrice(draft.priceCents, draft.currency)}
              </Text>
            </View>
            <View style={styles.metaItem}>
              <Text style={[textStyles.micro, styles.metaLabel]} allowFontScaling={false}>
                Currency
              </Text>
              <Text style={[textStyles.body, styles.metaValue]} maxFontSizeMultiplier={1.3}>
                {draft.currency}
              </Text>
            </View>
            <View style={styles.metaItem}>
              <Text style={[textStyles.micro, styles.metaLabel]} allowFontScaling={false}>
                Max submissions
              </Text>
              <Text style={[textStyles.body, styles.metaValue]} maxFontSizeMultiplier={1.3}>
                {draft.maxSubmissions === null ? 'No cap' : String(draft.maxSubmissions)}
              </Text>
            </View>
          </View>
        </View>

        <View style={[styles.card, shadows.hard]} testID="wizard-step5-pre">
          <Text style={[textStyles.caption, styles.sectionLabel]} maxFontSizeMultiplier={1.3}>
            Who can apply
          </Text>
          {draft.preConditions.length === 0 ? (
            <Text style={[textStyles.body, styles.muted]} maxFontSizeMultiplier={1.3}>
              Open to anyone.
            </Text>
          ) : (
            draft.preConditions.map((row, index) => (
              <View
                key={row.id}
                style={styles.ruleRow}
                testID={`wizard-step5-pre-${index}`}
              >
                <Text style={[textStyles.body, styles.rulePlatform]} maxFontSizeMultiplier={1.3}>
                  {PLATFORM_LABEL[row.platform]}
                </Text>
                <Text style={[textStyles.body, styles.ruleText]} maxFontSizeMultiplier={1.3}>
                  {`${METRIC_LABEL[row.metric]} \u2265 ${formatThreshold(row.threshold)}`}
                </Text>
              </View>
            ))
          )}
        </View>

        <View style={[styles.card, shadows.hard]} testID="wizard-step5-post">
          <Text style={[textStyles.caption, styles.sectionLabel]} maxFontSizeMultiplier={1.3}>
            Content rules
          </Text>
          {draft.postConditions.length === 0 ? (
            <Text style={[textStyles.body, styles.muted]} maxFontSizeMultiplier={1.3}>
              No content rules.
            </Text>
          ) : (
            draft.postConditions.map((row, index) => (
              <View
                key={row.id}
                style={styles.bulletRow}
                testID={`wizard-step5-post-${index}`}
              >
                <Text style={[textStyles.body, styles.bullet]} maxFontSizeMultiplier={1.3}>
                  {'\u2022'}
                </Text>
                <Text style={[textStyles.body, styles.bulletText]} maxFontSizeMultiplier={1.3}>
                  {row.text.trim().length > 0 ? row.text : '(empty rule)'}
                </Text>
              </View>
            ))
          )}
        </View>

        <View style={[styles.card, shadows.hard]} testID="wizard-step5-samples">
          <Text style={[textStyles.caption, styles.sectionLabel]} maxFontSizeMultiplier={1.3}>
            Sample videos
          </Text>
          {visibleSampleUrls.length === 0 ? (
            <Text style={[textStyles.body, styles.muted]} maxFontSizeMultiplier={1.3}>
              No samples.
            </Text>
          ) : (
            visibleSampleUrls.map((url, index) => {
              const cls = classifyVideoUrl(url.trim());
              const platformLabel = cls?.platform === 'tiktok'
                ? 'TikTok'
                : cls?.platform === 'instagram'
                  ? 'Instagram'
                  : 'Unknown';
              return (
                <View
                  key={index}
                  style={styles.sampleRow}
                  testID={`wizard-step5-sample-${index}`}
                >
                  <Text style={[textStyles.caption, styles.samplePlatform]} allowFontScaling={false}>
                    {platformLabel}
                  </Text>
                  <Text
                    style={[textStyles.body, styles.sampleUrl]}
                    maxFontSizeMultiplier={1.3}
                    numberOfLines={2}
                  >
                    {url}
                  </Text>
                </View>
              );
            })
          )}
        </View>

        <ButtonPrimary
          label={submitting ? 'Publishing…' : 'Publish campaign'}
          onPress={onPublish}
          disabled={!canPublish}
          loading={submitting}
          accessibilityLabel="Publish campaign"
          testID="wizard-step5-publish"
        />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas },
  scroll: {
    padding: spacing.base,
    gap: spacing.base,
    paddingBottom: spacing.xxxl,
  },
  header: {
    gap: spacing.xs,
    paddingTop: spacing.sm,
  },
  backBtn: {
    alignSelf: 'flex-start',
    padding: spacing.xs,
    marginLeft: -spacing.xs,
    marginBottom: spacing.xs,
  },
  stepLabel: {
    color: colors.ink70,
  },
  title: {
    color: colors.ink,
  },
  subtitle: {
    color: colors.ink70,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.card,
    borderWidth: 2,
    borderColor: colors.ink,
    padding: spacing.base,
    gap: spacing.sm,
  },
  sectionLabel: {
    color: colors.ink70,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  bigTitle: {
    color: colors.ink,
  },
  descriptionText: {
    color: colors.ink,
  },
  metaRow: {
    flexDirection: 'row',
    gap: spacing.base,
    flexWrap: 'wrap',
  },
  metaItem: {
    flexDirection: 'column',
    gap: 2,
  },
  metaLabel: {
    color: colors.ink70,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  metaValue: {
    color: colors.ink,
  },
  muted: {
    color: colors.ink70,
  },
  ruleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  rulePlatform: {
    color: colors.ink70,
    width: 92,
  },
  ruleText: {
    color: colors.ink,
    flexShrink: 1,
  },
  bulletRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'flex-start',
  },
  bullet: {
    color: colors.ink70,
    lineHeight: 22,
  },
  bulletText: {
    color: colors.ink,
    flexShrink: 1,
    lineHeight: 22,
  },
  sampleRow: {
    gap: 2,
  },
  samplePlatform: {
    color: colors.ink70,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  sampleUrl: {
    color: colors.ink,
  },
});

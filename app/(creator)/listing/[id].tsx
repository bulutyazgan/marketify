import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Check, ChevronLeft, ExternalLink, X } from 'lucide-react-native';
import { ButtonPrimary } from '@/components/primitives/Button';
import { StatusPill } from '@/components/primitives/StatusPill';
import { useToast } from '@/components/primitives/Toast';
import { ErrorState } from '@/components/shared/ErrorState';
import { colors, radii, shadows, spacing } from '@/design/tokens';
import { textStyles } from '@/design/typography';
import { classifySupabaseError, transientErrorMessage } from '@/lib/errors';
import { supabase } from '@/lib/supabase';
import type { Database } from '@/types/supabase';
import { ApplySheet, type ApplyFailure } from '@/screens/listing-detail/ApplySheet';

// US-040 — Campaign detail screen. Gated under the creator tab group so
// the shared TabBar stays visible; route matches the story AC
// (`app/(creator)/listing/[id].tsx`). Data flows through the
// get-listing-detail edge function (US-039) — that path is picked
// deliberately over direct PostgREST so it works around the current
// JWT-drift cascade that blocks gateway-verified table reads.
//
// Spec alignment (docs/design.md §4.2):
// - Back chevron header (lister handle deferred — requires a lister-profile
//   join the edge function does not yet expose; Spec gap noted in progress.txt).
// - Hero card with title, price, "Payout after approval" caption.
// - Sample videos rendered as tappable rows that open the URL in the
//   platform app via Linking.openURL — NOT embedded previews per the
//   design doc's "link-out only" v1 rule.
// - Eligibility rail: one row per PRE condition showing ✓/✗ plus the
//   required threshold and the creator's actual value (from the
//   edge-function `failed_conditions` additive `actual` field).
// - "What to film" post-condition bullet list (POST rows; not gated on
//   eligibility — reviewed at submission time, US-057+).
// - Sticky footer with the Apply CTA. Gate per §4.2:
//     eligible + !active-app  → ButtonPrimary "Apply to collab"
//     eligible + active-app   → StatusPill + disabled CTA
//     ineligible              → disabled CTA "Not eligible yet"
//     inactive listing        → no CTA, status banner at top
//
// Apply flow: tapping the CTA opens the ApplySheet (US-042) which posts
// to apply-to-listing (US-041). On success we toast + route to the
// Applied tab; on a server-state change (version bump, paused listing,
// already-applied, ineligible, not-found) we close the sheet and reload
// the detail so the eligibility rail / CTA reflect the new reality.

type ListingRow = Database['public']['Tables']['listings']['Row'];
type ConditionRow = Database['public']['Tables']['listing_conditions']['Row'];
type SampleVideoRow = Database['public']['Tables']['sample_videos']['Row'];
type Platform = Database['public']['Enums']['platform'];
type ListingStatus = Database['public']['Enums']['listing_status'];

type FailedCondition = {
  metric: string;
  platform: Platform | null;
  required: number | boolean;
  actual: number | boolean | null;
};

type DetailResponse = {
  listing: ListingRow;
  conditions: ConditionRow[];
  sample_videos: SampleVideoRow[];
  eligibility: {
    eligible: boolean;
    failed_conditions: FailedCondition[];
    has_active_application: boolean;
  };
};

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; code: 'not_found' | 'generic' }
  | { kind: 'ok'; data: DetailResponse };

export default function ListingDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { show: showToast } = useToast();
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [applySheetOpen, setApplySheetOpen] = useState(false);

  const load = useCallback(async () => {
    if (!id) {
      setState({ kind: 'error', code: 'not_found' });
      return;
    }
    setState({ kind: 'loading' });
    const { data, error } = await supabase.functions.invoke<DetailResponse>(
      'get-listing-detail',
      { body: { listing_id: id } },
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
        if (res.status === 404) {
          setState({ kind: 'error', code: 'not_found' });
          return;
        }
      }
      console.error('get-listing-detail failed', error);
      setState({ kind: 'error', code: 'generic' });
      const info = await classifySupabaseError(error);
      if (info.isTransient) {
        showToast({ message: transientErrorMessage(info), variant: 'error' });
      }
      return;
    }
    if (!data) {
      setState({ kind: 'error', code: 'generic' });
      return;
    }
    setState({ kind: 'ok', data });
  }, [id, showToast]);

  useEffect(() => {
    void load();
  }, [load]);

  const onBack = useCallback(() => {
    // Slot-based layouts don't maintain a full stack, so fall back to
    // the feed when back is unavailable (Codebase Pattern #27/#95).
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/(creator)/feed');
    }
  }, []);

  const onApply = useCallback(() => {
    setApplySheetOpen(true);
  }, []);

  const onApplied = useCallback(() => {
    setApplySheetOpen(false);
    showToast({
      message: 'Application sent.',
      variant: 'success',
    });
    // Per AC: route to the Applied tab. The actual route is
    // `/(creator)/applications` (US-031 layout); the AC's "(creator)/applied"
    // refers to the same logical tab. Defer the route swap until after the
    // BottomSheet's spring-out animation has settled (SPRING_SNAPPY ~300ms),
    // otherwise the sheet's slide-down plays on top of the new screen.
    setTimeout(() => router.replace('/(creator)/applications'), 350);
  }, [showToast]);

  const onApplyFailure = useCallback(
    (failure: ApplyFailure) => {
      setApplySheetOpen(false);
      // Reload so the eligibility rail / CTA reflect the new server reality
      // (version bumped, listing paused, an existing application surfaced, etc.).
      if (
        failure.kind === 'version_changed' ||
        failure.kind === 'not_active' ||
        failure.kind === 'already_applied' ||
        failure.kind === 'ineligible' ||
        failure.kind === 'not_found'
      ) {
        void load();
      }
    },
    [load],
  );

  const listingTitle = state.kind === 'ok' ? state.data.listing.title : '';

  return (
    <SafeAreaView style={styles.container}>
      <Header onBack={onBack} />
      {state.kind === 'loading' ? (
        <View style={styles.centered}>
          <ActivityIndicator color={colors.ink} />
        </View>
      ) : state.kind === 'error' ? (
        <ErrorBody code={state.code} onBack={onBack} onRetry={load} />
      ) : (
        <DetailBody data={state.data} onApply={onApply} />
      )}
      {id ? (
        <ApplySheet
          visible={applySheetOpen}
          listingId={id}
          listingTitle={listingTitle}
          onDismiss={() => setApplySheetOpen(false)}
          onApplied={onApplied}
          onServerStateChanged={onApplyFailure}
        />
      ) : null}
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
        testID="listing-back"
      >
        <ChevronLeft color={colors.ink} size={28} strokeWidth={2.5} />
      </Pressable>
      <Text style={[textStyles.h2, { color: colors.ink }]}>Campaign</Text>
      <View style={styles.headerSpacer} />
    </View>
  );
}

function ErrorBody({
  code,
  onBack,
  onRetry,
}: {
  code: 'not_found' | 'generic';
  onBack: () => void;
  onRetry: () => void;
}) {
  if (code === 'not_found') {
    return (
      <ErrorState
        testID="listing-error"
        illustration="not_found"
        title="Campaign not found"
        body="This campaign is no longer available."
        retryLabel="Back to feed"
        onRetry={onBack}
      />
    );
  }
  return (
    <ErrorState
      testID="listing-error"
      body="Could not load this campaign. Try again in a moment."
      onRetry={onRetry}
    />
  );
}

function DetailBody({
  data,
  onApply,
}: {
  data: DetailResponse;
  onApply: () => void;
}) {
  const { listing, conditions, sample_videos, eligibility } = data;

  const preConditions = useMemo(
    () => conditions.filter((c) => c.kind === 'pre'),
    [conditions],
  );
  const postConditions = useMemo(
    () => conditions.filter((c) => c.kind === 'post'),
    [conditions],
  );

  const failureByKey = useMemo(() => {
    const map = new Map<string, FailedCondition>();
    for (const f of eligibility.failed_conditions) {
      map.set(conditionKey(f.metric, f.platform), f);
    }
    return map;
  }, [eligibility.failed_conditions]);

  const inactiveBanner = getInactiveBanner(listing.status);
  const priceLabel = formatPrice(listing.price_cents, listing.currency);

  return (
    <>
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {inactiveBanner ? (
          <View style={styles.inactiveBanner} testID="listing-inactive-banner">
            <Text style={[textStyles.caption, { color: colors.ink }]}>
              {inactiveBanner}
            </Text>
          </View>
        ) : null}

        <View style={styles.heroCard} testID="listing-hero">
          <Text style={[textStyles.display, { color: colors.ink }]}>
            {listing.title}
          </Text>
          <Text style={[textStyles.h1, styles.priceRow]} testID="listing-price">
            {priceLabel}
          </Text>
          <Text style={[textStyles.caption, { color: colors.ink70 }]}>
            Payout after approval
          </Text>
        </View>

        {sample_videos.length > 0 ? (
          <Section title="Sample videos">
            <View style={styles.sampleList}>
              {sample_videos.map((v) => (
                <SampleVideoCell key={v.id} video={v} />
              ))}
            </View>
          </Section>
        ) : null}

        {preConditions.length > 0 ? (
          <Section title="Eligibility">
            <View style={styles.eligibilityList}>
              {preConditions.map((c) => (
                <EligibilityRow
                  key={c.id}
                  condition={c}
                  failure={failureByKey.get(conditionKey(c.metric, c.platform)) ?? null}
                />
              ))}
            </View>
          </Section>
        ) : null}

        {postConditions.length > 0 ? (
          <Section title="What to film">
            <View style={styles.bulletList}>
              {postConditions.map((c) => (
                <PostConditionRow key={c.id} condition={c} />
              ))}
            </View>
          </Section>
        ) : null}

        {listing.description ? (
          <Section title="Brief">
            <Text style={[textStyles.body, { color: colors.ink }]}>
              {listing.description}
            </Text>
          </Section>
        ) : null}
      </ScrollView>

      <FooterCta
        listing={listing}
        eligibility={eligibility}
        onApply={onApply}
      />
    </>
  );
}

function FooterCta({
  listing,
  eligibility,
  onApply,
}: {
  listing: ListingRow;
  eligibility: DetailResponse['eligibility'];
  onApply: () => void;
}) {
  if (listing.status !== 'active') {
    // Inactive listing surfaces its state via the top banner; the CTA is
    // hidden outright — a disabled CTA would imply "apply later" which is
    // wrong for paused/closed.
    return null;
  }
  if (eligibility.has_active_application) {
    return (
      <View style={styles.footer}>
        <View style={styles.footerInner}>
          <StatusPill status="pending" label="Applied" testID="listing-applied-pill" />
          <View style={styles.footerCtaWrap}>
            <ButtonPrimary
              label="Applied"
              onPress={onApply}
              disabled
              testID="listing-cta"
            />
          </View>
        </View>
      </View>
    );
  }
  if (!eligibility.eligible) {
    return (
      <View style={styles.footer}>
        <View style={styles.failureSummary} testID="listing-failure-summary">
          <Text style={[textStyles.caption, { color: colors.ink70 }]}>
            You don&apos;t meet these yet:
          </Text>
          {eligibility.failed_conditions.map((f) => (
            <View key={conditionKey(f.metric, f.platform)} style={styles.bulletRow}>
              <View style={styles.bullet} />
              <Text style={[textStyles.caption, styles.bulletText]}>
                {failureBulletLabel(f)}
              </Text>
            </View>
          ))}
        </View>
        <View style={styles.footerCtaWrap}>
          <ButtonPrimary
            label="Not eligible yet"
            onPress={onApply}
            disabled
            testID="listing-cta"
          />
        </View>
      </View>
    );
  }
  return (
    <View style={styles.footer}>
      <View style={styles.footerCtaWrap}>
        <ButtonPrimary
          label="Apply to collab"
          onPress={onApply}
          testID="listing-cta"
        />
      </View>
    </View>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={[textStyles.h2, { color: colors.ink }]}>{title}</Text>
      {children}
    </View>
  );
}

function SampleVideoCell({ video }: { video: SampleVideoRow }) {
  const label = platformLabel(video.platform);
  const onPress = useCallback(() => {
    void Linking.openURL(video.url).catch(() => {
      // Swallowed intentionally — the link may not resolve in the
      // simulator (no TikTok/Instagram app installed). There is no
      // actionable retry; the URL is the primary info for the creator.
    });
  }, [video.url]);
  return (
    <Pressable
      onPress={onPress}
      style={[styles.sampleRow, shadows.hard]}
      accessibilityRole="link"
      accessibilityLabel={`Open ${label} sample${video.caption ? `: ${video.caption}` : ''}`}
      testID={`listing-sample-${video.sort_order}`}
    >
      <View style={styles.sampleText}>
        <Text style={[textStyles.body, { color: colors.ink }]}>
          {video.caption ?? `${label} sample`}
        </Text>
        <Text style={[textStyles.caption, { color: colors.ink70 }]} numberOfLines={1}>
          {video.url}
        </Text>
      </View>
      <ExternalLink color={colors.ink} size={20} strokeWidth={2.5} />
    </Pressable>
  );
}

function EligibilityRow({
  condition,
  failure,
}: {
  condition: ConditionRow;
  failure: FailedCondition | null;
}) {
  const passed = failure === null;
  const label = eligibilityRowLabel(condition);
  const statusColor = passed ? colors.success : colors.danger;
  const Icon = passed ? Check : X;
  const detail = passed
    ? requiredLabel(condition)
    : failureDetailLabel(condition, failure);
  return (
    <View
      style={styles.eligibilityRow}
      accessible
      accessibilityLabel={
        passed
          ? `${label} passes. Required ${requiredLabel(condition)}.`
          : `${label} fails. ${detail}.`
      }
      testID={`listing-eligibility-${condition.metric}-${condition.platform ?? 'none'}`}
    >
      <View style={[styles.eligibilityIcon, { borderColor: statusColor }]}>
        <Icon color={statusColor} size={16} strokeWidth={3} />
      </View>
      <View style={styles.eligibilityTextWrap}>
        <Text style={[textStyles.body, { color: colors.ink }]}>{label}</Text>
        <Text style={[textStyles.caption, { color: colors.ink70 }]}>{detail}</Text>
      </View>
    </View>
  );
}

function PostConditionRow({ condition }: { condition: ConditionRow }) {
  return (
    <View style={styles.bulletRow}>
      <View style={styles.bullet} />
      <Text style={[textStyles.body, styles.bulletText]}>
        {postConditionLabel(condition)}
      </Text>
    </View>
  );
}

function conditionKey(metric: string, platform: Platform | null): string {
  return `${metric}::${platform ?? '_'}`;
}

function getInactiveBanner(status: ListingStatus): string | null {
  switch (status) {
    case 'paused':
      return 'This campaign is paused. The lister is reviewing pending applications.';
    case 'closed':
      return 'This campaign is closed and no longer accepting applications.';
    default:
      return null;
  }
}

function eligibilityRowLabel(c: ConditionRow): string {
  const platform = c.platform ? platformLabel(c.platform) : '';
  const base = metricLabel(c.metric);
  return platform ? `${platform} · ${base}` : base;
}

function metricLabel(metric: string): string {
  switch (metric) {
    case 'min_followers':
      return 'Minimum followers';
    case 'min_avg_views_last_n':
      return 'Avg views (last 10)';
    case 'min_total_likes':
      return 'Total likes';
    case 'min_videos_posted':
      return 'Videos posted';
    case 'verified_only':
      return 'Verified account';
    default:
      return metric;
  }
}

function requiredLabel(c: ConditionRow): string {
  if (c.operator === 'bool') {
    return `Requires ${c.bool_threshold ? 'yes' : 'no'}`;
  }
  const threshold = c.numeric_threshold;
  if (threshold !== null && threshold !== undefined) {
    return `Requires ${formatCount(Number(threshold))}+`;
  }
  return '—';
}

function failureDetailLabel(
  c: ConditionRow,
  f: FailedCondition,
): string {
  const required = requiredLabel(c);
  if (typeof f.actual === 'number') {
    return `${required} — you have ${formatCount(f.actual)}`;
  }
  if (typeof f.actual === 'boolean') {
    return `${required} — you are ${f.actual ? 'verified' : 'not verified'}`;
  }
  return `${required} — no data yet`;
}

function failureBulletLabel(f: FailedCondition): string {
  const platform = f.platform ? platformLabel(f.platform) : '';
  const base = metricLabel(f.metric);
  const label = platform ? `${platform} · ${base}` : base;
  if (typeof f.required === 'boolean') {
    return `${label} — need ${f.required ? 'yes' : 'no'}`;
  }
  const needed = formatCount(f.required);
  if (typeof f.actual === 'number') {
    return `${label} — have ${formatCount(f.actual)} of ${needed} needed`;
  }
  return `${label} — need ${needed} (no data yet)`;
}

function postConditionLabel(c: ConditionRow): string {
  switch (c.metric) {
    case 'post_family_friendly':
      return c.bool_threshold ? 'Family-friendly content only.' : 'Content may be mature.';
    case 'post_must_mention':
      // Lister-authored free-text rule (stored under the `post_must_mention`
      // enum for historical reasons — see us_053_create_listing_rpc.sql §42).
      // Render verbatim so sentences the lister writes ("Must use family-
      // friendly language") aren't double-prefixed into "Must mention Must
      // use…".
      return c.text_threshold ?? 'Content rule applies.';
    case 'post_must_tag_account':
      return c.text_threshold
        ? `Must tag @${c.text_threshold.replace(/^@/, '')}.`
        : 'Must tag the lister account.';
    case 'post_min_video_duration_sec':
      return c.numeric_threshold !== null
        ? `Video at least ${c.numeric_threshold}s.`
        : 'Minimum video duration.';
    case 'post_max_video_duration_sec':
      return c.numeric_threshold !== null
        ? `Video at most ${c.numeric_threshold}s.`
        : 'Maximum video duration.';
    case 'post_min_video_count':
      return c.numeric_threshold !== null
        ? `Post at least ${c.numeric_threshold} videos.`
        : 'Minimum video count.';
    default:
      return c.metric;
  }
}

function platformLabel(p: Platform): string {
  return p === 'tiktok' ? 'TikTok' : 'Instagram';
}

function formatPrice(priceCents: number, currency: string): string {
  const amount = (priceCents / 100).toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
  const code = currency.toUpperCase();
  if (code === 'USD') return `$${amount}`;
  return `${amount} ${code}`;
}

function formatCount(n: number): string {
  if (n < 1000) return String(n);
  const trim = (value: number, digits: number): string => {
    const fixed = value.toFixed(digits);
    return fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed;
  };
  if (n < 1_000_000) return `${trim(n / 1000, n < 10_000 ? 1 : 0)}k`;
  if (n < 1_000_000_000) return `${trim(n / 1_000_000, n < 10_000_000 ? 1 : 0)}m`;
  return `${trim(n / 1_000_000_000, n < 10_000_000_000 ? 1 : 0)}b`;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.canvas,
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
  inactiveBanner: {
    backgroundColor: colors.warningSoft,
    borderColor: colors.warning,
    borderWidth: 2,
    borderRadius: radii.card,
    padding: spacing.base,
    ...shadows.hard,
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
  priceRow: {
    color: colors.cta,
    marginTop: spacing.sm,
  },
  section: {
    gap: spacing.md,
  },
  sampleList: {
    gap: spacing.md,
  },
  sampleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderColor: colors.ink,
    borderWidth: 2,
    borderRadius: radii.card,
    padding: spacing.base,
  },
  sampleText: {
    flex: 1,
    gap: spacing.xs,
  },
  eligibilityList: {
    gap: spacing.sm,
  },
  eligibilityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderColor: colors.ink,
    borderWidth: 2,
    borderRadius: radii.card,
    padding: spacing.md,
  },
  eligibilityIcon: {
    width: 28,
    height: 28,
    borderRadius: radii.pill,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  eligibilityTextWrap: {
    flex: 1,
    gap: 2,
  },
  bulletList: {
    gap: spacing.sm,
  },
  bulletRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    paddingHorizontal: spacing.xs,
  },
  bullet: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.ink,
    marginTop: 9,
  },
  bulletText: {
    flex: 1,
    color: colors.ink,
  },
  footer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    padding: spacing.base,
    backgroundColor: colors.canvas,
    borderTopWidth: 2,
    borderTopColor: colors.ink,
  },
  footerInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  footerCtaWrap: {
    flex: 1,
  },
  failureSummary: {
    gap: spacing.xs,
    marginBottom: spacing.md,
  },
});

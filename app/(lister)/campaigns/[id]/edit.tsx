import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  type TextInputProps,
  View,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { ChevronLeft, Trash2 } from 'lucide-react-native';
import { ButtonPrimary, ButtonSecondary } from '@/components/primitives/Button';
import { Chip } from '@/components/primitives/Chip';
import { useToast } from '@/components/primitives/Toast';
import { colors, radii, shadows, spacing } from '@/design/tokens';
import { textStyles } from '@/design/typography';
import { classifyVideoUrl } from '@/lib/oembed';
import { supabase } from '@/lib/supabase';
import type { Database } from '@/types/supabase';

// US-055 / US-055b — Edit campaign screen with cascade-cancel confirmation modal.
//
// Flow: fetch the listing (listings_owner_all RLS → owner only) → render
// editable fields → on Save, diff against the original. Two cascade-eligible
// edit kinds:
//   1. SCALAR versioned edits (price_cents, currency, max_submissions per the
//      us_010 cascade trigger): committed via direct PATCH to public.listings
//      under listings_owner_all RLS. The DB trigger
//      (app_private.bump_listing_version) version-bumps the listing and
//      cascade-cancels pending applications on commit.
//   2. SAMPLE_VIDEOS edits (US-055b): cannot be a client-side multi-statement
//      because the version bump creates a new listing_versions row and the new
//      sample_videos rows must FK against it; RLS on sample_videos only grants
//      READ to listers. Routed through the `update-listing-samples` edge
//      function which (a) calls update_listing_samples_rpc, (b) returns
//      {needs_confirmation, pending_count} when pending apps > 0 and the
//      client did not pass confirm_cascade, (c) otherwise commits and returns
//      {new_version_id, cancelled_pending_count}.
//
// Title/description/category edits DO NOT cascade (the trigger guards on the
// versioned scalars + the ephemeral version_bump_reason column only).
//
// Spec gap: pre/post conditions editing is still deferred — those need
// app_private.request_listing_version_bump to fire the version_bump_reason
// column, AND §15b threshold-refresh triggers (Codebase Pattern #52) MUST
// land first. Sample videos are safe to ship now because the threshold
// columns (min_followers_*) don't depend on sample_videos.

type Currency = 'USD' | 'EUR' | 'GBP';
type ListingRow = Database['public']['Tables']['listings']['Row'];
type ListingStatus = Database['public']['Enums']['listing_status'];
type SampleVideoRow = Database['public']['Tables']['sample_videos']['Row'];

const CURRENCIES: readonly Currency[] = ['USD', 'EUR', 'GBP'];
const CURRENCY_SYMBOL: Record<Currency, string> = { USD: '$', EUR: '€', GBP: '£' };

// Price in major units with up to two decimals.
const PRICE_INPUT_RE = /^(\d+)?(\.\d{0,2})?$/;
// integer column in Postgres → cap at 2^31-1 (Codebase Pattern #131).
const PRICE_CENTS_MAX = 2_147_483_647;
const MAX_SUBMISSIONS_MAX = 99_999;
const MAX_SUBMISSIONS_INPUT_RE = /^\d*$/;
// Mirror the wizard cap (create-listing SAMPLE_URLS_MAX) AND the edge function
// cap. Keeps the editor surface in lockstep with the wizard's surface.
const SAMPLE_URLS_MAX = 10;

function centsToDisplay(cents: number | null | undefined): string {
  if (cents == null) return '';
  if (cents % 100 === 0) return String(cents / 100);
  return (cents / 100).toFixed(2);
}

function displayToCents(display: string): number | null {
  const trimmed = display.trim();
  if (!trimmed) return null;
  const n = Number.parseFloat(trimmed);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

function isKnownCurrency(c: string): c is Currency {
  return (CURRENCIES as readonly string[]).includes(c);
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; code: 'not_found' | 'generic' }
  | {
      kind: 'loaded';
      listing: ListingRow;
      originalSampleUrls: string[];
    };

// Cascade modal trigger: distinguishes which save path the user must run after
// confirming, since the two paths take different code (PATCH vs edge function).
type CascadeTrigger =
  | { kind: 'scalar'; count: number }
  | { kind: 'samples'; count: number };

export default function EditCampaignScreen() {
  const params = useLocalSearchParams<{ id: string }>();
  const listingId = typeof params.id === 'string' ? params.id : null;
  const toast = useToast();

  const [state, setState] = useState<LoadState>({ kind: 'loading' });

  // Form state. Initialized from the loaded row; "priceDisplay" is the
  // TextInput mirror so partial values like "12." survive keystrokes.
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priceDisplay, setPriceDisplay] = useState('');
  const [currency, setCurrency] = useState<Currency>('USD');
  const [maxSubmissionsDisplay, setMaxSubmissionsDisplay] = useState('');
  // Sample URLs are an ordered array; order matters because the lister
  // authored it that way (matches wizard step-4 semantics + the RPC's
  // diff which compares ordered jsonb arrays).
  const [sampleUrls, setSampleUrls] = useState<string[]>([]);

  // Modal state: null = closed, non-null = which path triggered it.
  const [cascadeTrigger, setCascadeTrigger] = useState<CascadeTrigger | null>(null);
  const [saving, setSaving] = useState(false);
  // Synchronous lock — `saving` state updates are batched, so a fast
  // double-tap can enter onSave twice before the disabled prop applies
  // (Codebase Pattern #106).
  const savingRef = useRef(false);

  useEffect(() => {
    if (!listingId) {
      setState({ kind: 'error', code: 'not_found' });
      return;
    }
    let cancelled = false;
    (async () => {
      // Load listing scalars first; sample videos hang off the listing's
      // current_version_id so we need that id before the second query.
      const { data: listing, error: listingError } = await supabase
        .from('listings')
        .select('*')
        .eq('id', listingId)
        .maybeSingle();
      if (cancelled) return;
      if (listingError) {
        setState({ kind: 'error', code: 'generic' });
        return;
      }
      if (!listing) {
        setState({ kind: 'error', code: 'not_found' });
        return;
      }

      // sample_videos_lister_read grants the listing owner SELECT via the
      // listing → version → samples FK chain. For listings without a current
      // version (theoretically impossible after publish, but guard anyway),
      // skip the query and treat sample list as empty.
      let originalSampleUrls: string[] = [];
      if (listing.current_version_id) {
        const { data: samples, error: samplesError } = await supabase
          .from('sample_videos')
          .select('url, sort_order, id')
          .eq('listing_version_id', listing.current_version_id)
          .order('sort_order', { ascending: true })
          .order('id', { ascending: true });
        if (cancelled) return;
        if (samplesError) {
          setState({ kind: 'error', code: 'generic' });
          return;
        }
        originalSampleUrls = (samples ?? []).map((s: Pick<SampleVideoRow, 'url'>) => s.url);
      }

      setTitle(listing.title);
      setDescription(listing.description ?? '');
      setPriceDisplay(centsToDisplay(listing.price_cents));
      setCurrency(isKnownCurrency(listing.currency) ? listing.currency : 'USD');
      setMaxSubmissionsDisplay(
        listing.max_submissions == null ? '' : String(listing.max_submissions),
      );
      setSampleUrls(originalSampleUrls);
      setState({ kind: 'loaded', listing, originalSampleUrls });
    })();
    return () => {
      cancelled = true;
    };
  }, [listingId]);

  const parsedPriceCents = useMemo(() => displayToCents(priceDisplay), [priceDisplay]);
  const parsedMaxSubmissions = useMemo(() => {
    const t = maxSubmissionsDisplay.trim();
    if (!t) return null;
    const n = Number.parseInt(t, 10);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n;
  }, [maxSubmissionsDisplay]);

  const original = state.kind === 'loaded' ? state.listing : null;
  const originalSampleUrls = state.kind === 'loaded' ? state.originalSampleUrls : null;

  // Build the comparable sample list: trim whitespace, drop empty rows
  // (matches the edge function + create-listing behaviour). Order is
  // significant — the RPC compares ordered jsonb arrays.
  const cleanedSampleUrls = useMemo(
    () => sampleUrls.map((u) => u.trim()).filter((u) => u.length > 0),
    [sampleUrls],
  );

  // Are any sample rows present-and-malformed? Disables Save and surfaces a
  // per-row error message on the offending row. Empty rows are NOT errors —
  // they're drafting state that gets dropped on Save (mirrors wizard step-4).
  const sampleHasInvalid = useMemo(
    () =>
      sampleUrls.some((u) => {
        const t = u.trim();
        return t.length > 0 && classifyVideoUrl(t) === null;
      }),
    [sampleUrls],
  );

  // Changed-fields diff drives both the button enable state and the
  // versioned-field detection. We compare raw cents/ints (not display
  // strings) so "12" vs "12.00" doesn't count as a change.
  const diff = useMemo(() => {
    if (!original) {
      return {
        any: false,
        scalarVersioned: false,
        samplesChanged: false,
        changed: [] as string[],
      };
    }
    const changed: string[] = [];
    if (title.trim() !== original.title) changed.push('title');
    if ((description.trim() || null) !== (original.description ?? null)) {
      changed.push('description');
    }
    if (parsedPriceCents !== original.price_cents) changed.push('price_cents');
    if (currency !== original.currency) changed.push('currency');
    if (parsedMaxSubmissions !== original.max_submissions) changed.push('max_submissions');
    const scalarVersioned =
      changed.includes('price_cents') ||
      changed.includes('currency') ||
      changed.includes('max_submissions');
    // sample_videos diff: compare the cleaned (trimmed, empty-dropped) array
    // to the original list. The order matters because the RPC's jsonb diff
    // honors order — a reorder is a change.
    const orig = originalSampleUrls ?? [];
    const samplesChanged =
      cleanedSampleUrls.length !== orig.length ||
      cleanedSampleUrls.some((u, i) => u !== orig[i]);
    if (samplesChanged) changed.push('sample_videos');
    return {
      any: changed.length > 0,
      scalarVersioned,
      samplesChanged,
      changed,
    };
  }, [
    original,
    originalSampleUrls,
    title,
    description,
    parsedPriceCents,
    currency,
    parsedMaxSubmissions,
    cleanedSampleUrls,
  ]);

  const inputsValid = useMemo(() => {
    if (title.trim().length === 0) return false;
    // price_cents is NOT NULL in the schema — require a parseable value.
    if (parsedPriceCents === null) return false;
    if (parsedPriceCents > PRICE_CENTS_MAX) return false;
    // max_submissions is nullable — empty is valid, non-empty that fails to
    // parse is not.
    if (maxSubmissionsDisplay.trim() && parsedMaxSubmissions === null) return false;
    if (parsedMaxSubmissions !== null && parsedMaxSubmissions > MAX_SUBMISSIONS_MAX) {
      return false;
    }
    if (sampleUrls.length > SAMPLE_URLS_MAX) return false;
    if (sampleHasInvalid) return false;
    return true;
  }, [
    title,
    parsedPriceCents,
    maxSubmissionsDisplay,
    parsedMaxSubmissions,
    sampleUrls,
    sampleHasInvalid,
  ]);

  const canSave = state.kind === 'loaded' && diff.any && inputsValid && !saving;

  // ===== Sample row mutations =====
  // Match the wizard step-4 functional-updater pattern (Codebase Pattern #128)
  // so rapid-fire taps don't drop writes against a stale closure snapshot.
  const onAddSample = useCallback(() => {
    setSampleUrls((prev) => (prev.length >= SAMPLE_URLS_MAX ? prev : [...prev, '']));
  }, []);
  const onRemoveSample = useCallback((index: number) => {
    setSampleUrls((prev) => prev.filter((_, i) => i !== index));
  }, []);
  const onChangeSample = useCallback((index: number, next: string) => {
    setSampleUrls((prev) => prev.map((u, i) => (i === index ? next : u)));
  }, []);

  // ===== Scalar PATCH path =====
  // Used when ONLY scalar fields changed (no sample_videos diff). Goes direct
  // to PostgREST under listings_owner_all RLS; the DB trigger handles the
  // cascade. We do NOT call this when samples also changed — that path
  // routes through the edge function instead, which atomically handles both.
  const patchScalars = useCallback(async () => {
    if (!listingId || !original || parsedPriceCents === null) return;
    savingRef.current = true;
    setSaving(true);
    const payload = {
      title: title.trim(),
      description: description.trim() || null,
      price_cents: parsedPriceCents,
      currency,
      max_submissions: parsedMaxSubmissions,
    };
    const { error } = await supabase.from('listings').update(payload).eq('id', listingId);
    savingRef.current = false;
    setSaving(false);
    if (error) {
      toast.show({ message: "Couldn't save changes.", variant: 'error' });
      return;
    }
    const msg = diff.scalarVersioned
      ? 'Changes saved. New version published.'
      : 'Changes saved.';
    toast.show({ message: msg, variant: 'success' });
    if (router.canGoBack()) router.back();
    else router.replace('/(lister)/campaigns');
  }, [
    listingId,
    original,
    title,
    description,
    parsedPriceCents,
    currency,
    parsedMaxSubmissions,
    diff.scalarVersioned,
    toast,
  ]);

  // ===== Sample-videos edge-function path =====
  // confirm: when true, the server is allowed to commit even if pending apps
  // exist. When false, the server returns needs_confirmation and we open the
  // cascade modal — re-invoked with confirm:true after the user confirms.
  // This keeps the cascade-confirm gate centralized server-side per the
  // edge function's contract (mirrors Codebase Pattern #135).
  const invokeUpdateSamples = useCallback(
    async (confirm: boolean) => {
      if (!listingId) return;
      savingRef.current = true;
      setSaving(true);
      const { data, error } = await supabase.functions.invoke<{
        changed?: boolean;
        needs_confirmation?: boolean;
        pending_count?: number;
        new_version_id?: string;
        cancelled_pending_count?: number;
      }>('update-listing-samples', {
        body: {
          listing_id: listingId,
          urls: cleanedSampleUrls,
          confirm_cascade: confirm,
        },
      });
      savingRef.current = false;
      setSaving(false);
      if (error || !data) {
        toast.show({ message: "Couldn't save sample videos.", variant: 'error' });
        return;
      }
      // No-op response — server saw no diff vs current_version. Treat as
      // success for UX (the user's intent was satisfied, just nothing to do).
      if (data.changed === false) {
        toast.show({ message: 'Changes saved.', variant: 'success' });
        if (router.canGoBack()) router.back();
        else router.replace('/(lister)/campaigns');
        return;
      }
      // Server gated the commit because pending apps exist — open the modal.
      // We do NOT navigate away; the user must explicitly confirm.
      if (data.needs_confirmation === true) {
        setCascadeTrigger({ kind: 'samples', count: data.pending_count ?? 0 });
        return;
      }
      // Successful commit. Toast wording mirrors the scalar versioned path.
      toast.show({ message: 'Changes saved. New version published.', variant: 'success' });
      if (router.canGoBack()) router.back();
      else router.replace('/(lister)/campaigns');
    },
    [listingId, cleanedSampleUrls, toast],
  );

  // patchScalarsBare: PATCHes scalars without toast/navigate. Used as the
  // first leg of the chained "scalars + samples" save. Returns true on
  // success so the caller can chain.
  const patchScalarsBare = useCallback(async (): Promise<boolean> => {
    if (!listingId || !original || parsedPriceCents === null) return false;
    const payload = {
      title: title.trim(),
      description: description.trim() || null,
      price_cents: parsedPriceCents,
      currency,
      max_submissions: parsedMaxSubmissions,
    };
    const { error: patchErr } = await supabase
      .from('listings')
      .update(payload)
      .eq('id', listingId);
    if (patchErr) {
      toast.show({ message: "Couldn't save changes.", variant: 'error' });
      return false;
    }
    return true;
  }, [
    listingId,
    original,
    parsedPriceCents,
    title,
    description,
    currency,
    parsedMaxSubmissions,
    toast,
  ]);

  // chainScalarsThenSamples: the worst-case path — both scalars and samples
  // changed. PATCH scalars first (cascade fires here if scalarVersioned),
  // then invoke samples with confirm:true (server sees pending_count=0
  // after the scalar cascade, so this is a no-op cascade-wise but still
  // versions the listing to attach the new sample rows).
  const chainScalarsThenSamples = useCallback(async () => {
    savingRef.current = true;
    setSaving(true);
    const ok = await patchScalarsBare();
    savingRef.current = false;
    setSaving(false);
    if (!ok) return;
    await invokeUpdateSamples(true);
  }, [patchScalarsBare, invokeUpdateSamples]);

  // ===== Save dispatcher =====
  // Routing tree:
  //   - samples changed alone → edge function gates its own cascade.
  //   - samples changed + scalars also changed → count pending; if zero,
  //     chain directly; if non-zero, open modal (kind: samples) and
  //     chain in onConfirm.
  //   - scalars only, scalarVersioned → count pending; if zero, PATCH;
  //     if non-zero, open modal (kind: scalar) and PATCH in onConfirm.
  //   - scalars only, non-versioned → direct PATCH, no modal.
  const onSave = useCallback(async () => {
    if (savingRef.current) return;
    if (!canSave || !listingId) return;

    const scalarsAlsoChanged = diff.changed.some((c) => c !== 'sample_videos');

    // Path 1: samples changed (alone or with scalars).
    if (diff.samplesChanged) {
      // If only samples changed, route through the edge function — the
      // server counts pending apps and may return needs_confirmation.
      if (!scalarsAlsoChanged) {
        void invokeUpdateSamples(false);
        return;
      }
      // Both samples and scalars changed. We need to ask the user once
      // for cascade confirmation if pending > 0, then chain both writes.
      savingRef.current = true;
      setSaving(true);
      const { count, error } = await supabase
        .from('applications')
        .select('id', { count: 'exact', head: true })
        .eq('listing_id', listingId)
        .eq('status', 'pending');
      savingRef.current = false;
      setSaving(false);
      if (error) {
        toast.show({ message: "Couldn't check pending applications.", variant: 'error' });
        return;
      }
      const n = count ?? 0;
      if (n === 0) {
        await chainScalarsThenSamples();
        return;
      }
      setCascadeTrigger({ kind: 'samples', count: n });
      return;
    }

    // Path 2: scalars only.
    if (!diff.scalarVersioned) {
      void patchScalars();
      return;
    }
    // Versioned scalar edit → count pending applications BEFORE writing,
    // so we can show the exact cascade impact to the lister.
    savingRef.current = true;
    setSaving(true);
    const { count, error } = await supabase
      .from('applications')
      .select('id', { count: 'exact', head: true })
      .eq('listing_id', listingId)
      .eq('status', 'pending');
    savingRef.current = false;
    setSaving(false);
    if (error) {
      toast.show({ message: "Couldn't check pending applications.", variant: 'error' });
      return;
    }
    const n = count ?? 0;
    if (n === 0) {
      void patchScalars();
      return;
    }
    setCascadeTrigger({ kind: 'scalar', count: n });
  }, [
    canSave,
    listingId,
    diff.samplesChanged,
    diff.scalarVersioned,
    diff.changed,
    patchScalars,
    invokeUpdateSamples,
    chainScalarsThenSamples,
    toast,
  ]);

  const onConfirmCascade = useCallback(async () => {
    const trigger = cascadeTrigger;
    if (!trigger) return;
    setCascadeTrigger(null);
    if (trigger.kind === 'scalar') {
      void patchScalars();
      return;
    }
    // samples-kind trigger: either samples-only (no scalars) or
    // samples + scalars chain.
    const scalarsAlsoChanged = diff.changed.some((c) => c !== 'sample_videos');
    if (scalarsAlsoChanged) {
      await chainScalarsThenSamples();
    } else {
      await invokeUpdateSamples(true);
    }
  }, [
    cascadeTrigger,
    patchScalars,
    invokeUpdateSamples,
    chainScalarsThenSamples,
    diff.changed,
  ]);

  const onDismissConfirm = useCallback(() => setCascadeTrigger(null), []);

  const onBack = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/(lister)/campaigns');
  }, []);

  if (state.kind === 'loading') {
    return (
      <SafeAreaView style={[styles.root, styles.center]}>
        <ActivityIndicator color={colors.ink} />
      </SafeAreaView>
    );
  }

  if (state.kind === 'error') {
    return (
      <SafeAreaView style={[styles.root, styles.center]}>
        <Text style={[textStyles.body, { color: colors.danger, textAlign: 'center' }]}>
          {state.code === 'not_found' ? "Campaign not found." : "Couldn't load campaign."}
        </Text>
        <View style={{ height: spacing.lg }} />
        <ButtonSecondary label="Back" onPress={onBack} testID="edit-error-back" />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.root}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
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
              testID="edit-back"
              style={styles.backBtn}
            >
              <ChevronLeft size={24} color={colors.ink} />
            </Pressable>
            <Text style={[textStyles.micro, styles.stepLabel]} allowFontScaling={false}>
              {statusLabel(state.listing.status)}
            </Text>
            <Text style={[textStyles.display, styles.title]}>Edit campaign</Text>
            <Text
              style={[textStyles.body, styles.subtitle]}
              maxFontSizeMultiplier={1.3}
            >
              Changes to price, currency, max submissions, or sample videos cancel pending applications.
            </Text>
          </View>

          <View style={styles.fields}>
            <Field
              label="Title"
              value={title}
              onChange={setTitle}
              autoCapitalize="sentences"
              testID="edit-title"
            />
            <Field
              label="Description"
              value={description}
              onChange={setDescription}
              autoCapitalize="sentences"
              multiline
              testID="edit-description"
            />
            <Field
              label="Price"
              value={priceDisplay}
              onChange={(next) => {
                if (next !== '' && !PRICE_INPUT_RE.test(next)) return;
                setPriceDisplay(next);
              }}
              placeholder="0.00"
              keyboardType="decimal-pad"
              prefix={CURRENCY_SYMBOL[currency]}
              testID="edit-price"
            />

            <View style={styles.field}>
              <Text style={[textStyles.caption, styles.label]}>Currency</Text>
              <View style={styles.chipRow}>
                {CURRENCIES.map((c) => (
                  <Chip
                    key={c}
                    label={c}
                    active={currency === c}
                    onPress={() => setCurrency(c)}
                    accessibilityLabel={`Currency ${c}`}
                    testID={`edit-currency-${c}`}
                  />
                ))}
              </View>
            </View>

            <Field
              label="Max submissions (optional)"
              value={maxSubmissionsDisplay}
              onChange={(next) => {
                if (next !== '' && !MAX_SUBMISSIONS_INPUT_RE.test(next)) return;
                if (next.length > 5) return;
                setMaxSubmissionsDisplay(next);
              }}
              placeholder="Leave blank for unlimited"
              keyboardType="number-pad"
              testID="edit-max-submissions"
            />
          </View>

          <View style={styles.section}>
            <Text style={[textStyles.caption, styles.label]} maxFontSizeMultiplier={1.3}>
              Sample videos
            </Text>
            <Text style={[textStyles.body, styles.sectionHint]} maxFontSizeMultiplier={1.3}>
              TikTok or Instagram URLs creators should match. Optional.
            </Text>

            <View style={styles.sampleRows}>
              {sampleUrls.map((url, index) => (
                <SampleRow
                  // Index key is safe: rows aren't reorderable, removing one
                  // dismounts its trash button anyway. Same as wizard step-4.
                  key={index}
                  url={url}
                  index={index}
                  onChange={onChangeSample}
                  onRemove={onRemoveSample}
                />
              ))}
              {sampleUrls.length === 0 ? (
                <Text
                  style={[textStyles.body, styles.emptyHint]}
                  maxFontSizeMultiplier={1.3}
                >
                  No samples yet. Add one below.
                </Text>
              ) : null}
              {sampleUrls.length < SAMPLE_URLS_MAX ? (
                <ButtonSecondary
                  label="Add sample"
                  onPress={onAddSample}
                  accessibilityLabel="Add sample video"
                  testID="edit-sample-add"
                />
              ) : null}
            </View>
          </View>

          <ButtonPrimary
            label="Save changes"
            onPress={onSave}
            disabled={!canSave}
            loading={saving && cascadeTrigger === null}
            accessibilityLabel="Save campaign changes"
            testID="edit-save"
          />
        </ScrollView>
      </KeyboardAvoidingView>

      <CascadeConfirmModal
        trigger={cascadeTrigger}
        saving={saving}
        onConfirm={onConfirmCascade}
        onDismiss={onDismissConfirm}
      />
    </SafeAreaView>
  );
}

function statusLabel(s: ListingStatus): string {
  switch (s) {
    case 'active':
      return 'ACTIVE';
    case 'draft':
      return 'DRAFT';
    case 'paused':
      return 'PAUSED';
    case 'closed':
      return 'CLOSED';
    case 'archived':
      return 'ARCHIVED';
  }
}

type SampleRowProps = {
  url: string;
  index: number;
  onChange: (index: number, next: string) => void;
  onRemove: (index: number) => void;
};

// Mirrors the wizard step-4 SampleRow visual + a11y exactly so the editor
// looks like the create surface (Codebase Pattern #130 reuse).
function SampleRow({ url, index, onChange, onRemove }: SampleRowProps) {
  const onUrlChange = useCallback((next: string) => onChange(index, next), [onChange, index]);
  const onRemovePress = useCallback(() => onRemove(index), [onRemove, index]);

  const trimmed = url.trim();
  const classification = trimmed.length === 0 ? null : classifyVideoUrl(trimmed);
  const hasError = trimmed.length > 0 && classification === null;

  const platformLabel =
    classification?.platform === 'tiktok'
      ? 'TikTok'
      : classification?.platform === 'instagram'
        ? 'Instagram'
        : 'Sample';

  return (
    <View style={[styles.sampleCard, shadows.hard]} testID={`edit-sample-row-${index}`}>
      <View style={styles.sampleCardHeader}>
        <Text style={[textStyles.caption, styles.sampleCardTitle]} maxFontSizeMultiplier={1.3}>
          {`${platformLabel} ${index + 1}`}
        </Text>
        <Pressable
          onPress={onRemovePress}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          accessibilityRole="button"
          accessibilityLabel={`Remove sample ${index + 1}`}
          testID={`edit-sample-remove-${index}`}
        >
          <Trash2 size={18} color={colors.ink70} />
        </Pressable>
      </View>

      <View
        style={[
          styles.inputWrap,
          shadows.hard,
          hasError && styles.inputWrapError,
        ]}
      >
        <TextInput
          value={url}
          onChangeText={onUrlChange}
          placeholder="https://www.tiktok.com/@user/video/..."
          placeholderTextColor={colors.ink40}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          style={[textStyles.body, styles.input]}
          accessibilityLabel={`Sample URL ${index + 1}`}
          testID={`edit-sample-row-${index}-url`}
        />
      </View>

      {hasError ? (
        <Text
          style={[textStyles.caption, styles.errorText]}
          maxFontSizeMultiplier={1.3}
          testID={`edit-sample-row-${index}-error`}
        >
          Must be a TikTok or Instagram video URL.
        </Text>
      ) : null}
    </View>
  );
}

type CascadeConfirmModalProps = {
  trigger: CascadeTrigger | null;
  saving: boolean;
  onConfirm: () => void;
  onDismiss: () => void;
};

// Centered alert-style confirm. Design.md §3.3 carves out "modals (except
// confirmations) are bottom sheets" — confirmations are a centered card
// per §5.2 line 635. Same neubrutalist language (hard shadow, 2px ink
// border) as every other surface (Codebase Pattern #134).
function CascadeConfirmModal({
  trigger,
  saving,
  onConfirm,
  onDismiss,
}: CascadeConfirmModalProps) {
  const visible = trigger !== null;
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={onDismiss}
      testID="edit-cascade-modal"
    >
      <View style={styles.modalRoot}>
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={saving ? undefined : onDismiss}
          accessible={false}
          importantForAccessibility="no"
        />
        <View
          style={[styles.modalCard, shadows.hard]}
          accessibilityViewIsModal
          accessibilityLabel="Confirm cascade"
        >
          <Text style={[textStyles.h2, styles.modalTitle]} maxFontSizeMultiplier={1.3}>
            Cancel pending applications?
          </Text>
          <Text style={[textStyles.body, styles.modalBody]} maxFontSizeMultiplier={1.3}>
            {cascadeMessage(trigger?.count ?? 0)}
          </Text>
          <View style={styles.modalActions}>
            <View style={styles.modalActionItem}>
              <ButtonSecondary
                label="Cancel"
                onPress={onDismiss}
                disabled={saving}
                testID="edit-cascade-cancel"
              />
            </View>
            <View style={styles.modalActionItem}>
              <ButtonPrimary
                label="Continue"
                onPress={onConfirm}
                loading={saving}
                testID="edit-cascade-confirm"
              />
            </View>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function cascadeMessage(count: number): string {
  const noun = count === 1 ? 'pending application' : 'pending applications';
  return `This will cancel ${count} ${noun}. They'll be notified.`;
}

type FieldProps = {
  label: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  autoCapitalize?: TextInputProps['autoCapitalize'];
  keyboardType?: TextInputProps['keyboardType'];
  multiline?: boolean;
  prefix?: string;
  testID?: string;
};

function Field({
  label,
  value,
  onChange,
  placeholder,
  autoCapitalize,
  keyboardType,
  multiline,
  prefix,
  testID,
}: FieldProps) {
  return (
    <View style={styles.field}>
      <Text style={[textStyles.caption, styles.label]}>{label}</Text>
      <View style={[styles.inputWrap, shadows.hard, multiline && styles.inputWrapMultiline]}>
        {prefix ? <Text style={[textStyles.body, styles.prefix]}>{prefix}</Text> : null}
        <TextInput
          value={value}
          onChangeText={onChange}
          placeholder={placeholder}
          placeholderTextColor={colors.ink40}
          autoCapitalize={autoCapitalize}
          keyboardType={keyboardType}
          multiline={multiline}
          maxFontSizeMultiplier={1.3}
          style={[textStyles.body, styles.input, multiline && styles.inputMultiline]}
          accessibilityLabel={label}
          testID={testID}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas },
  flex: { flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  scroll: {
    padding: spacing.base,
    gap: spacing.xl,
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
  stepLabel: { color: colors.ink70 },
  title: { color: colors.ink },
  subtitle: { color: colors.ink70 },
  fields: { gap: spacing.base },
  field: { gap: spacing.xs },
  label: { color: colors.ink70 },
  section: { gap: spacing.xs },
  sectionHint: {
    color: colors.ink70,
    marginBottom: spacing.xs,
  },
  sampleRows: { gap: spacing.base },
  emptyHint: {
    color: colors.ink70,
    textAlign: 'center',
    paddingVertical: spacing.md,
  },
  sampleCard: {
    backgroundColor: colors.surface,
    borderRadius: radii.card,
    borderWidth: 2,
    borderColor: colors.ink,
    padding: spacing.base,
    gap: spacing.md,
  },
  sampleCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  sampleCardTitle: {
    color: colors.ink,
  },
  inputWrap: {
    backgroundColor: colors.surface,
    borderRadius: radii.input,
    borderWidth: 2,
    borderColor: colors.ink,
    flexDirection: 'row',
    alignItems: 'center',
  },
  inputWrapMultiline: { alignItems: 'flex-start' },
  inputWrapError: {
    borderColor: colors.danger,
  },
  prefix: {
    paddingLeft: spacing.base,
    color: colors.ink70,
  },
  input: {
    flex: 1,
    paddingHorizontal: spacing.base,
    paddingVertical: spacing.md,
    color: colors.ink,
    minHeight: 48,
  },
  inputMultiline: {
    minHeight: 120,
    textAlignVertical: 'top',
  },
  errorText: {
    color: colors.danger,
  },
  chipRow: {
    flexDirection: 'row',
    gap: spacing.sm,
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
  modalActions: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  modalActionItem: { flex: 1 },
});

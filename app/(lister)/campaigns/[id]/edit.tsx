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
import { ChevronLeft } from 'lucide-react-native';
import { ButtonPrimary, ButtonSecondary } from '@/components/primitives/Button';
import { Chip } from '@/components/primitives/Chip';
import { useToast } from '@/components/primitives/Toast';
import { colors, radii, shadows, spacing } from '@/design/tokens';
import { textStyles } from '@/design/typography';
import { supabase } from '@/lib/supabase';
import type { Database } from '@/types/supabase';

// US-055 — Edit campaign screen with cascade-cancel confirmation modal.
//
// Flow: fetch the listing (listings_owner_all RLS → owner only) → render
// editable fields → on Save, diff against the original. If any VERSIONED
// scalar field (price_cents, currency, max_submissions — per the
// us_010 cascade trigger at supabase/migrations/20260417150000) changed,
// count the listing's pending applications via PostgREST under the
// applications_lister_read policy, and if >0 show a confirm modal per
// docs/design.md §5.2 line 635 before issuing the PATCH. The DB trigger
// (app_private.bump_listing_version) performs the cascade + notification
// server-side on commit. Title/description/category edits DO NOT cascade
// (trigger guards on the versioned scalars only).
//
// Spec gap: pre/post conditions and sample_videos editing is deferred.
// Those require app_private.request_listing_version_bump to fire the cue
// column, and §15b threshold-refresh triggers (Codebase Pattern #52)
// MUST land first — both are out of scope for this story's AC which
// verifies the flow by editing a scalar (price).

type Currency = 'USD' | 'EUR' | 'GBP';
type ListingRow = Database['public']['Tables']['listings']['Row'];
type ListingStatus = Database['public']['Enums']['listing_status'];

const CURRENCIES: readonly Currency[] = ['USD', 'EUR', 'GBP'];
const CURRENCY_SYMBOL: Record<Currency, string> = { USD: '$', EUR: '€', GBP: '£' };

// Price in major units with up to two decimals.
const PRICE_INPUT_RE = /^(\d+)?(\.\d{0,2})?$/;
// integer column in Postgres → cap at 2^31-1 (Codebase Pattern #131).
const PRICE_CENTS_MAX = 2_147_483_647;
const MAX_SUBMISSIONS_MAX = 99_999;
const MAX_SUBMISSIONS_INPUT_RE = /^\d*$/;

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
  | { kind: 'loaded'; listing: ListingRow };

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

  // Modal state: null = closed, number = pending count to cascade-cancel.
  const [confirmCount, setConfirmCount] = useState<number | null>(null);
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
      const { data, error } = await supabase
        .from('listings')
        .select('*')
        .eq('id', listingId)
        .maybeSingle();
      if (cancelled) return;
      if (error) {
        setState({ kind: 'error', code: 'generic' });
        return;
      }
      if (!data) {
        setState({ kind: 'error', code: 'not_found' });
        return;
      }
      setTitle(data.title);
      setDescription(data.description ?? '');
      setPriceDisplay(centsToDisplay(data.price_cents));
      setCurrency(isKnownCurrency(data.currency) ? data.currency : 'USD');
      setMaxSubmissionsDisplay(
        data.max_submissions == null ? '' : String(data.max_submissions),
      );
      setState({ kind: 'loaded', listing: data });
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

  // Changed-fields diff drives both the button enable state and the
  // versioned-field detection. We compare raw cents/ints (not display
  // strings) so "12" vs "12.00" doesn't count as a change.
  const diff = useMemo(() => {
    if (!original) {
      return { any: false, versioned: false, changed: [] as string[] };
    }
    const changed: string[] = [];
    if (title.trim() !== original.title) changed.push('title');
    if ((description.trim() || null) !== (original.description ?? null)) {
      changed.push('description');
    }
    if (parsedPriceCents !== original.price_cents) changed.push('price_cents');
    if (currency !== original.currency) changed.push('currency');
    if (parsedMaxSubmissions !== original.max_submissions) changed.push('max_submissions');
    const versioned =
      changed.includes('price_cents') ||
      changed.includes('currency') ||
      changed.includes('max_submissions');
    return { any: changed.length > 0, versioned, changed };
  }, [original, title, description, parsedPriceCents, currency, parsedMaxSubmissions]);

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
    return true;
  }, [title, parsedPriceCents, maxSubmissionsDisplay, parsedMaxSubmissions]);

  const canSave = state.kind === 'loaded' && diff.any && inputsValid && !saving;

  const patchListing = useCallback(async () => {
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
    const msg = diff.versioned
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
    diff.versioned,
    toast,
  ]);

  const onSave = useCallback(async () => {
    if (savingRef.current) return;
    if (!canSave || !listingId) return;
    // Non-versioned edits skip the cascade modal — no cascade server-side,
    // no creators to warn about.
    if (!diff.versioned) {
      void patchListing();
      return;
    }
    // Versioned edit → count pending applications BEFORE writing, so we
    // can show the exact cascade impact to the lister. If listing isn't
    // 'active' the trigger wouldn't cascade anyway, but we still query
    // under the same RLS policy — a non-active listing simply can't have
    // pending applications in this project (public_read gates on active).
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
      // Nothing to cascade — commit directly with no interstitial.
      void patchListing();
      return;
    }
    setConfirmCount(n);
  }, [canSave, listingId, diff.versioned, patchListing, toast]);

  const onConfirmCascade = useCallback(() => {
    setConfirmCount(null);
    void patchListing();
  }, [patchListing]);

  const onDismissConfirm = useCallback(() => setConfirmCount(null), []);

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
              Changes to price, currency, or max submissions cancel pending applications.
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

          <ButtonPrimary
            label="Save changes"
            onPress={onSave}
            disabled={!canSave}
            loading={saving && confirmCount === null}
            accessibilityLabel="Save campaign changes"
            testID="edit-save"
          />
        </ScrollView>
      </KeyboardAvoidingView>

      <CascadeConfirmModal
        count={confirmCount}
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

type CascadeConfirmModalProps = {
  count: number | null;
  saving: boolean;
  onConfirm: () => void;
  onDismiss: () => void;
};

// Centered alert-style confirm. Design.md §3.3 carves out "modals (except
// confirmations) are bottom sheets" — confirmations are a centered card
// per §5.2 line 635. Keeps the same neubrutalist language (hard shadow,
// 2px ink border) as every other surface.
function CascadeConfirmModal({
  count,
  saving,
  onConfirm,
  onDismiss,
}: CascadeConfirmModalProps) {
  const visible = count !== null;
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
            {cascadeMessage(count)}
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

function cascadeMessage(count: number | null): string {
  const n = count ?? 0;
  const noun = n === 1 ? 'pending application' : 'pending applications';
  return `This will cancel ${n} ${noun}. They'll be notified.`;
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
  inputWrap: {
    backgroundColor: colors.surface,
    borderRadius: radii.input,
    borderWidth: 2,
    borderColor: colors.ink,
    flexDirection: 'row',
    alignItems: 'center',
  },
  inputWrapMultiline: { alignItems: 'flex-start' },
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

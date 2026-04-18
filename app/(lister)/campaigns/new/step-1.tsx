import { useCallback, useMemo, useState } from 'react';
import {
  KeyboardAvoidingView,
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
import { router } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import { ButtonPrimary } from '@/components/primitives/Button';
import { Chip } from '@/components/primitives/Chip';
import { colors, radii, shadows, spacing } from '@/design/tokens';
import { textStyles } from '@/design/typography';
import {
  useWizard,
  type WizardCurrency,
} from '@/screens/campaign-wizard/WizardStore';

// US-049 — Create-campaign wizard step 1 (basics: title, description, price,
// currency). Draft persisted via `WizardProvider` (Context + AsyncStorage).
// "Next" is gated on non-empty trimmed title + description per AC; price is
// optional and stored as cents to match `listings.price_cents`.
//
// Price is display-only in v1 per docs/product-plan.md §3.1 (no payments).
// The user enters major units (e.g. "49.50") — we parse to cents on change
// so the draft stays aligned with the DB column shape for step-5 publish.

const CURRENCIES: readonly WizardCurrency[] = ['USD', 'EUR', 'GBP'];
const CURRENCY_SYMBOL: Record<WizardCurrency, string> = {
  USD: '$',
  EUR: '€',
  GBP: '£',
};

// Accept up to two decimal places, e.g. "12", "12.50", ".5"; reject letters,
// multiple dots, etc. The dollars → cents conversion is Math.round on *100.
const PRICE_INPUT_RE = /^(\d+)?(\.\d{0,2})?$/;

function centsToDisplay(cents: number | null): string {
  if (cents === null) return '';
  // Render integer values without a trailing `.00` so round-trip is clean.
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

export default function CampaignWizardStep1() {
  const { draft, hydrated, setField, setPartial } = useWizard();

  // Local mirror of the price TextInput so we can keep partial input like "12."
  // without mangling it through cents round-trips. Initialized from the draft
  // once hydration finishes.
  const [priceDisplay, setPriceDisplay] = useState<string | null>(null);
  const effectivePriceDisplay =
    priceDisplay ?? (hydrated ? centsToDisplay(draft.priceCents) : '');

  const canProceed = useMemo(
    () => draft.title.trim().length > 0 && draft.description.trim().length > 0,
    [draft.title, draft.description],
  );

  const onTitleChange = useCallback(
    (next: string) => setField('title', next),
    [setField],
  );
  const onDescriptionChange = useCallback(
    (next: string) => setField('description', next),
    [setField],
  );

  const onPriceChange = useCallback(
    (next: string) => {
      if (next !== '' && !PRICE_INPUT_RE.test(next)) return;
      setPriceDisplay(next);
      setField('priceCents', displayToCents(next));
    },
    [setField],
  );

  const onCurrencyPick = useCallback(
    (currency: WizardCurrency) => {
      setPartial({ currency });
    },
    [setPartial],
  );

  const onNext = useCallback(() => {
    if (!canProceed) return;
    router.push('/(lister)/campaigns/new/step-2');
  }, [canProceed]);

  const onBack = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/(lister)/dashboard');
  }, []);

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
              testID="wizard-step1-back"
              style={styles.backBtn}
            >
              <ChevronLeft size={24} color={colors.ink} />
            </Pressable>
            <Text style={[textStyles.micro, styles.stepLabel]} allowFontScaling={false}>
              Step 1 of 5
            </Text>
            <Text style={[textStyles.display, styles.title]}>New campaign</Text>
            <Text style={[textStyles.body, styles.subtitle]}>
              The basics creators see first.
            </Text>
          </View>

          <View style={styles.fields}>
            <Field
              label="Title"
              value={draft.title}
              onChange={onTitleChange}
              placeholder="e.g. Launch of LuxeDrop summer line"
              autoCapitalize="sentences"
              testID="wizard-step1-title"
            />
            <Field
              label="Description"
              value={draft.description}
              onChange={onDescriptionChange}
              placeholder="What creators need to know before applying."
              autoCapitalize="sentences"
              multiline
              testID="wizard-step1-description"
            />
            <Field
              label="Price (optional)"
              value={effectivePriceDisplay}
              onChange={onPriceChange}
              placeholder="0.00"
              keyboardType="decimal-pad"
              prefix={CURRENCY_SYMBOL[draft.currency]}
              testID="wizard-step1-price"
            />

            <View style={styles.currencyGroup}>
              <Text style={[textStyles.caption, styles.label]}>Currency</Text>
              <View style={styles.chipRow}>
                {CURRENCIES.map((c) => (
                  <Chip
                    key={c}
                    label={c}
                    active={draft.currency === c}
                    onPress={() => onCurrencyPick(c)}
                    accessibilityLabel={`Currency ${c}`}
                    testID={`wizard-step1-currency-${c}`}
                  />
                ))}
              </View>
            </View>
          </View>

          <ButtonPrimary
            label="Next"
            onPress={onNext}
            disabled={!canProceed}
            accessibilityLabel="Go to wizard step 2"
            testID="wizard-step1-next"
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
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
  stepLabel: {
    color: colors.ink70,
  },
  title: {
    color: colors.ink,
  },
  subtitle: {
    color: colors.ink70,
  },
  fields: {
    gap: spacing.base,
  },
  field: {
    gap: spacing.xs,
  },
  label: {
    color: colors.ink70,
  },
  inputWrap: {
    backgroundColor: colors.surface,
    borderRadius: radii.input,
    borderWidth: 2,
    borderColor: colors.ink,
    flexDirection: 'row',
    alignItems: 'center',
  },
  inputWrapMultiline: {
    alignItems: 'flex-start',
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
  currencyGroup: {
    gap: spacing.xs,
  },
  chipRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
});

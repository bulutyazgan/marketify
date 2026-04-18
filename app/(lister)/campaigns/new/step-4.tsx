import { useCallback } from 'react';
import {
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
import { router } from 'expo-router';
import { ChevronLeft, Trash2 } from 'lucide-react-native';
import { ButtonPrimary, ButtonSecondary } from '@/components/primitives/Button';
import { colors, radii, shadows, spacing } from '@/design/tokens';
import { textStyles } from '@/design/typography';
import { classifyVideoUrl } from '@/lib/oembed';
import { useWizard } from '@/screens/campaign-wizard/WizardStore';

// US-052 — Create-campaign wizard step 4 (sample videos + max submissions).
// Per-row URL validation reuses `classifyVideoUrl` from `src/lib/oembed.ts`
// so the wizard preview and the server-side submit path (US-046 / the
// submit-video edge function) agree on what counts as a TikTok or Instagram
// URL. Empty rows are allowed and will be filtered at publish (step-5) —
// Next stays enabled so users can still navigate while drafting, and step-5
// is the final gate before the listing is created.
//
// max_submissions maps 1:1 onto `listings.max_submissions` (integer nullable,
// docs/tech-architecture.md §4.7). Empty input = null = "no cap".

// Digits-only filter for the max-submissions field. 5-digit cap keeps real
// inputs well under int32 without needing an explicit range check.
const MAX_SUBMISSIONS_RE = /^\d*$/;
const MAX_SUBMISSIONS_DIGITS = 5;

export default function CampaignWizardStep4() {
  const { draft, updateField, setField } = useWizard();

  // Array mutations use the functional updater (Codebase Pattern #128) so
  // rapid-fire taps don't drop writes against a stale closure snapshot.
  const onAddRow = useCallback(() => {
    updateField('sampleUrls', (prev) => [...prev, '']);
  }, [updateField]);

  const onRemoveRow = useCallback(
    (index: number) => {
      updateField('sampleUrls', (prev) => prev.filter((_, i) => i !== index));
    },
    [updateField],
  );

  const onChangeUrl = useCallback(
    (index: number, next: string) => {
      updateField('sampleUrls', (prev) =>
        prev.map((u, i) => (i === index ? next : u)),
      );
    },
    [updateField],
  );

  const onChangeMax = useCallback(
    (next: string) => {
      if (next !== '' && !MAX_SUBMISSIONS_RE.test(next)) return;
      // `maxLength` on <TextInput> caps keyboard input but not pasted input,
      // so enforce the digit limit here too — otherwise a pasted "100000"
      // would land in the store even though the visible input stays capped.
      if (next.length > MAX_SUBMISSIONS_DIGITS) return;
      if (next === '') {
        setField('maxSubmissions', null);
        return;
      }
      const parsed = Number.parseInt(next, 10);
      setField('maxSubmissions', Number.isFinite(parsed) ? parsed : null);
    },
    [setField],
  );

  const onNext = useCallback(() => {
    router.push('/(lister)/campaigns/new/step-5');
  }, []);

  const onBack = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/(lister)/campaigns/new/step-3');
  }, []);

  const maxDisplay =
    draft.maxSubmissions === null ? '' : String(draft.maxSubmissions);

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
              testID="wizard-step4-back"
              style={styles.backBtn}
            >
              <ChevronLeft size={24} color={colors.ink} />
            </Pressable>
            <Text style={[textStyles.micro, styles.stepLabel]} allowFontScaling={false}>
              Step 4 of 5
            </Text>
            <Text style={[textStyles.display, styles.title]} maxFontSizeMultiplier={1.3}>
              Samples & limits
            </Text>
            <Text style={[textStyles.body, styles.subtitle]} maxFontSizeMultiplier={1.3}>
              Reference videos creators should match, and a cap on approved submissions.
            </Text>
          </View>

          <View style={styles.section}>
            <Text style={[textStyles.caption, styles.sectionLabel]} maxFontSizeMultiplier={1.3}>
              Sample videos
            </Text>
            <Text style={[textStyles.body, styles.sectionHint]} maxFontSizeMultiplier={1.3}>
              TikTok or Instagram URLs. Optional.
            </Text>

            <View style={styles.rows}>
              {draft.sampleUrls.map((url, index) => (
                // Using index as the key is safe here: rows aren't
                // re-orderable, and removing one dismounts the trash
                // button anyway (focus is never preserved across remove).
                <SampleRow
                  key={index}
                  url={url}
                  index={index}
                  onChange={onChangeUrl}
                  onRemove={onRemoveRow}
                />
              ))}
              {draft.sampleUrls.length === 0 ? (
                <Text style={[textStyles.body, styles.emptyHint]} maxFontSizeMultiplier={1.3}>
                  No samples yet. Add one below.
                </Text>
              ) : null}
              <ButtonSecondary
                label="Add sample"
                onPress={onAddRow}
                accessibilityLabel="Add sample video"
                testID="wizard-step4-add"
              />
            </View>
          </View>

          <View style={styles.section}>
            <Text style={[textStyles.caption, styles.sectionLabel]} maxFontSizeMultiplier={1.3}>
              Max submissions
            </Text>
            <Text style={[textStyles.body, styles.sectionHint]} maxFontSizeMultiplier={1.3}>
              How many creators can be approved. Leave empty for no cap.
            </Text>
            <View style={[styles.inputWrap, shadows.hard]}>
              <TextInput
                value={maxDisplay}
                onChangeText={onChangeMax}
                placeholder="No cap"
                placeholderTextColor={colors.ink40}
                keyboardType="number-pad"
                maxLength={MAX_SUBMISSIONS_DIGITS}
                style={[textStyles.body, styles.input]}
                accessibilityLabel="Max submissions"
                testID="wizard-step4-max"
              />
            </View>
          </View>

          <ButtonPrimary
            label="Next"
            onPress={onNext}
            accessibilityLabel="Go to wizard step 5"
            testID="wizard-step4-next"
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

type SampleRowProps = {
  url: string;
  index: number;
  onChange: (index: number, next: string) => void;
  onRemove: (index: number) => void;
};

function SampleRow({ url, index, onChange, onRemove }: SampleRowProps) {
  const onUrlChange = useCallback(
    (next: string) => onChange(index, next),
    [onChange, index],
  );
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
    <View style={[styles.card, shadows.hard]} testID={`wizard-step4-row-${index}`}>
      <View style={styles.cardHeader}>
        <Text style={[textStyles.caption, styles.cardTitle]} maxFontSizeMultiplier={1.3}>
          {`${platformLabel} ${index + 1}`}
        </Text>
        <Pressable
          onPress={onRemovePress}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          accessibilityRole="button"
          accessibilityLabel={`Remove sample ${index + 1}`}
          testID={`wizard-step4-remove-${index}`}
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
          testID={`wizard-step4-row-${index}-url`}
        />
      </View>

      {hasError ? (
        <Text
          style={[textStyles.caption, styles.errorText]}
          maxFontSizeMultiplier={1.3}
          testID={`wizard-step4-row-${index}-error`}
        >
          Must be a TikTok or Instagram video URL.
        </Text>
      ) : null}
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
  section: {
    gap: spacing.xs,
  },
  sectionLabel: {
    color: colors.ink,
  },
  sectionHint: {
    color: colors.ink70,
    marginBottom: spacing.xs,
  },
  rows: {
    gap: spacing.base,
  },
  emptyHint: {
    color: colors.ink70,
    textAlign: 'center',
    paddingVertical: spacing.md,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.card,
    borderWidth: 2,
    borderColor: colors.ink,
    padding: spacing.base,
    gap: spacing.md,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  cardTitle: {
    color: colors.ink,
  },
  inputWrap: {
    backgroundColor: colors.surface,
    borderRadius: radii.input,
    borderWidth: 2,
    borderColor: colors.ink,
  },
  inputWrapError: {
    borderColor: colors.danger,
  },
  input: {
    paddingHorizontal: spacing.base,
    paddingVertical: spacing.md,
    color: colors.ink,
    minHeight: 48,
  },
  errorText: {
    color: colors.danger,
  },
});

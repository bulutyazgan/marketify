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
import {
  useWizard,
  type WizardPostCondition,
} from '@/screens/campaign-wizard/WizardStore';

// US-051 — Create-campaign wizard step 3 (post-conditions). Free-text rules the
// creator will self-affirm at submit time (docs/product-plan.md §3.1). Each row
// gets a stable RFC-4122 v4 UUID so the submission flow (US-045 / US-046) can
// map per-rule affirmations back to their source rule, and so the publish step
// can write them as `listing_conditions` rows with `condition_kind='post'`
// without a server-side re-mint.
//
// Rows are stored in the wizard draft (AsyncStorage-backed, see WizardStore).
// Post-conditions are optional — an empty list is a valid "no content rules"
// listing, matching step-2's posture for pre-conditions. Next is always enabled.

// Simple RFC-4122 v4 generator — Math.random is adequate for wizard-local ids
// (no security boundary; the server re-validates at publish). Avoids adding an
// `expo-crypto` dep just for this one call site.
function makeUuid(): string {
  const bytes = new Array<number>(16);
  for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export default function CampaignWizardStep3() {
  const { draft, updateField } = useWizard();

  // All mutations use `updateField`'s functional updater so rapid-fire taps
  // (Codebase Pattern #128) read the latest array rather than a stale closure.
  const onAddRow = useCallback(() => {
    const row: WizardPostCondition = { id: makeUuid(), text: '' };
    updateField('postConditions', (prev) => [...prev, row]);
  }, [updateField]);

  const onRemoveRow = useCallback(
    (id: string) => {
      updateField('postConditions', (prev) => prev.filter((row) => row.id !== id));
    },
    [updateField],
  );

  const onChangeText = useCallback(
    (id: string, text: string) => {
      updateField('postConditions', (prev) =>
        prev.map((row) => (row.id === id ? { ...row, text } : row)),
      );
    },
    [updateField],
  );

  const onNext = useCallback(() => {
    router.push('/(lister)/campaigns/new/step-4');
  }, []);

  const onBack = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/(lister)/campaigns/new/step-2');
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
              testID="wizard-step3-back"
              style={styles.backBtn}
            >
              <ChevronLeft size={24} color={colors.ink} />
            </Pressable>
            <Text style={[textStyles.micro, styles.stepLabel]} allowFontScaling={false}>
              Step 3 of 5
            </Text>
            <Text style={[textStyles.display, styles.title]} maxFontSizeMultiplier={1.3}>
              Content rules
            </Text>
            <Text style={[textStyles.body, styles.subtitle]} maxFontSizeMultiplier={1.3}>
              Rules creators must self-affirm before submitting. Leave empty to set no rules.
            </Text>
          </View>

          <View style={styles.rows}>
            {draft.postConditions.map((row, index) => (
              <PostConditionCard
                key={row.id}
                row={row}
                index={index}
                onChangeText={onChangeText}
                onRemove={onRemoveRow}
              />
            ))}
            {draft.postConditions.length === 0 ? (
              <Text style={[textStyles.body, styles.emptyHint]} maxFontSizeMultiplier={1.3}>
                No rules yet. Add one below.
              </Text>
            ) : null}
            <ButtonSecondary
              label="Add rule"
              onPress={onAddRow}
              accessibilityLabel="Add post-condition"
              testID="wizard-step3-add"
            />
          </View>

          <ButtonPrimary
            label="Next"
            onPress={onNext}
            accessibilityLabel="Go to wizard step 4"
            testID="wizard-step3-next"
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

type PostConditionCardProps = {
  row: WizardPostCondition;
  index: number;
  onChangeText: (id: string, text: string) => void;
  onRemove: (id: string) => void;
};

function PostConditionCard({ row, index, onChangeText, onRemove }: PostConditionCardProps) {
  const onTextChange = useCallback(
    (next: string) => onChangeText(row.id, next),
    [onChangeText, row.id],
  );
  const onRemovePress = useCallback(() => onRemove(row.id), [onRemove, row.id]);

  return (
    <View style={[styles.card, shadows.hard]} testID={`wizard-step3-row-${index}`}>
      <View style={styles.cardHeader}>
        <Text style={[textStyles.caption, styles.cardTitle]} maxFontSizeMultiplier={1.3}>
          Rule {index + 1}
        </Text>
        <Pressable
          onPress={onRemovePress}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          accessibilityRole="button"
          accessibilityLabel={`Remove rule ${index + 1}`}
          testID={`wizard-step3-remove-${index}`}
        >
          <Trash2 size={18} color={colors.ink70} />
        </Pressable>
      </View>

      <View style={[styles.inputWrap, shadows.hard]}>
        <TextInput
          value={row.text}
          onChangeText={onTextChange}
          placeholder="e.g. Mentions the brand in the first 10 seconds"
          placeholderTextColor={colors.ink40}
          multiline
          autoCapitalize="sentences"
          maxFontSizeMultiplier={1.3}
          style={[textStyles.body, styles.input]}
          accessibilityLabel={`Rule ${index + 1} text`}
          testID={`wizard-step3-row-${index}-text`}
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
  input: {
    paddingHorizontal: spacing.base,
    paddingVertical: spacing.md,
    color: colors.ink,
    minHeight: 96,
    textAlignVertical: 'top',
  },
});

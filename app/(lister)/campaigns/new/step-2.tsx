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
import { Chip } from '@/components/primitives/Chip';
import { colors, radii, shadows, spacing } from '@/design/tokens';
import { textStyles } from '@/design/typography';
import {
  useWizard,
  type WizardPreCondition,
  type WizardPreConditionMetric,
  type WizardPreConditionPlatform,
} from '@/screens/campaign-wizard/WizardStore';

// US-050 — Create-campaign wizard step 2 (pre-conditions). Each row captures a
// single eligibility rule: platform + metric + numeric threshold. Operator is
// fixed at ">=" per the story AC and maps to `listing_conditions.operator = 'gte'`
// at step-5 publish time.
//
// Rows are stored in the wizard draft (AsyncStorage-backed, see WizardStore).
// UI metric keys ('followers' / 'avg_views') are intentionally UI-friendly and
// get mapped to DB `condition_metric` values ('min_followers' / 'min_avg_views_last_n')
// during publish — keeping the wizard store decoupled from the DB enum names
// means we can evolve either side without cross-stepping migrations.
//
// Pre-conditions are optional — an empty list is a valid "open to everyone"
// listing. Next is always enabled.

const PLATFORMS: readonly { value: WizardPreConditionPlatform; label: string }[] = [
  { value: 'tiktok', label: 'TikTok' },
  { value: 'instagram', label: 'Instagram' },
];

const METRICS: readonly { value: WizardPreConditionMetric; label: string }[] = [
  { value: 'followers', label: 'Followers' },
  { value: 'avg_views', label: 'Avg views' },
];

// Digits only; empty string clears. `maxLength` on the input caps at 12 digits
// (≈ 1 trillion) which is well beyond any realistic follower/view threshold
// while keeping the cast safe from overflow into BigInt territory.
const THRESHOLD_INPUT_RE = /^\d*$/;

function makeLocalId(): string {
  return `cnd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export default function CampaignWizardStep2() {
  const { draft, updateField } = useWizard();

  // All three mutations use `updateField`'s functional updater so rapid-fire
  // taps (e.g. "Add condition" pressed twice before a re-render) read the
  // latest array rather than the closure-captured snapshot.
  const onAddRow = useCallback(() => {
    const row: WizardPreCondition = {
      id: makeLocalId(),
      platform: 'tiktok',
      metric: 'followers',
      threshold: 0,
    };
    updateField('preConditions', (prev) => [...prev, row]);
  }, [updateField]);

  const onRemoveRow = useCallback(
    (id: string) => {
      updateField('preConditions', (prev) => prev.filter((row) => row.id !== id));
    },
    [updateField],
  );

  const onUpdateRow = useCallback(
    (id: string, patch: Partial<Omit<WizardPreCondition, 'id'>>) => {
      updateField('preConditions', (prev) =>
        prev.map((row) => (row.id === id ? { ...row, ...patch } : row)),
      );
    },
    [updateField],
  );

  const onNext = useCallback(() => {
    router.push('/(lister)/campaigns/new/step-3');
  }, []);

  const onBack = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/(lister)/campaigns/new/step-1');
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
              testID="wizard-step2-back"
              style={styles.backBtn}
            >
              <ChevronLeft size={24} color={colors.ink} />
            </Pressable>
            <Text style={[textStyles.micro, styles.stepLabel]} allowFontScaling={false}>
              Step 2 of 5
            </Text>
            <Text style={[textStyles.display, styles.title]} maxFontSizeMultiplier={1.3}>
              Who can apply?
            </Text>
            <Text style={[textStyles.body, styles.subtitle]} maxFontSizeMultiplier={1.3}>
              Set eligibility rules for creators. Leave empty to accept anyone.
            </Text>
          </View>

          <View style={styles.rows}>
            {draft.preConditions.map((row, index) => (
              <ConditionCard
                key={row.id}
                row={row}
                index={index}
                onUpdate={onUpdateRow}
                onRemove={onRemoveRow}
              />
            ))}
            {draft.preConditions.length === 0 ? (
              <Text style={[textStyles.body, styles.emptyHint]} maxFontSizeMultiplier={1.3}>
                No rules yet. Add one below.
              </Text>
            ) : null}
            <ButtonSecondary
              label="Add condition"
              onPress={onAddRow}
              accessibilityLabel="Add pre-condition"
              testID="wizard-step2-add"
            />
          </View>

          <ButtonPrimary
            label="Next"
            onPress={onNext}
            accessibilityLabel="Go to wizard step 3"
            testID="wizard-step2-next"
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

type ConditionCardProps = {
  row: WizardPreCondition;
  index: number;
  onUpdate: (id: string, patch: Partial<Omit<WizardPreCondition, 'id'>>) => void;
  onRemove: (id: string) => void;
};

function ConditionCard({ row, index, onUpdate, onRemove }: ConditionCardProps) {
  const onPlatformPick = useCallback(
    (platform: WizardPreConditionPlatform) => onUpdate(row.id, { platform }),
    [onUpdate, row.id],
  );
  const onMetricPick = useCallback(
    (metric: WizardPreConditionMetric) => onUpdate(row.id, { metric }),
    [onUpdate, row.id],
  );
  const onThresholdChange = useCallback(
    (next: string) => {
      if (next !== '' && !THRESHOLD_INPUT_RE.test(next)) return;
      const parsed = next === '' ? 0 : Number.parseInt(next, 10);
      onUpdate(row.id, { threshold: Number.isFinite(parsed) ? parsed : 0 });
    },
    [onUpdate, row.id],
  );
  const onRemovePress = useCallback(() => onRemove(row.id), [onRemove, row.id]);

  const thresholdDisplay = row.threshold === 0 ? '' : String(row.threshold);

  return (
    <View style={[styles.card, shadows.hard]} testID={`wizard-step2-row-${index}`}>
      <View style={styles.cardHeader}>
        <Text style={[textStyles.caption, styles.cardTitle]} maxFontSizeMultiplier={1.3}>
          Rule {index + 1}
        </Text>
        <Pressable
          onPress={onRemovePress}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          accessibilityRole="button"
          accessibilityLabel={`Remove rule ${index + 1}`}
          testID={`wizard-step2-remove-${index}`}
        >
          <Trash2 size={18} color={colors.ink70} />
        </Pressable>
      </View>

      <View style={styles.group}>
        <Text style={[textStyles.caption, styles.label]} maxFontSizeMultiplier={1.3}>
          Platform
        </Text>
        <View style={styles.chipRow}>
          {PLATFORMS.map((p) => (
            <Chip
              key={p.value}
              label={p.label}
              active={row.platform === p.value}
              onPress={() => onPlatformPick(p.value)}
              accessibilityLabel={`Platform ${p.label}`}
              testID={`wizard-step2-row-${index}-platform-${p.value}`}
            />
          ))}
        </View>
      </View>

      <View style={styles.group}>
        <Text style={[textStyles.caption, styles.label]} maxFontSizeMultiplier={1.3}>
          Metric
        </Text>
        <View style={styles.chipRow}>
          {METRICS.map((m) => (
            <Chip
              key={m.value}
              label={m.label}
              active={row.metric === m.value}
              onPress={() => onMetricPick(m.value)}
              accessibilityLabel={`Metric ${m.label}`}
              testID={`wizard-step2-row-${index}-metric-${m.value}`}
            />
          ))}
        </View>
      </View>

      <View style={styles.thresholdRow}>
        <View style={[styles.opBadge, shadows.hard]}>
          <Text style={[textStyles.micro, styles.opBadgeText]} allowFontScaling={false}>
            {'\u2265'}
          </Text>
        </View>
        <View style={[styles.inputWrap, shadows.hard]}>
          <TextInput
            value={thresholdDisplay}
            onChangeText={onThresholdChange}
            placeholder="0"
            placeholderTextColor={colors.ink40}
            keyboardType="number-pad"
            maxLength={12}
            style={[textStyles.body, styles.input]}
            accessibilityLabel="Threshold"
            testID={`wizard-step2-row-${index}-threshold`}
          />
        </View>
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
  group: {
    gap: spacing.xs,
  },
  label: {
    color: colors.ink70,
  },
  chipRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    flexWrap: 'wrap',
  },
  thresholdRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'center',
  },
  opBadge: {
    width: 44,
    height: 48,
    borderRadius: radii.input,
    borderWidth: 2,
    borderColor: colors.ink,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  opBadgeText: {
    color: colors.primaryDeep,
  },
  inputWrap: {
    flex: 1,
    backgroundColor: colors.surface,
    borderRadius: radii.input,
    borderWidth: 2,
    borderColor: colors.ink,
  },
  input: {
    paddingHorizontal: spacing.base,
    paddingVertical: spacing.md,
    color: colors.ink,
    minHeight: 48,
  },
});


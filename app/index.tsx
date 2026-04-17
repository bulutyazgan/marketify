import { useState } from 'react';
import { SafeAreaView, ScrollView, StyleSheet, Text, View } from 'react-native';
import { BottomSheet } from '@/components/primitives/BottomSheet';
import { ButtonPrimary, ButtonSecondary } from '@/components/primitives/Button';
import { CampaignCard } from '@/components/primitives/CampaignCard';
import { Chip } from '@/components/primitives/Chip';
import { SkeletonCard } from '@/components/primitives/SkeletonCard';
import { StatusPill } from '@/components/primitives/StatusPill';
import { useToast } from '@/components/primitives/Toast';
import { colors, spacing } from '@/design/tokens';
import { textStyles } from '@/design/typography';

export default function Index() {
  const [eligibleOnly, setEligibleOnly] = useState(true);
  const [platform, setPlatform] = useState(false);
  const [price, setPrice] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const toast = useToast();

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <Text style={[textStyles.display, styles.title]}>Marketify</Text>

        <View style={styles.stack}>
          <ButtonPrimary label="Primary CTA" onPress={() => {}} testID="btn-primary" />
          <ButtonSecondary label="Secondary" onPress={() => {}} testID="btn-secondary" />
          <ButtonPrimary label="Disabled" onPress={() => {}} disabled testID="btn-disabled" />
          <ButtonPrimary label="Loading" onPress={() => {}} loading testID="btn-loading" />
        </View>

        <Text style={[textStyles.h2, styles.sectionHeader]}>Chips</Text>
        <View style={styles.chipRow}>
          <Chip
            label="Eligible only"
            active={eligibleOnly}
            onPress={() => setEligibleOnly((v) => !v)}
            testID="chip-eligible"
          />
          <Chip
            label="Platform"
            active={platform}
            onPress={() => setPlatform((v) => !v)}
            testID="chip-platform"
          />
          <Chip
            label="Price"
            active={price}
            onPress={() => setPrice((v) => !v)}
            testID="chip-price"
          />
          <Chip label="Disabled" active={false} disabled testID="chip-disabled" />
        </View>

        <Text style={[textStyles.h2, styles.sectionHeader]}>Status pills</Text>
        <View style={styles.pillRow}>
          <StatusPill status="pending" testID="pill-pending" />
          <StatusPill status="approved" testID="pill-approved" />
          <StatusPill status="rejected" testID="pill-rejected" />
          <StatusPill status="cancelled" testID="pill-cancelled" />
        </View>

        <Text style={[textStyles.h2, styles.sectionHeader]}>Campaign cards</Text>
        <View style={styles.cardStack}>
          <CampaignCard
            title="Clean Beauty Review"
            listerHandle="@cleanco"
            priceCents={25000}
            currency="USD"
            preConditionSummary="50K+ TikTok followers · 5K+ avg views"
            status="pending"
            onPress={() => {}}
            testID="card-clean-beauty"
          />
          <CampaignCard
            title="Summer Travel Collab"
            listerHandle="@nomadgear"
            priceCents={80000}
            currency="EUR"
            preConditionSummary="20K+ Instagram followers"
            status="approved"
            onPress={() => {}}
            testID="card-summer-travel"
          />
          <SkeletonCard height={160} testID="skeleton-card" />
        </View>

        <Text style={[textStyles.h2, styles.sectionHeader]}>Bottom sheet + toasts</Text>
        <View style={styles.stack}>
          <ButtonPrimary
            label="Open filters sheet"
            onPress={() => setSheetOpen(true)}
            testID="btn-open-sheet"
          />
          <ButtonSecondary
            label="Show success toast"
            onPress={() =>
              toast.show({ message: "You're in. 12 campaigns match you.", variant: 'success' })
            }
            testID="btn-toast-success"
          />
          <ButtonSecondary
            label="Show error toast"
            onPress={() =>
              toast.show({
                message: 'Try again in 5h 12m — metrics recently refreshed.',
                variant: 'error',
              })
            }
            testID="btn-toast-error"
          />
          <ButtonSecondary
            label="Show info toast"
            onPress={() =>
              toast.show({ message: 'Pulling your stats — this takes up to 60 seconds.' })
            }
            testID="btn-toast-info"
          />
        </View>
      </ScrollView>

      <BottomSheet
        visible={sheetOpen}
        onDismiss={() => setSheetOpen(false)}
        snapPoints={[0.55]}
        accessibilityLabel="Filters"
        testID="sheet-filters"
      >
        <Text style={[textStyles.h1, styles.sheetTitle]}>Filters</Text>
        <Text style={[textStyles.body, styles.sheetBody]}>
          Drag down or tap the backdrop to dismiss. Snap-points, scrim, and spring slide-up per
          docs/design.md §3.3.
        </Text>
        <View style={styles.chipRow}>
          <Chip label="TikTok" active onPress={() => {}} />
          <Chip label="Instagram" active={false} onPress={() => {}} />
          <Chip label="High reach" active={false} onPress={() => {}} />
        </View>
        <View style={styles.sheetFooter}>
          <ButtonPrimary label="Apply filters" onPress={() => setSheetOpen(false)} />
        </View>
      </BottomSheet>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.canvas,
  },
  scroll: {
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.xxl,
    alignItems: 'stretch',
  },
  title: {
    color: colors.ink,
    marginBottom: spacing.xxl,
    alignSelf: 'center',
  },
  stack: {
    alignSelf: 'stretch',
    gap: spacing.base,
  },
  sectionHeader: {
    color: colors.ink,
    marginTop: spacing.xxl,
    marginBottom: spacing.base,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  pillRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    alignItems: 'center',
  },
  cardStack: {
    gap: spacing.base,
  },
  sheetTitle: {
    color: colors.ink,
    marginBottom: spacing.sm,
  },
  sheetBody: {
    color: colors.ink70,
    marginBottom: spacing.base,
  },
  sheetFooter: {
    marginTop: spacing.lg,
  },
});

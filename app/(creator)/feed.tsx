import { Pressable, SafeAreaView, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { TabPlaceholder } from '@/components/shared/TabPlaceholder';
import { colors, radii, shadows, spacing } from '@/design/tokens';
import { textStyles } from '@/design/typography';

// US-038 replaces the placeholder with the real Discover feed. Until it
// lands, a __DEV__-only launcher surfaces the two seeded campaigns so
// US-040's detail screen can be reached for mobile-mcp verification.
// The dev block compiles out of prod bundles per Codebase Pattern #96
// (all dev-only data lives inside the guarded component).
export default function Feed() {
  return (
    <>
      <TabPlaceholder
        title="Discover"
        subtitle="The eligibility-filtered campaign feed lands in US-038."
      />
      {__DEV__ ? <DevCampaignLauncher /> : null}
    </>
  );
}

function DevCampaignLauncher() {
  const SAMPLES: { id: string; title: string; hint: string }[] = [
    {
      id: '11111111-1111-1111-1111-111111111010',
      title: 'Promote Acme Headphones',
      hint: 'Eligible for the seed creator',
    },
    {
      id: '22222222-2222-2222-2222-222222222010',
      title: 'Mega-Influencer Luxe Launch',
      hint: 'Ineligible — high thresholds',
    },
  ];
  return (
    <SafeAreaView style={styles.overlay} pointerEvents="box-none">
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[textStyles.micro, { color: colors.ink70 }]}>Dev sample campaigns</Text>
        <View style={styles.list}>
          {SAMPLES.map((s) => (
            <Pressable
              key={s.id}
              style={[styles.card, shadows.hard]}
              onPress={() => router.push(`/(creator)/listing/${s.id}`)}
              accessibilityRole="button"
              accessibilityLabel={`Open dev campaign: ${s.title}`}
              testID={`dev-campaign-${s.id}`}
            >
              <Text style={[textStyles.h2, { color: colors.ink }]}>{s.title}</Text>
              <Text style={[textStyles.caption, { color: colors.ink70 }]}>{s.hint}</Text>
            </Pressable>
          ))}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
  },
  content: {
    padding: spacing.base,
    gap: spacing.md,
  },
  list: {
    gap: spacing.md,
  },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.ink,
    borderWidth: 2,
    borderRadius: radii.card,
    padding: spacing.base,
    gap: spacing.xs,
  },
});

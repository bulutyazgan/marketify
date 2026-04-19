import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Pressable,
  RefreshControl,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { router } from 'expo-router';
import { CampaignCard, type CampaignCardCurrency } from '@/components/primitives/CampaignCard';
import { SkeletonCard } from '@/components/primitives/SkeletonCard';
import { type StatusPillStatus } from '@/components/primitives/StatusPill';
import { EmptyState } from '@/components/shared/EmptyState';
import { Fab } from '@/components/shared/Fab';
import { colors, radii, shadows, spacing } from '@/design/tokens';
import { textStyles } from '@/design/typography';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import type { Database } from '@/types/supabase';

// US-054 — Lister "My Campaigns" tab. Calls the `list_my_campaigns`
// SECURITY DEFINER RPC (companion migration
// `us_054_list_my_campaigns_rpc`) which returns the caller's listings
// plus per-row applications_count + submissions_count. Same ownership
// model as US-043's `list_my_applications` (Codebase Pattern #118).
//
// Segments: Active vs Inactive per AC. `active` status → Active segment;
// `draft|paused|closed|archived` → Inactive. The DB enum has five
// values; the two-segment UX matches the AC's "two segments: Active /
// Inactive (status)" wording — listers don't need finer status
// breakdowns here, and the per-card StatusPill surfaces the specific
// sub-status inside Inactive.
//
// FAB mirrors the Dashboard (docs/design.md §3.2 — FAB on both tabs) and
// routes to the wizard step 1. Each CampaignCard taps through to the
// edit-campaign screen (US-055) at
// `/(lister)/campaigns/[id]/edit`.

type ListingStatus = Database['public']['Enums']['listing_status'];
type Segment = 'active' | 'inactive';
type CampaignRow = Database['public']['Functions']['list_my_campaigns']['Returns'][number];

const SEGMENT_OF: Record<ListingStatus, Segment> = {
  active: 'active',
  draft: 'inactive',
  paused: 'inactive',
  closed: 'inactive',
  archived: 'inactive',
};

// Sub-status → StatusPill palette. `StatusPillStatus` is the existing
// application/submission palette (pending/approved/rejected/cancelled);
// reusing those hues to stay inside docs/design.md §1.2's semantic trio:
//   active  → approved  (success green)
//   draft   → pending   (warning amber)
//   paused/closed/archived → cancelled (grey)
// The label override on StatusPill surfaces the actual listing status.
const STATUS_PILL: Record<ListingStatus, { pill: StatusPillStatus; label: string }> = {
  active: { pill: 'approved', label: 'Active' },
  draft: { pill: 'pending', label: 'Draft' },
  paused: { pill: 'cancelled', label: 'Paused' },
  closed: { pill: 'cancelled', label: 'Closed' },
  archived: { pill: 'cancelled', label: 'Archived' },
};

const SEGMENTS: readonly { key: Segment; label: string }[] = [
  { key: 'active', label: 'Active' },
  { key: 'inactive', label: 'Inactive' },
];

type SegmentControlProps = {
  active: Segment;
  counts: Record<Segment, number>;
  onChange: (next: Segment) => void;
};

function SegmentControl({ active, counts, onChange }: SegmentControlProps) {
  return (
    <View style={styles.segmentRow} accessibilityRole="tablist">
      {SEGMENTS.map((s) => (
        <SegmentButton
          key={s.key}
          label={`${s.label} (${counts[s.key]})`}
          selected={active === s.key}
          onPress={() => onChange(s.key)}
          testID={`segment-${s.key}`}
        />
      ))}
    </View>
  );
}

type SegmentButtonProps = {
  label: string;
  selected: boolean;
  onPress: () => void;
  testID?: string;
};

function SegmentButton({ label, selected, onPress, testID }: SegmentButtonProps) {
  const bg = selected ? colors.primarySoft : colors.surface;
  const textColor = selected ? colors.primaryDeep : colors.ink;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="tab"
      accessibilityState={{ selected }}
      accessibilityLabel={label}
      style={[styles.segment, { backgroundColor: bg }, shadows.hard]}
      testID={testID}
    >
      <Text style={[textStyles.micro, { color: textColor }]} allowFontScaling={false}>
        {label}
      </Text>
    </Pressable>
  );
}

export default function ListerCampaigns() {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const handle = user?.username ?? '';

  const [segment, setSegment] = useState<Segment>('active');
  const [rows, setRows] = useState<CampaignRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!userId) return;
    setError(null);
    const { data, error: rpcError } = await supabase.rpc('list_my_campaigns');
    if (rpcError) {
      setError("Couldn't load campaigns.");
      setRows([]);
    } else {
      setRows(data ?? []);
    }
  }, [userId]);

  useEffect(() => {
    setLoading(true);
    void load().finally(() => setLoading(false));
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const onCreate = useCallback(() => {
    router.push('/(lister)/campaigns/new/step-1');
  }, []);

  const onOpenCampaign = useCallback((id: string) => {
    router.push({ pathname: '/(lister)/campaigns/[id]/edit', params: { id } });
  }, []);

  const byBucket = useMemo(() => {
    const map: Record<Segment, CampaignRow[]> = { active: [], inactive: [] };
    for (const r of rows) {
      map[SEGMENT_OF[r.status]].push(r);
    }
    return map;
  }, [rows]);

  const counts = useMemo<Record<Segment, number>>(
    () => ({ active: byBucket.active.length, inactive: byBucket.inactive.length }),
    [byBucket],
  );

  const visible = byBucket[segment];

  return (
    <SafeAreaView style={styles.root}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.ink} />
        }
      >
        <Text style={[textStyles.display, styles.header]}>Campaigns</Text>
        <SegmentControl active={segment} counts={counts} onChange={setSegment} />

        {loading ? (
          <View style={styles.list} testID="campaigns-loading">
            <SkeletonCard />
            <SkeletonCard />
          </View>
        ) : error ? (
          <View style={styles.emptyBox}>
            <Text style={[textStyles.body, { color: colors.danger }]}>{error}</Text>
          </View>
        ) : visible.length === 0 ? (
          <EmptyState
            testID={`campaigns-empty-${segment}`}
            illustration="lister_no_campaigns"
            title={emptyTitleFor(segment)}
            body={emptyMessageFor(segment)}
            primaryAction={
              segment === 'active'
                ? {
                    label: 'Post a bounty',
                    caption: 'Create a campaign and creators can start applying.',
                    onPress: onCreate,
                    testID: 'campaigns-empty-cta-post',
                  }
                : undefined
            }
          />
        ) : (
          <View style={styles.list}>
            {visible.map((row) => (
              <CampaignCard
                key={row.id}
                title={row.title}
                listerHandle={handle}
                priceCents={row.price_cents}
                currency={row.currency as CampaignCardCurrency}
                status={STATUS_PILL[row.status].pill}
                statusLabel={STATUS_PILL[row.status].label}
                meta={[
                  { label: 'applications', value: row.applications_count },
                  { label: 'submissions', value: row.submissions_count },
                ]}
                onPress={() => onOpenCampaign(row.id)}
                testID={`campaign-${row.id}`}
              />
            ))}
          </View>
        )}
      </ScrollView>
      <Fab onPress={onCreate} accessibilityLabel="Create campaign" testID="lister-fab-create" />
    </SafeAreaView>
  );
}

function emptyTitleFor(segment: Segment): string {
  return segment === 'active' ? 'No active campaigns' : 'No inactive campaigns';
}

function emptyMessageFor(segment: Segment): string {
  return segment === 'active'
    ? 'Your live bounties will show up here.'
    : 'Drafts, paused, and closed campaigns would appear here.';
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas },
  scroll: {
    padding: spacing.base,
    gap: spacing.md,
    paddingBottom: spacing.xxxl,
  },
  header: {
    color: colors.ink,
    marginBottom: spacing.xs,
  },
  segmentRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginBottom: spacing.xs,
  },
  segment: {
    minHeight: 32,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
    borderRadius: radii.pill,
    borderWidth: 2,
    borderColor: colors.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  list: {
    gap: spacing.md,
  },
  emptyBox: {
    padding: spacing.lg,
    alignItems: 'center',
  },
});

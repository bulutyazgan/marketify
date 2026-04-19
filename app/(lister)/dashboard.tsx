import { useCallback, useEffect, useState } from 'react';
import {
  RefreshControl,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { router } from 'expo-router';
import { Fab } from '@/components/shared/Fab';
import { SkeletonCard } from '@/components/primitives/SkeletonCard';
import { useToast } from '@/components/primitives/Toast';
import { ErrorState } from '@/components/shared/ErrorState';
import { colors, radii, shadows, spacing } from '@/design/tokens';
import { textStyles } from '@/design/typography';
import { useAuth } from '@/lib/auth';
import { classifySupabaseError, transientErrorMessage } from '@/lib/errors';
import { supabase } from '@/lib/supabase';
import type { Database } from '@/types/supabase';

// US-048 — Lister Home/dashboard. Calls `lister_dashboard_counts` (single
// SECURITY INVOKER RPC returning three ints: active_campaigns,
// pending_applications, pending_submissions — see companion migration
// `us_048_lister_dashboard_counts_rpc`). Three tiles are the v1 scope per
// docs/product-plan.md line 124 ("Lister analytics dashboard: just counts
// in v1"). FAB per docs/design.md §2.3 + §3.2 routes to the campaign
// wizard step 1 (route lands in US-049 — the FAB is wired ahead so it
// starts working the instant the route file exists).
//
// Spec gap: US-048 AC names `app/(lister)/index.tsx` but the canonical
// route per docs/design.md §2.3 is `/(lister)/dashboard` and the file
// already lives at `app/(lister)/dashboard.tsx` (US-031). Specs win;
// overwriting the placeholder here instead of creating index.tsx.

type CountsRow = Database['public']['Functions']['lister_dashboard_counts']['Returns'][number];

type Tile = {
  key: keyof CountsRow;
  label: string;
};

const TILES: readonly Tile[] = [
  { key: 'active_campaigns', label: 'Active campaigns' },
  { key: 'pending_applications', label: 'Pending applications' },
  { key: 'pending_submissions', label: 'Pending submissions' },
];

const ZERO_COUNTS: CountsRow = {
  active_campaigns: 0,
  pending_applications: 0,
  pending_submissions: 0,
};

export default function ListerDashboard() {
  const { user } = useAuth();
  const userId = user?.id ?? null;

  const [counts, setCounts] = useState<CountsRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { show: showToast } = useToast();

  const load = useCallback(async () => {
    if (!userId) return;
    setError(null);
    const { data, error: rpcError } = await supabase.rpc('lister_dashboard_counts');
    if (rpcError) {
      setError("Couldn't load dashboard stats.");
      setCounts(null);
      const info = await classifySupabaseError(rpcError);
      if (info.isTransient) {
        showToast({ message: transientErrorMessage(info), variant: 'error' });
      }
    } else {
      // RPC returns `setof record` so data is an array; the function
      // always yields exactly one row (three scalar sub-selects joined by
      // comma), but fall back to zeros if the client receives an empty
      // payload for any reason.
      setCounts(data?.[0] ?? ZERO_COUNTS);
    }
  }, [userId, showToast]);

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

  return (
    <SafeAreaView style={styles.root}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.ink} />
        }
      >
        <Text style={[textStyles.display, styles.header]}>Home</Text>

        {loading ? (
          <View style={styles.tileList} testID="dashboard-loading">
            <SkeletonCard height={96} />
            <SkeletonCard height={96} />
            <SkeletonCard height={96} />
          </View>
        ) : error ? (
          <ErrorState
            testID="dashboard-error"
            body={error}
            onRetry={() => {
              setLoading(true);
              void load().finally(() => setLoading(false));
            }}
          />
        ) : isAllZero(counts) ? (
          <View style={styles.emptyBox} testID="dashboard-empty">
            <Text style={[textStyles.body, { color: colors.ink70, textAlign: 'center' }]}>
              Post your first bounty.
            </Text>
          </View>
        ) : (
          <View style={styles.tileList}>
            {TILES.map((tile) => (
              <StatTile
                key={tile.key}
                label={tile.label}
                value={counts?.[tile.key] ?? 0}
                testID={`stat-${tile.key}`}
              />
            ))}
          </View>
        )}
      </ScrollView>
      <Fab
        onPress={onCreate}
        accessibilityLabel="Create campaign"
        testID="lister-fab-create"
      />
    </SafeAreaView>
  );
}

type StatTileProps = {
  label: string;
  value: number;
  testID?: string;
};

function StatTile({ label, value, testID }: StatTileProps) {
  return (
    <View
      style={[styles.tile, shadows.hard]}
      accessibilityRole="text"
      accessibilityLabel={`${label}: ${value}`}
      testID={testID}
    >
      <Text style={[textStyles.display, styles.tileValue]} maxFontSizeMultiplier={1.3}>
        {value}
      </Text>
      <Text style={[textStyles.caption, styles.tileLabel]} maxFontSizeMultiplier={1.3}>
        {label}
      </Text>
    </View>
  );
}

function isAllZero(c: CountsRow | null): boolean {
  if (!c) return false;
  return c.active_campaigns === 0 && c.pending_applications === 0 && c.pending_submissions === 0;
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
  tileList: {
    gap: spacing.md,
  },
  tile: {
    backgroundColor: colors.surface,
    borderColor: colors.ink,
    borderWidth: 2,
    borderRadius: radii.card,
    padding: spacing.base,
    gap: spacing.xs,
  },
  tileValue: {
    color: colors.ink,
  },
  tileLabel: {
    color: colors.ink70,
  },
  emptyBox: {
    padding: spacing.lg,
    alignItems: 'center',
  },
});

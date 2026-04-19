import { useCallback, useEffect, useRef, useState } from 'react';
import {
  RefreshControl,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { router } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { CampaignCard } from '@/components/primitives/CampaignCard';
import { Chip } from '@/components/primitives/Chip';
import { SkeletonCard } from '@/components/primitives/SkeletonCard';
import { useToast } from '@/components/primitives/Toast';
import { EmptyState } from '@/components/shared/EmptyState';
import { ErrorState } from '@/components/shared/ErrorState';
import { colors, spacing } from '@/design/tokens';
import { textStyles } from '@/design/typography';
import { classifySupabaseError, transientErrorMessage } from '@/lib/errors';
import { supabase } from '@/lib/supabase';
import type { Database } from '@/types/supabase';

// US-038 — Creator Discover feed. Renders a header Chip toggle for
// "Eligible only" plus a pull-to-refresh list of CampaignCards sourced from
// the `list_discover_feed(p_eligible_only)` SECURITY DEFINER RPC (see the
// us_038 migration for rationale — a plain PostgREST embed would silently
// null lister_handle under the self-only users RLS policy).
//
// Persistence: the toggle state is stored in AsyncStorage under
// FILTER_STORAGE_KEY (spec says MMKV but Codebase Pattern #91 rules MMKV
// out under Expo Go; a non-secret boolean preference doesn't warrant the
// SecureStore ceremony either, so AsyncStorage is the right fit).
// Default is eligible_only=true per AC.
//
// Empty state per docs/design.md §5.5 — the "See all campaigns" action
// flips the toggle off (which reloads) rather than routing elsewhere.

type DiscoverRow = Database['public']['Functions']['list_discover_feed']['Returns'][number];

const FILTER_STORAGE_KEY = 'marketify.discoverEligibleOnly';
const HYDRATED_DEFAULT = true;

function readCurrency(raw: string): 'USD' | 'EUR' | 'GBP' {
  return raw === 'EUR' || raw === 'GBP' ? raw : 'USD';
}

export default function Feed() {
  // Toggle is hydrated async from AsyncStorage — until the read settles we
  // render with the default and flip in place once storage returns. This
  // matches the storage-hydration pattern from AuthProvider (Pattern #97).
  const [eligibleOnly, setEligibleOnly] = useState<boolean>(HYDRATED_DEFAULT);
  const [hydrated, setHydrated] = useState<boolean>(false);

  const [rows, setRows] = useState<DiscoverRow[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const { show: showToast } = useToast();

  // Synchronous ref mirrors the latest toggle value so the `load` callback
  // never stale-captures it (Pattern #106). React state still drives the UI.
  const eligibleRef = useRef<boolean>(HYDRATED_DEFAULT);
  // Monotonic counter so rapid toggle flips don't let a stale response
  // overwrite fresh data — only the latest dispatch's rows hit state.
  const loadSeqRef = useRef<number>(0);

  useEffect(() => {
    let cancelled = false;
    void AsyncStorage.getItem(FILTER_STORAGE_KEY).then((raw) => {
      if (cancelled) return;
      const next = raw === null ? HYDRATED_DEFAULT : raw === 'true';
      eligibleRef.current = next;
      setEligibleOnly(next);
      setHydrated(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const load = useCallback(async (isRefresh: boolean) => {
    const seq = ++loadSeqRef.current;
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    setError(null);

    const { data, error: rpcError } = await supabase.rpc('list_discover_feed', {
      p_eligible_only: eligibleRef.current,
    });
    if (loadSeqRef.current !== seq) return;
    if (rpcError) {
      setError("Couldn't load campaigns.");
      setRows([]);
      const info = await classifySupabaseError(rpcError);
      if (info.isTransient) {
        showToast({ message: transientErrorMessage(info), variant: 'error' });
      }
    } else {
      setRows(data ?? []);
    }
    if (isRefresh) setRefreshing(false);
    else setLoading(false);
  }, [showToast]);

  // Re-fetch whenever the toggle changes, but only after hydration — the
  // first effect run will otherwise fire twice (once with the default,
  // once with the hydrated value).
  useEffect(() => {
    if (!hydrated) return;
    eligibleRef.current = eligibleOnly;
    void load(false);
  }, [eligibleOnly, hydrated, load]);

  const onToggleEligible = useCallback(() => {
    setEligibleOnly((prev) => {
      const next = !prev;
      void AsyncStorage.setItem(FILTER_STORAGE_KEY, next ? 'true' : 'false');
      return next;
    });
  }, []);

  const onRefresh = useCallback(() => {
    void load(true);
  }, [load]);

  const onCardPress = useCallback((id: string) => {
    router.push(`/(creator)/listing/${id}`);
  }, []);

  return (
    <SafeAreaView style={styles.root}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.ink} />
        }
      >
        <Text style={[textStyles.display, styles.header]}>Discover</Text>

        <View style={styles.filterRow}>
          <Chip
            label="Eligible only"
            active={eligibleOnly}
            onPress={onToggleEligible}
            testID="chip-eligible-only"
          />
        </View>

        {loading ? (
          <View style={styles.list} testID="discover-loading">
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
          </View>
        ) : error ? (
          <ErrorState
            testID="discover-error"
            body={error}
            onRetry={() => {
              setError(null);
              void load(false);
            }}
          />
        ) : rows.length === 0 ? (
          <EmptyState
            testID="discover-empty"
            illustration="no_eligible"
            title="Nothing matches you — yet."
            body={'Campaigns get added daily. Meanwhile, here\u2019s what to try.'}
            primaryAction={{
              label: 'Refresh your metrics',
              caption: 'Your follower counts may be out of date.',
              onPress: () => router.push('/(creator)/profile'),
              testID: 'empty-action-refresh',
            }}
            secondaryAction={
              eligibleOnly
                ? {
                    label: 'See all campaigns',
                    caption: 'Turn off the eligibility filter.',
                    onPress: onToggleEligible,
                    testID: 'empty-action-see-all',
                  }
                : undefined
            }
          />
        ) : (
          <View style={styles.list} testID="discover-list">
            {rows.map((r) => (
              <CampaignCard
                key={r.id}
                title={r.title}
                listerHandle={`@${r.lister_handle}`}
                priceCents={r.price_cents}
                currency={readCurrency(r.currency)}
                onPress={() => onCardPress(r.id)}
                testID={`campaign-card-${r.id}`}
              />
            ))}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
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
  filterRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginBottom: spacing.xs,
  },
  list: {
    gap: spacing.md,
  },
});

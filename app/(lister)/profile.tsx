import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { ButtonSecondary } from '@/components/primitives/Button';
import { useToast } from '@/components/primitives/Toast';
import { colors, radii, shadows, spacing } from '@/design/tokens';
import { textStyles } from '@/design/typography';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import type { Database } from '@/types/supabase';

// US-037 — lister profile. Renders org_name (from lister_profiles),
// email + username (from users via AuthContext), and a canonical sign-out
// button. Sign-out clears the persisted JWT via AuthProvider.signOut,
// which triggers the role-based router at app/index.tsx to drop the user
// back into the (auth) group.

type ListerProfileRow = Database['public']['Tables']['lister_profiles']['Row'];

export default function ListerProfile() {
  const { user, signOut } = useAuth();
  const { show: showToast } = useToast();

  const [profile, setProfile] = useState<ListerProfileRow | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('lister_profiles')
        .select('*')
        .eq('user_id', user.id)
        .maybeSingle();
      if (error) throw error;
      setProfile(data ?? null);
    } catch (err) {
      console.error('Lister profile load failed', err);
      showToast({ message: 'Could not load profile.', variant: 'error' });
    } finally {
      setLoading(false);
    }
  }, [user, showToast]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <View style={styles.header}>
          <Text style={[textStyles.display, { color: colors.ink }]}>Profile</Text>
          {user ? (
            <Text style={[textStyles.mono, styles.usernameRow]}>@{user.username}</Text>
          ) : null}
        </View>

        {loading && profile === null ? (
          <View style={styles.loadingBlock}>
            <ActivityIndicator color={colors.ink} />
          </View>
        ) : (
          <View style={styles.card} testID="lister-company-card">
            <Text style={[textStyles.h2, { color: colors.ink }]}>Company</Text>
            <DetailRow label="Organization" value={profile?.org_name ?? null} />
            <DetailRow label="Email" value={user?.email ?? null} />
          </View>
        )}

        <View style={styles.signOutWrap}>
          <ButtonSecondary
            label="Sign out"
            onPress={signOut}
            accessibilityLabel="Sign out"
            testID="lister-signout"
          />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function DetailRow({ label, value }: { label: string; value: string | null }) {
  return (
    <View style={styles.detailRow}>
      <Text style={[textStyles.caption, { color: colors.ink70 }]}>{label}</Text>
      <Text style={[textStyles.body, { color: colors.ink }]}>{value ?? '—'}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.canvas,
  },
  scrollContent: {
    padding: spacing.base,
    gap: spacing.xl,
    paddingBottom: spacing.xxxl,
  },
  header: {
    gap: spacing.xs,
    paddingTop: spacing.base,
  },
  usernameRow: {
    color: colors.ink70,
  },
  loadingBlock: {
    alignItems: 'center',
    paddingVertical: spacing.xxl,
  },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.ink,
    borderWidth: 2,
    borderRadius: radii.card,
    padding: spacing.base,
    gap: spacing.md,
    ...shadows.hard,
  },
  detailRow: {
    gap: spacing.xs,
  },
  signOutWrap: {
    paddingTop: spacing.md,
  },
});

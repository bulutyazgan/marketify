import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router, usePathname } from 'expo-router';
import { Bell } from 'lucide-react-native';
import { colors, shadows, spacing } from '@/design/tokens';
import { fontFamilies } from '@/design/typography';
import { useAuth } from '@/lib/auth';
import { getCachedToken } from '@/lib/storage';
import { supabase } from '@/lib/supabase';
import type { Database } from '@/types/supabase';

// US-061 — Bell button + unread badge, mounted above every tab screen in the
// creator and lister tab layouts. Tap routes the current role to their
// notifications inbox (`/(creator)/notifications` or `/(lister)/notifications`
// per docs/design.md §2.2/2.3). The unread count hydrates from a head-count
// query on mount and stays live via a Realtime subscription on INSERTs
// (increment) and UPDATEs (recount) scoped to the caller by `user_id`. RLS
// policy `notifications_self_rw` (us_009) is the security boundary — the
// client filter on user_id is a throughput guard (Pattern #123).
//
// Badge cap: `99+` at any count above 99 so the pill doesn't blow out the
// bell when a backfill lands. Hidden entirely at 0 so the chrome is quieter
// in the common empty-inbox state.

type NotificationRow = Database['public']['Tables']['notifications']['Row'];

export type NotificationBellProps = {
  role: 'creator' | 'lister';
};

export function NotificationBell({ role }: NotificationBellProps) {
  const { user } = useAuth();
  const pathname = usePathname();
  const userId = user?.id ?? null;
  const onNotifications = pathname === '/notifications';
  const [unread, setUnread] = useState(0);

  const recount = useCallback(async () => {
    if (!userId) return;
    const { count, error } = await supabase
      .from('notifications')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .is('read_at', null);
    if (error) return;
    setUnread(count ?? 0);
  }, [userId]);

  useEffect(() => {
    if (!userId) {
      setUnread(0);
      return;
    }
    void recount();
  }, [userId, recount]);

  // Realtime subscription: INSERTs increment, UPDATEs force a recount (we
  // don't try to diff read_at — recount is cheap against the partial unread
  // index). RLS already filters to the caller's own rows; the client filter
  // is a throughput guard.
  useEffect(() => {
    if (!userId) return;
    const token = getCachedToken();
    if (!token) return;
    let cancelled = false;
    let activeChannel: ReturnType<typeof supabase.channel> | null = null;
    void supabase.realtime.setAuth(token).then(() => {
      if (cancelled) return;
      activeChannel = supabase
        .channel(`notifications-bell-${userId}`)
        .on(
          'postgres_changes',
          {
            event: 'INSERT',
            schema: 'public',
            table: 'notifications',
            filter: `user_id=eq.${userId}`,
          },
          (payload) => {
            const row = payload.new as Partial<NotificationRow>;
            if (row.read_at) return;
            setUnread((cur) => cur + 1);
          },
        )
        .on(
          'postgres_changes',
          {
            event: 'UPDATE',
            schema: 'public',
            table: 'notifications',
            filter: `user_id=eq.${userId}`,
          },
          () => {
            void recount();
          },
        )
        .subscribe();
    });
    return () => {
      cancelled = true;
      if (activeChannel) void supabase.removeChannel(activeChannel);
    };
  }, [userId, recount]);

  const onPress = useCallback(() => {
    if (onNotifications) return;
    const target = role === 'creator' ? '/(creator)/notifications' : '/(lister)/notifications';
    router.push(target);
  }, [role, onNotifications]);

  const badgeLabel = unread > 99 ? '99+' : String(unread);
  const showBadge = unread > 0;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        showBadge
          ? `Notifications, ${unread} unread`
          : 'Notifications'
      }
      onPress={onPress}
      style={styles.button}
      hitSlop={8}
      testID="notification-bell"
    >
      <Bell size={22} color={colors.ink} strokeWidth={2} />
      {showBadge ? (
        <View
          style={styles.badge}
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          <Text style={styles.badgeText} allowFontScaling={false}>
            {badgeLabel}
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 999,
    backgroundColor: colors.surface,
    borderWidth: 2,
    borderColor: colors.ink,
    ...shadows.hard,
  },
  badge: {
    position: 'absolute',
    top: -4,
    right: -6,
    minWidth: 20,
    height: 20,
    paddingHorizontal: spacing.xs,
    borderRadius: 999,
    backgroundColor: colors.primary,
    borderWidth: 2,
    borderColor: colors.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: {
    fontFamily: fontFamilies.bodyBold,
    color: colors.surface,
    fontSize: 10,
    lineHeight: 12,
    letterSpacing: 0.5,
    textAlign: 'center',
  },
});

import { useRouter, usePathname, type Href } from 'expo-router';
import type { LucideIcon } from 'lucide-react-native';
import { Pressable, SafeAreaView, StyleSheet, Text, View } from 'react-native';
import { colors, spacing } from '@/design/tokens';
import { fontFamilies } from '@/design/typography';

// Custom bottom tab bar used by the (creator) and (lister) route groups.
// Renders on top of a `<Slot />` — expo-router's native `<Tabs>` navigator
// crashes under Expo Go + SDK 54 new-arch ("expected dynamic type 'boolean'"),
// so we drive tab switching with `router.navigate` + `usePathname` instead.
// Revisit and replace with `<Tabs>` when a dev-client build lands.
export type TabDef = {
  label: string;
  icon: LucideIcon;
  path: Href;
  // Pathname that `usePathname()` reports for this tab — URL-stripped of the
  // route group (`/(creator)/discover` → `/discover`). We cannot derive this
  // from `path` because group parens are invisible in the URL.
  activePathname: string;
  testID?: string;
};

export type TabBarProps = {
  tabs: TabDef[];
};

export function TabBar({ tabs }: TabBarProps) {
  const router = useRouter();
  const pathname = usePathname();

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.bar}>
        {tabs.map((tab) => {
          const focused = isActive(pathname, tab.activePathname);
          const color = focused ? colors.primary : colors.ink70;
          const Icon = tab.icon;
          return (
            <Pressable
              key={tab.activePathname}
              style={styles.tab}
              onPress={() => router.navigate(tab.path)}
              accessibilityRole="tab"
              accessibilityState={{ selected: focused }}
              accessibilityLabel={tab.label}
              testID={tab.testID}
            >
              <Icon size={24} color={color} strokeWidth={focused ? 2.5 : 1.5} />
              <Text style={[styles.label, { color }]} allowFontScaling={false}>
                {tab.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </SafeAreaView>
  );
}

// Active when the current path exactly matches OR is a nested route of the tab.
// e.g. `/campaigns/new/step-1` still lights the Campaigns tab.
function isActive(pathname: string, tabActivePath: string): boolean {
  if (pathname === tabActivePath) return true;
  if (tabActivePath === '/') return false;
  return pathname.startsWith(`${tabActivePath}/`);
}

const styles = StyleSheet.create({
  safeArea: {
    backgroundColor: colors.surface,
    borderTopColor: colors.ink,
    borderTopWidth: 2,
  },
  bar: {
    flexDirection: 'row',
    height: 64,
    alignItems: 'stretch',
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: spacing.sm,
    gap: spacing.xs,
  },
  label: {
    fontFamily: fontFamilies.bodyBold,
    fontSize: 11,
    lineHeight: 14,
    letterSpacing: 0.88,
    textTransform: 'uppercase',
  },
});

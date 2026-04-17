import { Redirect, Slot } from 'expo-router';
import { Building2, Inbox, LayoutDashboard, Megaphone } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';
import { TabBar, type TabDef } from '@/components/shared/TabBar';
import { colors } from '@/design/tokens';
import { useAuth } from '@/lib/auth';

// Lister tab group — Home (index) / Campaigns / Inbox / Profile per US-031 AC
// + docs/design.md §3.2. Same custom-TabBar rationale as the creator layout:
// expo-router's native `<Tabs>` crashes in Expo Go + SDK 54 new-arch. The FAB
// is mounted on the Home screen per §3.2 ("Create-campaign is a FAB on
// Dashboard + Campaigns tabs — not a center-tab bump").
const LISTER_TABS: TabDef[] = [
  {
    label: 'Home',
    icon: LayoutDashboard,
    path: '/(lister)/dashboard',
    activePathname: '/dashboard',
    testID: 'tab-dashboard',
  },
  {
    label: 'Campaigns',
    icon: Megaphone,
    path: '/(lister)/campaigns',
    activePathname: '/campaigns',
    testID: 'tab-campaigns',
  },
  {
    label: 'Inbox',
    icon: Inbox,
    path: '/(lister)/inbox',
    activePathname: '/inbox',
    testID: 'tab-inbox',
  },
  {
    label: 'Profile',
    icon: Building2,
    path: '/(lister)/profile',
    activePathname: '/profile',
    testID: 'tab-profile',
  },
];

export default function ListerLayout() {
  const { role } = useAuth();
  if (role !== 'lister') return <Redirect href="/(auth)" />;

  return (
    <View style={styles.root}>
      <View style={styles.content}>
        <Slot />
      </View>
      <TabBar tabs={LISTER_TABS} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas },
  content: { flex: 1 },
});

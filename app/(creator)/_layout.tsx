import { Redirect, Slot } from 'expo-router';
import { Compass, Send, User, Video } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';
import { TabBar, type TabDef } from '@/components/shared/TabBar';
import { colors } from '@/design/tokens';
import { useAuth } from '@/lib/auth';

// Creator tab group — 4 tabs per US-031 AC + docs/design.md §3.1
// (Discover / Applied / Submitted / Profile). We render `<Slot />` with a
// custom `<TabBar />` rather than expo-router's native `<Tabs>` because the
// latter crashes under Expo Go + SDK 54 new-arch (Codebase Pattern: Stack +
// Tabs throw "expected dynamic type 'boolean'"). A dev-client build would let
// us swap back to `<Tabs>` without changing any screens.
const CREATOR_TABS: TabDef[] = [
  {
    label: 'Discover',
    icon: Compass,
    path: '/(creator)/feed',
    activePathname: '/feed',
    testID: 'tab-feed',
  },
  {
    label: 'Applied',
    icon: Send,
    path: '/(creator)/applications',
    activePathname: '/applications',
    testID: 'tab-applications',
  },
  {
    label: 'Submitted',
    icon: Video,
    path: '/(creator)/submissions',
    activePathname: '/submissions',
    testID: 'tab-submissions',
  },
  {
    label: 'Profile',
    icon: User,
    path: '/(creator)/profile',
    activePathname: '/profile',
    testID: 'tab-profile',
  },
];

export default function CreatorLayout() {
  const { role } = useAuth();
  if (role !== 'creator') return <Redirect href="/(auth)" />;

  return (
    <View style={styles.root}>
      <View style={styles.content}>
        <Slot />
      </View>
      <TabBar tabs={CREATOR_TABS} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas },
  content: { flex: 1 },
});

import { Fab } from '@/components/shared/Fab';
import { TabPlaceholder } from '@/components/shared/TabPlaceholder';
import { useToast } from '@/components/primitives/Toast';

// US-048 replaces the placeholder with real dashboard stats + the FAB wired to
// the campaign-creation wizard (US-049). For US-031 the FAB exists and toasts
// a pointer so the wiring is verified without pulling in the wizard stack.
export default function ListerDashboard() {
  const { show } = useToast();
  return (
    <TabPlaceholder
      title="Home"
      subtitle="Campaign stats land in US-048. Tap + to create a campaign (wires up in US-049)."
    >
      <Fab
        onPress={() => {
          show({
            message: 'Create-campaign wizard lands in US-049.',
            variant: 'info',
          });
        }}
        accessibilityLabel="Create campaign"
        testID="lister-fab-create"
      />
    </TabPlaceholder>
  );
}

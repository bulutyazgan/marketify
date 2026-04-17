import { Fab } from '@/components/shared/Fab';
import { TabPlaceholder } from '@/components/shared/TabPlaceholder';
import { useToast } from '@/components/primitives/Toast';

// US-054 replaces the placeholder with Active/Inactive segmented listings.
// FAB is mirrored from the Dashboard tab per docs/design.md §3.2
// ("FAB on Dashboard + Campaigns tabs").
export default function ListerCampaigns() {
  const { show } = useToast();
  return (
    <TabPlaceholder
      title="Campaigns"
      subtitle="My campaigns land in US-054 with Active/Inactive segments."
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

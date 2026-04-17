import { TabPlaceholder } from '@/components/shared/TabPlaceholder';

// US-047 replaces the placeholder with the submissions list.
export default function Submissions() {
  return (
    <TabPlaceholder
      title="Submitted"
      subtitle="My submissions land in US-047 with Pending/Approved/Rejected segments."
    />
  );
}

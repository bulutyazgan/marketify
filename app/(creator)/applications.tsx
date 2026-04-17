import { TabPlaceholder } from '@/components/shared/TabPlaceholder';

// US-043 replaces the placeholder with the segmented application list.
export default function Applications() {
  return (
    <TabPlaceholder
      title="Applied"
      subtitle="My applications land in US-043 with Pending/Approved/Rejected/Cancelled segments."
    />
  );
}

import { TabPlaceholder } from '@/components/shared/TabPlaceholder';

// US-038 replaces the placeholder with the real Discover feed.
export default function Feed() {
  return (
    <TabPlaceholder
      title="Discover"
      subtitle="The eligibility-filtered campaign feed lands in US-038."
    />
  );
}

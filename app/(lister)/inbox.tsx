import { TabPlaceholder } from '@/components/shared/TabPlaceholder';

// US-056 (Applications) + US-058 (Submissions) replace the placeholder with
// the real inbox sub-tabs.
export default function ListerInbox() {
  return (
    <TabPlaceholder
      title="Inbox"
      subtitle="Applications + Submissions tabs land in US-056 and US-058."
    />
  );
}

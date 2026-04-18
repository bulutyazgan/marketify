import { Redirect } from 'expo-router';

// TabBar navigates to `/(lister)/inbox` — this index redirects to the
// Applications sub-tab so the URL path matches the visible screen. When
// US-058 lands the Submissions tab, the parent segmented control lives in
// `_layout.tsx` and this default target stays on Applications.
export default function ListerInboxIndex() {
  return <Redirect href="/(lister)/inbox/applications" />;
}

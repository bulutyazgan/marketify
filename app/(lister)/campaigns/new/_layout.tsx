import { Redirect, Slot } from 'expo-router';
import { useAuth } from '@/lib/auth';
import { WizardProvider } from '@/screens/campaign-wizard/WizardStore';

// Campaign-creation wizard route group (US-049 through US-053). Wraps the
// step-X screens in a single `WizardProvider` so draft state persists across
// navigations without re-mounting the store. Gated to the lister role — the
// parent `(lister)` layout already enforces this, but re-check here keeps the
// wizard robust to future route-group flattening.
//
// Spec gap: US-049's AC names the screen path `app/(lister)/create/step-1.tsx`,
// but the already-wired FAB (US-048) routes to `/(lister)/campaigns/new/step-1`
// and the canonical lister nav tree puts campaign-scoped flows under
// `/(lister)/campaigns/*` per docs/design.md §3.2 + §2.3. Using
// `campaigns/new/*` keeps the FAB functional and the URL shape consistent
// without retroactively re-wiring US-048.

export default function CampaignWizardLayout() {
  const { role } = useAuth();
  if (role !== 'lister') return <Redirect href="/(auth)" />;

  return (
    <WizardProvider>
      <Slot />
    </WizardProvider>
  );
}

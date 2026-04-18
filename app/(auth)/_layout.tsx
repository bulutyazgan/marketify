import { Redirect, Slot } from 'expo-router';
import { useAuth } from '@/lib/auth';

// (auth) group wraps the pre-signin screens. Authed users are bounced back to
// the role-appropriate tab group — keeps deep-links from leaving a signed-in
// user stuck on the role picker. US-032 fleshes out the role picker; US-033/034
// add the signup screens that will nest under this layout.
export default function AuthLayout() {
  const { role } = useAuth();

  if (role === 'creator') return <Redirect href="/(creator)/feed" />;
  if (role === 'lister') return <Redirect href="/(lister)/dashboard" />;

  return <Slot />;
}

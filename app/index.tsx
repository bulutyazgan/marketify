import { Redirect } from 'expo-router';
import { useAuth } from '@/lib/auth';

// Role-aware landing. `useAuth()` reads the role that `AuthProvider` hydrated
// from SecureStore at root-layout time (US-030). The dev primitives catalog
// (US-029) remains directly reachable at `/primitives` for mobile-mcp
// verification; we only gate `/` itself.
export default function Index() {
  const { role } = useAuth();
  if (role === 'creator') return <Redirect href="/(creator)/feed" />;
  if (role === 'lister') return <Redirect href="/(lister)/dashboard" />;
  return <Redirect href="/(auth)" />;
}

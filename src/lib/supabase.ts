import 'react-native-url-polyfill/auto';
import { createClient } from '@supabase/supabase-js';
import Constants from 'expo-constants';
import type { Database } from '@/types/supabase';
import { getCachedToken } from './storage';

type Extra = {
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
};

const extra = (Constants.expoConfig?.extra ?? {}) as Extra;

if (!extra.SUPABASE_URL || !extra.SUPABASE_ANON_KEY) {
  throw new Error(
    'Missing SUPABASE_URL or SUPABASE_ANON_KEY. Populate .env and rebuild the Expo config.',
  );
}

// Inject our custom-issued Marketify JWT on every request. We read from the
// in-memory cache in `storage.ts` (AuthProvider keeps it in lock-step with
// SecureStore) so this stays synchronous. signIn / signOut mutate the cache
// and the next request picks it up — no client recreation needed.
const marketifyFetch: typeof fetch = (input, init) => {
  const token = getCachedToken();
  if (!token) {
    return fetch(input, init);
  }
  const headers = new Headers(init?.headers);
  headers.set('Authorization', `Bearer ${token}`);
  return fetch(input, { ...init, headers });
};

export const supabase = createClient<Database>(extra.SUPABASE_URL, extra.SUPABASE_ANON_KEY, {
  auth: {
    // We issue our own JWT via edge functions — disable Supabase Auth's
    // session handling so it doesn't fight the Authorization header above.
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
  global: {
    fetch: marketifyFetch,
  },
});

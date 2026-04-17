import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { Database } from '@/types/supabase';
import {
  clearPersistedAuth,
  hydrateTokenFromStorage,
  persistToken,
  persistUserRaw,
  readPersistedUserRaw,
} from './storage';

export type AuthUser = Database['public']['Tables']['users']['Row'];
export type AuthRole = Database['public']['Enums']['user_role'];

type AuthContextValue = {
  user: AuthUser | null;
  role: AuthRole | null;
  signIn: (token: string, user: AuthUser) => void;
  signOut: () => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

function isAuthUserShape(value: unknown): value is AuthUser {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.username === 'string' &&
    (v.role === 'creator' || v.role === 'lister')
  );
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        await hydrateTokenFromStorage();
        const raw = await readPersistedUserRaw();
        if (!active) return;
        if (!raw) {
          setHydrated(true);
          return;
        }
        try {
          const parsed: unknown = JSON.parse(raw);
          if (isAuthUserShape(parsed)) {
            setUser(parsed);
          } else {
            await clearPersistedAuth();
          }
        } catch {
          await clearPersistedAuth();
        }
      } finally {
        if (active) setHydrated(true);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const signIn = useCallback((token: string, nextUser: AuthUser) => {
    // Optimistic UI: state flips immediately; persistence is best-effort.
    // The token cache in `storage.ts` is updated synchronously inside
    // `persistToken` so the next Supabase request sees the new JWT even
    // before the SecureStore write settles.
    setUser(nextUser);
    void persistToken(token);
    void persistUserRaw(JSON.stringify(nextUser));
  }, []);

  const signOut = useCallback(() => {
    setUser(null);
    void clearPersistedAuth();
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      role: user?.role ?? null,
      signIn,
      signOut,
    }),
    [user, signIn, signOut],
  );

  if (!hydrated) {
    return null;
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used inside an AuthProvider.');
  }
  return ctx;
}

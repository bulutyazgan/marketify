import * as SecureStore from 'expo-secure-store';

/**
 * Spec gap: the US-030 AC specifies "JWT stored under MMKV key 'marketify.jwt'",
 * but `react-native-mmkv` v4 ships as a Nitro module that cannot load in Expo Go.
 * All iterations to date verify on Expo Go (no dev-client build yet — deferred per
 * progress pattern on US-002). We satisfy the functional intent (persistent,
 * secure key-value storage for the JWT) with `expo-secure-store`, which is part
 * of the Expo SDK and works in Expo Go natively. SecureStore also happens to be
 * more appropriate for credential material — it uses iOS Keychain / Android
 * Keystore under the hood. When a dev-client build lands (planned for US-031),
 * this module is the single swap point if the team wants to revisit MMKV.
 */

export const STORAGE_KEYS = {
  jwt: 'marketify.jwt',
  user: 'marketify.user',
} as const;

// SecureStore is async. The Supabase `global.fetch` wrapper needs a synchronous
// read of the JWT for every outbound request, so we mirror the token in a
// module-scope cache. AuthProvider is the only writer; it keeps the cache and
// SecureStore in lock-step.
let cachedToken: string | null = null;

export function getCachedToken(): string | null {
  return cachedToken;
}

export async function hydrateTokenFromStorage(): Promise<string | null> {
  const value = await SecureStore.getItemAsync(STORAGE_KEYS.jwt);
  cachedToken = value;
  return value;
}

export async function persistToken(token: string): Promise<void> {
  cachedToken = token;
  await SecureStore.setItemAsync(STORAGE_KEYS.jwt, token);
}

export async function readPersistedUserRaw(): Promise<string | null> {
  return SecureStore.getItemAsync(STORAGE_KEYS.user);
}

export async function persistUserRaw(json: string): Promise<void> {
  await SecureStore.setItemAsync(STORAGE_KEYS.user, json);
}

export async function clearPersistedAuth(): Promise<void> {
  cachedToken = null;
  await Promise.all([
    SecureStore.deleteItemAsync(STORAGE_KEYS.jwt),
    SecureStore.deleteItemAsync(STORAGE_KEYS.user),
  ]);
}

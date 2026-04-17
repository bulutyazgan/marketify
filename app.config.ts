import type { ExpoConfig, ConfigContext } from 'expo/config';

// Expo CLI auto-loads `.env` into `process.env`. We surface the pieces the RN
// client needs via `extra` so `expo-constants` can read them at runtime.
// Static expo config still lives in app.json; this file extends it.
export default ({ config }: ConfigContext): ExpoConfig => ({
  ...(config as ExpoConfig),
  extra: {
    ...(config.extra ?? {}),
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,
  },
});

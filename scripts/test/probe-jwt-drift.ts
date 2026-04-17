// One-shot probe: sign up a fresh lister, then call PostgREST with the returned
// Marketify JWT. If PostgREST returns 200 on /rest/v1/lister_profiles, the
// Supabase project JWT secret matches MARKETIFY_JWT_SECRET (US-036/US-038
// drift resolved). Otherwise 401 PGRST301 confirms the drift is still there.
//
// Usage: bun run scripts/test/probe-jwt-drift.ts

const supabaseUrl = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
if (!supabaseUrl || !anonKey) {
  console.error("SUPABASE_URL and SUPABASE_ANON_KEY are required in .env");
  process.exit(1);
}

const unique = Date.now();
const payload = {
  username: `probe_jwt_${unique}`,
  email: `probe_jwt_${unique}@marketify.test`,
  org_name: "JWT Drift Probe",
};

const signupRes = await fetch(`${supabaseUrl}/functions/v1/auth-signup-lister`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${anonKey}`,
    apikey: anonKey,
  },
  body: JSON.stringify(payload),
});
const signupBody = (await signupRes.json().catch(() => null)) as
  | { token?: string; user_id?: string }
  | null;
console.log("[signup]", signupRes.status);
if (signupRes.status !== 200 || !signupBody?.token || !signupBody?.user_id) {
  console.error("[signup] unexpected response", signupBody);
  process.exit(1);
}

const probeRes = await fetch(
  `${supabaseUrl}/rest/v1/lister_profiles?user_id=eq.${signupBody.user_id}&select=user_id,org_name`,
  {
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${signupBody.token}`,
    },
  },
);
const probeBody = await probeRes.text();
console.log("[postgrest]", probeRes.status, probeBody.slice(0, 200));

if (probeRes.status === 200) {
  console.log("[verdict] JWT drift RESOLVED — PostgREST accepted the Marketify token");
  process.exit(0);
}
console.log("[verdict] JWT drift PERSISTS — PostgREST rejected the Marketify token");
process.exit(2);

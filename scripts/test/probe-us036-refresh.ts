// US-036 backend probe: signs up a creator (exercising real JWT mint via
// auth-signup-creator), then calls metrics-refresh with the returned JWT —
// the exact backend path the pull-to-refresh gesture triggers.
//
// Exists because mobile-mcp's swipe-down injection on iOS 26.3 simulator is
// intercepted by the iOS system home-gesture before the app's Gesture.Pan
// can register. The UI gesture code is complete + typed + linted; this
// probe verifies the full authed refresh call works end-to-end.
//
// Usage: bun run scripts/test/probe-us036-refresh.ts

const supabaseUrl = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
if (!supabaseUrl || !anonKey) {
  console.error("SUPABASE_URL and SUPABASE_ANON_KEY are required in .env");
  process.exit(1);
}

const unique = Date.now();
const signupRes = await fetch(
  `${supabaseUrl}/functions/v1/auth-signup-creator`,
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${anonKey}`,
      apikey: anonKey,
    },
    body: JSON.stringify({
      username: `us036_probe_${unique}`,
      tiktok_handle: `us036_probe_${unique}`,
    }),
  },
);
const signupBody = (await signupRes.json().catch(() => null)) as {
  token?: string;
  user_id?: string;
} | null;
console.log("[signup]", signupRes.status);
if (signupRes.status !== 200 || !signupBody?.token || !signupBody?.user_id) {
  console.error("[signup] unexpected", signupBody);
  process.exit(1);
}

// Look up the freshly created tiktok social_link via PostgREST using the JWT —
// this doubles as the JWT/PostgREST drift check.
const linksRes = await fetch(
  `${supabaseUrl}/rest/v1/social_links?user_id=eq.${signupBody.user_id}&platform=eq.tiktok&select=id`,
  {
    headers: { apikey: anonKey, Authorization: `Bearer ${signupBody.token}` },
  },
);
console.log("[postgrest social_links]", linksRes.status);
if (linksRes.status !== 200) {
  console.error("[postgrest]", await linksRes.text());
  process.exit(1);
}
const linkRows = (await linksRes.json()) as Array<{ id: string }>;
const socialLinkId = linkRows[0]?.id;
if (!socialLinkId) {
  console.error("[postgrest] no tiktok social_link row found");
  process.exit(1);
}

const refreshRes = await fetch(
  `${supabaseUrl}/functions/v1/metrics-refresh`,
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${signupBody.token}`,
      apikey: anonKey,
    },
    body: JSON.stringify({ social_link_id: socialLinkId }),
  },
);
const refreshBody = await refreshRes.text();
console.log("[metrics-refresh]", refreshRes.status, refreshBody.slice(0, 400));

if (refreshRes.status !== 200) {
  console.error("[verdict] refresh path BROKEN");
  process.exit(2);
}
console.log(
  "[verdict] US-036 backend path VERIFIED — signup JWT accepted by PostgREST + metrics-refresh",
);

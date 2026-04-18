// Verifies the auto-scrape-on-add fix end-to-end:
//   1. POST auth-signup-creator with a TikTok handle to obtain a JWT.
//   2. POST manage-social-link {action:'add', platform:'instagram', handle:'pubity'}.
//   3. Print returned metrics_status and the new social_link_id so a follow-up
//      DB query (metric_snapshots filtered by that id) can confirm the
//      dispatch produced rows.
//
// Usage: bun run scripts/test/probe-add-link-autoscrape.ts

const supabaseUrl = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
if (!supabaseUrl || !anonKey) {
  console.error("SUPABASE_URL and SUPABASE_ANON_KEY are required in .env");
  process.exit(1);
}

const unique = Date.now();
const tiktokHandle = `autoscrape_probe_${unique}`;

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
      username: `autoscrape_probe_${unique}`,
      tiktok_handle: tiktokHandle,
    }),
  },
);
const signupBody = (await signupRes.json().catch(() => null)) as
  | { token?: string; user_id?: string; metrics_status?: unknown }
  | null;
console.log("[signup]", signupRes.status, JSON.stringify(signupBody));
if (signupRes.status !== 200 || !signupBody?.token) {
  console.error("[signup] FAIL");
  process.exit(1);
}

const addRes = await fetch(
  `${supabaseUrl}/functions/v1/manage-social-link`,
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${signupBody.token}`,
      apikey: anonKey,
    },
    body: JSON.stringify({
      action: "add",
      platform: "instagram",
      handle: "natgeo",
    }),
  },
);
const addBody = await addRes.text();
console.log("[manage-social-link add]", addRes.status, addBody);
if (addRes.status !== 200) {
  console.error("[manage-social-link] FAIL");
  process.exit(1);
}

const parsed = JSON.parse(addBody) as {
  social_link_id?: string;
  metrics_status?: Record<string, string>;
};
console.log("\n[verdict] add OK");
console.log(`  social_link_id = ${parsed.social_link_id}`);
console.log(`  metrics_status = ${JSON.stringify(parsed.metrics_status)}`);
console.log(`  user_id        = ${signupBody.user_id}`);

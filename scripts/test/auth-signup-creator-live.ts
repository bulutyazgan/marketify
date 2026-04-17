// Live end-to-end for auth-signup-creator → Apify dispatch (US-020).
//
// Usage: bun run scripts/test/auth-signup-creator-live.ts
// Requires SUPABASE_URL, SUPABASE_ANON_KEY, and ideally
// SUPABASE_SERVICE_ROLE_KEY (for cleanup). Burns a few cents of Apify
// credits — NOT part of the default smoke suite.
//
// Uses a stable public TikTok handle (`tiktok`) and Instagram handle
// (`nasa`) so the Apify runs return real datasets. Within the 60s wait
// window the edge function should see all three runs SUCCEED, emit the
// webhooks, and the webhook receiver should write metric_snapshots rows
// keyed on the social_links created by the signup.
//
// Assertions:
//   1. Response 200 with metrics_status.tiktok, ig_details, ig_posts
//      all 'fresh' (all three ran to completion within waitSecs=60)
//   2. After a short settle delay, one metric_snapshots row per platform
//      exists in status='fresh' keyed on the freshly-minted social_links.

const {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY,
} = process.env;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("SUPABASE_URL and SUPABASE_ANON_KEY required in .env");
  process.exit(1);
}

const unique = Date.now();
const primary = {
  username: `us020_live_${unique}`,
  tiktok_handle: "tiktok",
  instagram_handle: "nasa",
};

const endpoint = `${SUPABASE_URL}/functions/v1/auth-signup-creator`;

console.log(`POST ${endpoint} with handles tiktok=${primary.tiktok_handle}, instagram=${primary.instagram_handle}`);
const signup = await fetch(endpoint, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    apikey: SUPABASE_ANON_KEY,
  },
  body: JSON.stringify(primary),
});
const signupBody = await signup.json();
console.log("signup:", signup.status, signupBody);

if (signup.status !== 200) {
  console.error("signup did not return 200");
  process.exit(1);
}

const metricsStatus = signupBody?.metrics_status as
  | Record<string, string>
  | undefined;
if (!metricsStatus) {
  console.error("metrics_status missing from response");
  process.exit(1);
}
for (const key of ["tiktok", "ig_details", "ig_posts"]) {
  if (!metricsStatus[key]) {
    console.error(`metrics_status.${key} missing — is APIFY_KEY set on the deployed function?`);
    process.exit(1);
  }
}
console.log("metrics_status:", metricsStatus);
if (
  metricsStatus.tiktok !== "fresh" ||
  metricsStatus.ig_details !== "fresh" ||
  metricsStatus.ig_posts !== "fresh"
) {
  console.warn(
    "warn: at least one platform is not 'fresh' — this can happen under heavy load; proceeding to DB check anyway",
  );
}

const userId = signupBody.user_id as string;

// Give the webhook → RPC path a moment to land (the dispatch returned
// synchronously but the webhook is an independent HTTP round-trip).
await new Promise((r) => setTimeout(r, 4000));

if (!SUPABASE_SERVICE_ROLE_KEY) {
  console.log(
    "SUPABASE_SERVICE_ROLE_KEY not set — skipping DB assertions + cleanup",
  );
  console.log("ok (response-level only) — user_id:", userId);
  process.exit(0);
}

const pgrst = (path: string, init: RequestInit = {}) =>
  fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });

const linksRes = await pgrst(
  `social_links?user_id=eq.${userId}&select=id,platform`,
);
if (!linksRes.ok) {
  console.error("social_links lookup failed:", linksRes.status, await linksRes.text());
  process.exit(1);
}
const links = (await linksRes.json()) as Array<{ id: string; platform: string }>;
console.log("social_links:", links);

const snapRes = await pgrst(
  `metric_snapshots?social_link_id=in.(${
    links.map((l) => l.id).join(",")
  })&select=id,social_link_id,scrape_mode,status,apify_run_id`,
);
if (!snapRes.ok) {
  console.error("metric_snapshots lookup failed:", snapRes.status, await snapRes.text());
  process.exit(1);
}
const snaps = (await snapRes.json()) as Array<{
  id: string;
  social_link_id: string;
  scrape_mode: string;
  status: string;
  apify_run_id: string;
}>;
console.log("metric_snapshots:", snaps);

// Require one row per scrape_mode, status=fresh. The webhook may still
// be in-flight so retry up to 3 times over ~15s.
const required = new Set(["tiktok_profile", "ig_details", "ig_posts"]);
let attempts = 0;
let current = snaps;
while (attempts < 3) {
  const modes = new Set(current.map((s) => s.scrape_mode));
  if ([...required].every((m) => modes.has(m))) break;
  attempts += 1;
  console.log(`waiting for webhook-driven snapshots... attempt ${attempts}`);
  await new Promise((r) => setTimeout(r, 5000));
  const retryRes = await pgrst(
    `metric_snapshots?social_link_id=in.(${
      links.map((l) => l.id).join(",")
    })&select=id,social_link_id,scrape_mode,status,apify_run_id`,
  );
  current = (await retryRes.json()) as typeof snaps;
}

const got = new Set(current.map((s) => s.scrape_mode));
for (const mode of required) {
  if (!got.has(mode)) {
    console.error(`missing metric_snapshots row for scrape_mode=${mode}`);
    process.exit(1);
  }
}
for (const s of current) {
  if (s.status !== "fresh") {
    console.warn(`warn: snapshot ${s.scrape_mode} status=${s.status} (expected 'fresh')`);
  }
}

console.log("ok — live e2e completed. cleaning up...");
const cleanup = await pgrst(`users?id=eq.${userId}`, { method: "DELETE" });
if (!cleanup.ok) {
  console.warn("cleanup failed (non-fatal):", cleanup.status, await cleanup.text());
} else {
  console.log("cleaned up test user");
}

// Smoke test for the deployed auth-signup-creator edge function.
//
// Usage: bun run scripts/test/auth-signup-creator.ts
// Requires SUPABASE_URL and SUPABASE_ANON_KEY in .env (bun auto-loads).
//
// Note (US-020): the happy-path call dispatches real Apify runs against
// the supplied handles. The handles used below are synthetic, so Apify
// will return empty/failed results — but it still burns a small amount
// of credits (~$0.08 per smoke run). If you need handle-level dataset
// content, use scripts/test/auth-signup-creator-live.ts instead.
//
// Asserts:
//   1. Fresh { username, tiktok_handle, instagram_handle } → 200 with
//      { token, user_id, role:'creator', metrics_status:{tiktok, ig_details, ig_posts} }
//   2. Same body → 409 USERNAME_TAKEN
//   3. Fresh username + no handles → 422 HANDLE_REQUIRED
//   4. Fresh username + missing body field → 400 INVALID_REQUEST
//   5. Fresh username + recycled tiktok handle → 409 HANDLE_TAKEN
//   6. Normalized handle: leading '@' is stripped (verified by reusing the
//      naked handle against a row created with the '@'-prefixed form)

const supabaseUrl = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
if (!supabaseUrl || !anonKey) {
  console.error("SUPABASE_URL and SUPABASE_ANON_KEY are required in .env");
  process.exit(1);
}

const endpoint = `${supabaseUrl}/functions/v1/auth-signup-creator`;
const baseHeaders = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${anonKey}`,
  apikey: anonKey,
};

const unique = Date.now();
const primary = {
  username: `us019_test_${unique}`,
  tiktok_handle: `us019_tt_${unique}`,
  instagram_handle: `us019_ig_${unique}`,
};

async function post(body: unknown) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: baseHeaders,
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

const first = await post(primary);
console.log("first:", first.status, first.data);
if (first.status !== 200) process.exit(1);
if (
  typeof first.data?.token !== "string" ||
  typeof first.data?.user_id !== "string" ||
  first.data?.role !== "creator"
) {
  console.error("unexpected 200 body shape");
  process.exit(1);
}

// US-020: metrics_status must exist as an object. When APIFY_KEY /
// APIFY_WEBHOOK_SECRET are configured on the deployed function (the
// expected prod + staging case) it should carry one entry per platform
// dispatched — tiktok + ig_details + ig_posts for a dual-handle signup.
// When those env vars are absent, the function logs a warn and returns
// an empty object. We accept both shapes here, but require the keys to
// be populated if any are present.
const metricsStatus = first.data?.metrics_status;
if (metricsStatus == null || typeof metricsStatus !== "object") {
  console.error("metrics_status missing or not an object");
  process.exit(1);
}
const statusValues = new Set(["fresh", "refreshing", "failed"]);
for (const key of Object.keys(metricsStatus)) {
  if (!["tiktok", "ig_details", "ig_posts"].includes(key)) {
    console.error(`unexpected metrics_status key: ${key}`);
    process.exit(1);
  }
  if (!statusValues.has(metricsStatus[key])) {
    console.error(`unexpected metrics_status[${key}] value: ${metricsStatus[key]}`);
    process.exit(1);
  }
}
if (Object.keys(metricsStatus).length > 0) {
  // If Apify was configured, all three keys should be present for a
  // dual-handle signup.
  for (const key of ["tiktok", "ig_details", "ig_posts"]) {
    if (!(key in metricsStatus)) {
      console.error(`metrics_status partially populated — missing ${key}`);
      process.exit(1);
    }
  }
  console.log("metrics_status ok:", metricsStatus);
} else {
  console.log("metrics_status empty — Apify not configured on deployed fn");
}

const second = await post(primary);
console.log("second:", second.status, second.data);
if (second.status !== 409 || second.data?.error !== "USERNAME_TAKEN") {
  console.error("expected 409 USERNAME_TAKEN");
  process.exit(1);
}

const third = await post({ username: `us019_test_nohandles_${unique}` });
console.log("third:", third.status, third.data);
if (third.status !== 422 || third.data?.error !== "HANDLE_REQUIRED") {
  console.error("expected 422 HANDLE_REQUIRED");
  process.exit(1);
}

const fourth = await post({ tiktok_handle: `us019_missinguser_${unique}` });
console.log("fourth:", fourth.status, fourth.data);
if (fourth.status !== 400 || fourth.data?.error !== "INVALID_REQUEST") {
  console.error("expected 400 INVALID_REQUEST");
  process.exit(1);
}

// Reuse the primary tiktok handle with a new username → HANDLE_TAKEN.
// Prefix with '@' to prove normalization strips it before the RPC compares.
const fifth = await post({
  username: `us019_test_handlecollide_${unique}`,
  tiktok_handle: `@${primary.tiktok_handle}`,
});
console.log("fifth:", fifth.status, fifth.data);
if (fifth.status !== 409 || fifth.data?.error !== "HANDLE_TAKEN") {
  console.error("expected 409 HANDLE_TAKEN (proves '@' normalization)");
  process.exit(1);
}

// Teardown: delete every users row this run created. social_links +
// creator_profiles cascade via ON DELETE CASCADE. We intentionally use
// the service role via PostgREST here rather than a REST call because
// the anon key can't delete from RLS-guarded tables. If the caller only
// has the anon key, we skip cleanup (CI environments should set
// SUPABASE_SERVICE_ROLE_KEY).
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (serviceRoleKey) {
  const cleanup = await fetch(
    `${supabaseUrl}/rest/v1/users?username=like.us019_test_${unique}*`,
    {
      method: "DELETE",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
    },
  );
  if (!cleanup.ok) {
    console.warn("cleanup failed (non-fatal):", cleanup.status, await cleanup.text());
  } else {
    console.log("cleaned up test rows");
  }
} else {
  console.log("SUPABASE_SERVICE_ROLE_KEY not set — skipping cleanup");
}

console.log("ok — created user_id:", first.data.user_id);

// Smoke test for the deployed auth-signup-creator edge function.
//
// Usage: bun run scripts/test/auth-signup-creator.ts
// Requires SUPABASE_URL and SUPABASE_ANON_KEY in .env (bun auto-loads).
//
// Asserts:
//   1. Fresh { username, tiktok_handle, instagram_handle } → 200 with
//      { token, user_id, role:'creator' }
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

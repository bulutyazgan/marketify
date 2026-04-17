// Smoke test for the deployed auth-signup-lister edge function.
//
// Usage: bun run scripts/test/auth-signup-lister.ts
// Requires SUPABASE_URL and SUPABASE_ANON_KEY in .env (bun auto-loads).
//
// Asserts:
//   1. Fresh { username, email, org_name } → 200 with { token, user_id, role:'lister' }
//   2. Same body again → 409 USERNAME_TAKEN (username hits first)
//   3. Missing org_name → 400 INVALID_REQUEST
//   4. Fresh username + recycled email → 409 EMAIL_TAKEN

const supabaseUrl = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
if (!supabaseUrl || !anonKey) {
  console.error("SUPABASE_URL and SUPABASE_ANON_KEY are required in .env");
  process.exit(1);
}

const endpoint = `${supabaseUrl}/functions/v1/auth-signup-lister`;
const baseHeaders = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${anonKey}`,
  apikey: anonKey,
};

const unique = Date.now();
const payload = {
  username: `us014_test_${unique}`,
  email: `us014_test_${unique}@marketify.test`,
  org_name: "US-014 Test Org",
  website_url: "https://us014.test",
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

const first = await post(payload);
console.log("first:", first.status, first.data);
if (first.status !== 200) process.exit(1);
if (
  typeof first.data?.token !== "string" ||
  typeof first.data?.user_id !== "string" ||
  first.data?.role !== "lister"
) {
  console.error("unexpected 200 body shape");
  process.exit(1);
}

const second = await post(payload);
console.log("second:", second.status, second.data);
if (second.status !== 409 || second.data?.error !== "USERNAME_TAKEN") {
  console.error("expected 409 USERNAME_TAKEN");
  process.exit(1);
}

const third = await post({ username: `us014_test_other_${unique}`, email: `us014_test_other_${unique}@marketify.test` });
console.log("third:", third.status, third.data);
if (third.status !== 400 || third.data?.error !== "INVALID_REQUEST") {
  console.error("expected 400 INVALID_REQUEST");
  process.exit(1);
}

const fourth = await post({
  username: `us014_test_freshuser_${unique}`,
  email: payload.email,
  org_name: "US-014 Email Collision Org",
});
console.log("fourth:", fourth.status, fourth.data);
if (fourth.status !== 409 || fourth.data?.error !== "EMAIL_TAKEN") {
  console.error("expected 409 EMAIL_TAKEN");
  process.exit(1);
}

console.log("ok — created user_id:", first.data.user_id);

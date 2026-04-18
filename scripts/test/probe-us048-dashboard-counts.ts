// Probe: end-to-end verification of US-048 `lister_dashboard_counts` RPC.
//
// Usage: bun run scripts/test/probe-us048-dashboard-counts.ts
//
// Flow:
//   1. Sign up a fresh lister via `auth-signup-lister` → real Marketify JWT.
//   2. Call `/rest/v1/rpc/lister_dashboard_counts` with the new JWT.
//   3. Assert the shape is {active_campaigns, pending_applications, pending_submissions}
//      and every count is 0 for a just-created lister (nothing seeded yet).
//   4. Delete the test lister via service_role (if SUPABASE_SERVICE_ROLE_KEY set).
//
// Happy-path counts with seeded fixtures (2 active listings, 2 pending apps,
// 1 pending submission) are separately verified via the transactional SQL
// test documented in the commit message — that path exercises RLS + enum
// casting under `search_path = ''`. This probe adds the PostgREST layer
// on top: JWT verification, RPC type coercion, and end-to-end wiring.

const supabaseUrl = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !anonKey) {
  console.error("SUPABASE_URL and SUPABASE_ANON_KEY are required in .env");
  process.exit(1);
}

const unique = Date.now();
const signupBody = {
  username: `us048_probe_${unique}`,
  email: `us048_probe_${unique}@marketify.test`,
  org_name: "US-048 Dashboard Probe",
};

const signupRes = await fetch(`${supabaseUrl}/functions/v1/auth-signup-lister`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${anonKey}`,
    apikey: anonKey,
  },
  body: JSON.stringify(signupBody),
});
const signup = await signupRes.json();
console.log("signup:", signupRes.status, { user_id: signup.user_id, role: signup.role });
if (signupRes.status !== 200 || typeof signup.token !== "string") {
  console.error("signup failed");
  process.exit(1);
}

const rpcRes = await fetch(`${supabaseUrl}/rest/v1/rpc/lister_dashboard_counts`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${signup.token}`,
    apikey: anonKey,
  },
  body: "{}",
});
const rows = await rpcRes.json();
console.log("rpc:", rpcRes.status, rows);
if (rpcRes.status !== 200 || !Array.isArray(rows) || rows.length !== 1) {
  console.error("expected a single-row result");
  process.exit(1);
}
const row = rows[0];
const ok =
  row.active_campaigns === 0 &&
  row.pending_applications === 0 &&
  row.pending_submissions === 0;
if (!ok) {
  console.error("expected all-zero counts for a fresh lister, got", row);
  process.exit(1);
}
console.log("PASS: fresh lister sees {0,0,0}");

if (serviceKey) {
  const cleanupRes = await fetch(`${supabaseUrl}/rest/v1/users?id=eq.${signup.user_id}`, {
    method: "DELETE",
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      Prefer: "return=minimal",
    },
  });
  console.log("cleanup:", cleanupRes.status);
} else {
  console.log("cleanup skipped (set SUPABASE_SERVICE_ROLE_KEY for teardown)");
}

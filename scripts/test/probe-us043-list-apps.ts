// US-043 backend probe: signs up a fresh creator, then queries
// `list_my_applications` via PostgREST with the resulting Marketify JWT.
// Run mode is selected via argv[2]:
//
//   signup   — POST auth-signup-creator, print { user_id, token } and exit 0.
//              Used to bootstrap a verification fixture; the caller is then
//              responsible for inserting applications for `user_id` (via MCP
//              execute_sql with service_role) before running mode `query`.
//
//   query    — POST /rest/v1/rpc/list_my_applications with the JWT supplied
//              in MARKETIFY_PROBE_JWT env var. Prints the rows and asserts
//              there is at least one row in each of the 4 segment buckets
//              (pending / approved / rejected / cancelled). Exit 0 on full
//              coverage, exit 2 otherwise.
//
// Usage:
//   bun run scripts/test/probe-us043-list-apps.ts signup
//   MARKETIFY_PROBE_JWT=<jwt> bun run scripts/test/probe-us043-list-apps.ts query
//
// Why this exists: the in-app DevRolePicker uses a literal `dev-creator-token`
// string that PostgREST rejects with PGRST301. Only a JWT minted by
// `auth-signup-creator` (or `auth-signin-*` once it lands) is accepted. The
// SQL-level verification of the RPC body was completed in the original US-043
// commit — this probe closes the loop end-to-end through the PostgREST gateway
// without burning the DB-vs-PostgREST distinction.
//
// Note on stdout: signup mode prints the JWT to stdout so the operator can pipe
// it into MARKETIFY_PROBE_JWT for the query phase. The JWT TTL matches the
// edge-function default (~7 days) and the test fixture (user + applications)
// is meant to be deleted via execute_sql immediately after the query phase
// finishes — see the US-043 progress.txt entry for the cleanup statement.
// Do NOT use this probe shape for any credential that survives the verify run.

const supabaseUrl = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
if (!supabaseUrl || !anonKey) {
  console.error("SUPABASE_URL and SUPABASE_ANON_KEY are required in .env");
  process.exit(1);
}

const mode = process.argv[2];
if (mode !== "signup" && mode !== "query") {
  console.error("usage: bun run scripts/test/probe-us043-list-apps.ts <signup|query>");
  process.exit(1);
}

if (mode === "signup") {
  const unique = Date.now();
  const res = await fetch(`${supabaseUrl}/functions/v1/auth-signup-creator`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${anonKey}`,
      apikey: anonKey,
    },
    body: JSON.stringify({
      username: `us043_probe_${unique}`,
      tiktok_handle: `us043_probe_${unique}`,
    }),
  });
  const body = (await res.json().catch(() => null)) as
    | { token?: string; user_id?: string }
    | null;
  console.log("[signup]", res.status);
  if (res.status !== 200 || !body?.token || !body?.user_id) {
    console.error("[signup] unexpected", body);
    process.exit(1);
  }
  console.log(JSON.stringify({ user_id: body.user_id, token: body.token }));
  process.exit(0);
}

const jwt = process.env.MARKETIFY_PROBE_JWT;
if (!jwt) {
  console.error("MARKETIFY_PROBE_JWT must be set for query mode");
  process.exit(1);
}

const rpcRes = await fetch(
  `${supabaseUrl}/rest/v1/rpc/list_my_applications`,
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`,
      apikey: anonKey,
    },
    body: "{}",
  },
);
console.log("[rpc list_my_applications]", rpcRes.status);
if (rpcRes.status !== 200) {
  console.error(await rpcRes.text());
  process.exit(2);
}

type Row = {
  id: string;
  status:
    | "pending"
    | "approved"
    | "rejected"
    | "withdrawn"
    | "cancelled_listing_edit"
    | "cancelled_listing_closed";
  listing_id: string;
  listing_title: string | null;
  lister_handle: string | null;
  version_title: string | null;
};
const rows = (await rpcRes.json()) as Row[];
console.log(`[rpc] ${rows.length} row(s) returned`);
for (const r of rows) {
  console.log(
    `  - ${r.status.padEnd(28)} listing="${r.listing_title}" handle=@${r.lister_handle}`,
  );
}

// Mirror app/(creator)/applications.tsx:39 STATUS_BUCKET exactly — every
// enum value mapped explicitly so a future 7th `application_status` value
// trips a tsc exhaustiveness error here instead of silently bucketing as
// "cancelled" via an implicit else-branch.
type Bucket = "pending" | "approved" | "rejected" | "cancelled";
const STATUS_BUCKET: Record<Row["status"], Bucket> = {
  pending: "pending",
  approved: "approved",
  rejected: "rejected",
  withdrawn: "cancelled",
  cancelled_listing_edit: "cancelled",
  cancelled_listing_closed: "cancelled",
};
const bucket = (s: Row["status"]): Bucket => STATUS_BUCKET[s];

const seen = new Set(rows.map((r) => bucket(r.status)));
const required = ["pending", "approved", "rejected", "cancelled"] as const;
const missing = required.filter((b) => !seen.has(b));

if (missing.length > 0) {
  console.error(`[verdict] FAIL — missing buckets: ${missing.join(", ")}`);
  process.exit(2);
}

const handlesPopulated = rows.every((r) => !!r.lister_handle);
const titlesPopulated = rows.every((r) => !!r.listing_title || !!r.version_title);
if (!handlesPopulated) {
  console.error("[verdict] FAIL — lister_handle null on at least one row (silent-null regression)");
  process.exit(2);
}
if (!titlesPopulated) {
  console.error("[verdict] FAIL — listing_title and version_title both null on at least one row");
  process.exit(2);
}

console.log(
  "[verdict] PASS — all 4 buckets populated, lister_handle + title resolved on every row",
);

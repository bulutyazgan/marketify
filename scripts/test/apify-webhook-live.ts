// Live end-to-end for the apify-webhook SUCCEEDED branch (US-016).
//
// Usage: bun run scripts/test/apify-webhook-live.ts
// Requires APIFY_KEY, APIFY_WEBHOOK_SECRET, SUPABASE_URL, SUPABASE_ANON_KEY.
//
// Hits a real Apify actor (spends a few cents) and therefore is not part of
// the default smoke suite. This script only drives the *request side*:
//   1. Kick a real Apify tiktok_profile run (sync wait ≤ 90s)
//   2. POST a synthetic webhook carrying the real run_id + defaultDatasetId
//   3. Assert the webhook returned 200 inserted:true duplicate:false
//
// The DB-side assertions (metric_snapshots row written, creator_profiles
// denorm trigger fired) are done separately via Supabase MCP execute_sql
// after this script completes — see progress.txt entry for US-016.

const {
  APIFY_KEY,
  APIFY_WEBHOOK_SECRET,
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
} = process.env;

if (!APIFY_KEY || !APIFY_WEBHOOK_SECRET || !SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error(
    "APIFY_KEY, APIFY_WEBHOOK_SECRET, SUPABASE_URL, SUPABASE_ANON_KEY required in .env",
  );
  process.exit(1);
}

const SEED_TIKTOK_SOCIAL_LINK_ID = "11111111-1111-1111-1111-111111111020";
const TIKTOK_HANDLE = "tiktok"; // cheap + stable public account
const endpoint = `${SUPABASE_URL}/functions/v1/apify-webhook`;

console.log(`kicking Apify tiktok_profile for @${TIKTOK_HANDLE}...`);
const runUrl = new URL(
  "https://api.apify.com/v2/acts/clockworks~tiktok-scraper/runs",
);
runUrl.searchParams.set("token", APIFY_KEY);
runUrl.searchParams.set("waitForFinish", "90");

const runRes = await fetch(runUrl.toString(), {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    profiles: [TIKTOK_HANDLE],
    resultsPerPage: 10,
    profileScrapeSections: ["videos"],
    profileSorting: "latest",
    excludePinnedPosts: true,
    shouldDownloadVideos: false,
    shouldDownloadCovers: false,
  }),
});
if (!runRes.ok) {
  console.error(`apify start failed: ${runRes.status} ${runRes.statusText}`);
  process.exit(1);
}
const runJson = (await runRes.json()) as {
  data?: { id?: string; defaultDatasetId?: string; status?: string };
};
const runData = runJson.data;
if (
  !runData?.id ||
  !runData.defaultDatasetId ||
  runData.status !== "SUCCEEDED"
) {
  console.error("apify run did not succeed:", runData);
  process.exit(1);
}
console.log(
  `apify run ${runData.id} ${runData.status}, dataset ${runData.defaultDatasetId}`,
);

const webhookRes = await fetch(endpoint, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    apikey: SUPABASE_ANON_KEY,
    "X-Apify-Webhook-Secret": APIFY_WEBHOOK_SECRET,
  },
  body: JSON.stringify({
    eventType: "ACTOR.RUN.SUCCEEDED",
    resource: {
      id: runData.id,
      defaultDatasetId: runData.defaultDatasetId,
      status: "SUCCEEDED",
      actId: "clockworks~tiktok-scraper",
    },
    social_link_id: SEED_TIKTOK_SOCIAL_LINK_ID,
    scrape_mode: "tiktok_profile",
    run_id: runData.id,
    apify_finished_at: new Date().toISOString(),
  }),
});
const webhookBody = await webhookRes.json();
console.log("webhook response:", webhookRes.status, webhookBody);
if (
  webhookRes.status !== 200 ||
  webhookBody.inserted !== true ||
  webhookBody.duplicate !== false
) {
  console.error("webhook did not insert successfully");
  process.exit(1);
}

console.log(
  `ok — live e2e completed. run_id=${runData.id} — verify snapshot + denorm via MCP execute_sql.`,
);

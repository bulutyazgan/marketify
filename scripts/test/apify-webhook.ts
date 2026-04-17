// Smoke test for the deployed apify-webhook edge function (US-016, US-017,
// US-018).
//
// Usage: bun run scripts/test/apify-webhook.ts
// Requires SUPABASE_URL, SUPABASE_ANON_KEY, APIFY_WEBHOOK_SECRET in .env.
//
// Covers the paths that don't need a live Apify run — the SUCCEEDED branch
// (which pulls a real dataset) is exercised end-to-end in the iteration's
// MCP verification, not here.
//
// Asserts:
//   1.  Missing X-Apify-Webhook-Secret → 401 UNAUTHORIZED
//   2.  Wrong secret → 401 UNAUTHORIZED (constant-time reject)
//   3.  Malformed JSON body with valid secret → 400 INVALID_JSON
//   4.  Missing required fields → 400 INVALID_REQUEST
//   5.  Unknown scrape_mode → 200 { skipped:'unsupported_scrape_mode' }
//       (defensive coverage for the catch-all branch; tiktok_profile,
//        ig_details, and ig_posts are all live)
//   6.  tiktok_profile + ACTOR.RUN.FAILED → 200 { inserted:true, duplicate:false }
//   7.  Replay same tiktok_profile run_id → 200 { inserted:false, duplicate:true }
//   8.  ig_details + ACTOR.RUN.FAILED → 200 { inserted:true, duplicate:false }
//   9.  Replay same ig_details run_id → 200 { inserted:false, duplicate:true }
//   10. ig_posts + ACTOR.RUN.FAILED → 200 { inserted:true, duplicate:false }
//   11. Replay same ig_posts run_id → 200 { inserted:false, duplicate:true }

const supabaseUrl = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
const webhookSecret = process.env.APIFY_WEBHOOK_SECRET;
if (!supabaseUrl || !anonKey || !webhookSecret) {
  console.error(
    "SUPABASE_URL, SUPABASE_ANON_KEY, and APIFY_WEBHOOK_SECRET are required in .env",
  );
  process.exit(1);
}

const endpoint = `${supabaseUrl}/functions/v1/apify-webhook`;
// anon key is required by the Supabase gateway even for verify_jwt=false
// functions; the edge function itself validates X-Apify-Webhook-Secret.
const gatewayHeaders = {
  Authorization: `Bearer ${anonKey}`,
  apikey: anonKey,
};

const SEED_TIKTOK_SOCIAL_LINK_ID = "11111111-1111-1111-1111-111111111020";
const SEED_INSTAGRAM_SOCIAL_LINK_ID = "11111111-1111-1111-1111-111111111021";
const unique = Date.now();

function basePayload(overrides: Record<string, unknown> = {}) {
  const runId = `us017_test_${unique}_${Math.random().toString(36).slice(2, 10)}`;
  return {
    eventType: "ACTOR.RUN.FAILED",
    resource: {
      id: runId,
      defaultDatasetId: `dataset_${runId}`,
      status: "FAILED",
      actId: "clockworks~tiktok-scraper",
    },
    social_link_id: SEED_TIKTOK_SOCIAL_LINK_ID,
    scrape_mode: "tiktok_profile",
    run_id: runId,
    apify_finished_at: new Date().toISOString(),
    ...overrides,
  };
}

async function postRaw(
  body: string | object,
  extraHeaders: Record<string, string> = {},
) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...gatewayHeaders,
      ...extraHeaders,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

function expect(label: string, cond: boolean, ctx: unknown) {
  if (!cond) {
    console.error(`FAIL ${label}:`, ctx);
    process.exit(1);
  }
  console.log(`ok — ${label}`);
}

// 1. Missing secret header
{
  const r = await postRaw(basePayload());
  expect(
    "missing secret → 401 UNAUTHORIZED",
    r.status === 401 && r.data?.error === "UNAUTHORIZED",
    r,
  );
}

// 2. Wrong secret header
{
  const r = await postRaw(basePayload(), {
    "X-Apify-Webhook-Secret": "definitely-not-the-real-secret",
  });
  expect(
    "wrong secret → 401 UNAUTHORIZED",
    r.status === 401 && r.data?.error === "UNAUTHORIZED",
    r,
  );
}

// 3. Malformed JSON (valid secret)
{
  const r = await postRaw("{not json", {
    "X-Apify-Webhook-Secret": webhookSecret,
  });
  expect(
    "malformed json → 400 INVALID_JSON",
    r.status === 400 && r.data?.error === "INVALID_JSON",
    r,
  );
}

// 4. Missing required fields
{
  const r = await postRaw(
    { eventType: "ACTOR.RUN.SUCCEEDED" },
    { "X-Apify-Webhook-Secret": webhookSecret },
  );
  expect(
    "missing fields → 400 INVALID_REQUEST",
    r.status === 400 && r.data?.error === "INVALID_REQUEST",
    r,
  );
}

// 5. Unknown scrape_mode → defensive unsupported_scrape_mode short-circuit
{
  const r = await postRaw(
    basePayload({ scrape_mode: "bogus_mode" }),
    { "X-Apify-Webhook-Secret": webhookSecret },
  );
  expect(
    "unknown scrape_mode → 200 skipped",
    r.status === 200 && r.data?.skipped === "unsupported_scrape_mode",
    r,
  );
}

// 6. tiktok_profile + FAILED event → inserts failed snapshot
const failedTikTokRunBody = basePayload();
{
  const r = await postRaw(failedTikTokRunBody, {
    "X-Apify-Webhook-Secret": webhookSecret,
  });
  expect(
    "tiktok_profile FAILED → 200 inserted",
    r.status === 200 && r.data?.inserted === true && r.data?.duplicate === false,
    r,
  );
}

// 7. Same tiktok_profile run_id replay → idempotent duplicate
{
  const r = await postRaw(failedTikTokRunBody, {
    "X-Apify-Webhook-Secret": webhookSecret,
  });
  expect(
    "replay same tiktok_profile run_id → 200 duplicate",
    r.status === 200 && r.data?.inserted === false && r.data?.duplicate === true,
    r,
  );
}

// 8. ig_details + FAILED event → inserts failed snapshot against the IG seed link
const igRunId = `us017_ig_${unique}_${Math.random().toString(36).slice(2, 10)}`;
const failedIgDetailsRunBody = basePayload({
  scrape_mode: "ig_details",
  social_link_id: SEED_INSTAGRAM_SOCIAL_LINK_ID,
  resource: {
    id: igRunId,
    defaultDatasetId: `dataset_ig_${unique}`,
    status: "FAILED",
    actId: "apify~instagram-scraper",
  },
  run_id: igRunId,
});
{
  const r = await postRaw(failedIgDetailsRunBody, {
    "X-Apify-Webhook-Secret": webhookSecret,
  });
  expect(
    "ig_details FAILED → 200 inserted",
    r.status === 200 && r.data?.inserted === true && r.data?.duplicate === false,
    r,
  );
}

// 9. Same ig_details run_id replay → idempotent duplicate
{
  const r = await postRaw(failedIgDetailsRunBody, {
    "X-Apify-Webhook-Secret": webhookSecret,
  });
  expect(
    "replay same ig_details run_id → 200 duplicate",
    r.status === 200 && r.data?.inserted === false && r.data?.duplicate === true,
    r,
  );
}

// 10. ig_posts + FAILED event → inserts failed snapshot against the IG seed link
const igPostsRunId = `us018_ig_posts_${unique}_${Math.random().toString(36).slice(2, 10)}`;
const failedIgPostsRunBody = basePayload({
  scrape_mode: "ig_posts",
  social_link_id: SEED_INSTAGRAM_SOCIAL_LINK_ID,
  resource: {
    id: igPostsRunId,
    defaultDatasetId: `dataset_ig_posts_${unique}`,
    status: "FAILED",
    actId: "apify~instagram-scraper",
  },
  run_id: igPostsRunId,
});
{
  const r = await postRaw(failedIgPostsRunBody, {
    "X-Apify-Webhook-Secret": webhookSecret,
  });
  expect(
    "ig_posts FAILED → 200 inserted",
    r.status === 200 && r.data?.inserted === true && r.data?.duplicate === false,
    r,
  );
}

// 11. Same ig_posts run_id replay → idempotent duplicate
{
  const r = await postRaw(failedIgPostsRunBody, {
    "X-Apify-Webhook-Secret": webhookSecret,
  });
  expect(
    "replay same ig_posts run_id → 200 duplicate",
    r.status === 200 && r.data?.inserted === false && r.data?.duplicate === true,
    r,
  );
}

console.log("all apify-webhook smoke tests passed");

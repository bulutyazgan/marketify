// Edge function: metrics-refresh (US-021)
//
// Contract:
//   POST { social_link_id: string }
//     → 200 {
//         status: 'queued' | 'already_fresh',
//         snapshot_ids: string[],     // ids of the latest fresh per-mode rows
//                                     //   on 'already_fresh' (1 for TikTok, 2
//                                     //   for Instagram); empty on 'queued'
//                                     //   until the pre-row model lands
//         metrics_status: { tiktok?: Status, ig_details?: Status, ig_posts?: Status },
//       }
//       where Status is 'fresh' | 'refreshing' | 'failed'.
//     → 400 { error: 'INVALID_JSON' | 'INVALID_REQUEST' }
//     → 401 { error: 'UNAUTHORIZED' }
//     → 403 { error: 'FORBIDDEN' }            // non-creator role
//     → 404 { error: 'LINK_NOT_FOUND' }       // social_link_id not owned by caller or missing
//     → 422 { error: 'LINK_UNLINKED' }        // the link is in status='unlinked'
//     → 429 { error: 'RATE_LIMIT', retry_after_sec: number }
//     → 500 { error: 'SERVER_MISCONFIGURED' | 'DB_ERROR' }
//     → 502 { error: 'APIFY_ERROR' }          // every dispatched run rejected
//
// Auth: Marketify JWT (HS256, MARKETIFY_JWT_SECRET). Verifies via
//       _shared/jwt.ts and asserts role='creator'. Deployed with
//       verify_jwt=false at the gateway because the gateway only knows
//       about Supabase's own JWT secret — the handler enforces auth.
//
// Throttle: per spec §5.2 / §1.6 a creator may refresh at most once
// per 6h per social_link. Keyed on `social_links.last_scrape_attempt_at`
// and enforced with a SINGLE conditional UPDATE (atomic CAS):
//
//   UPDATE social_links
//     SET last_scrape_attempt_at = now()
//   WHERE id = $1
//     AND (last_scrape_attempt_at IS NULL
//          OR last_scrape_attempt_at < now() - interval '6 hours')
//   RETURNING last_scrape_attempt_at
//
// If zero rows come back the throttle is still active → 429. This closes
// the TOCTOU window a SELECT-then-UPDATE pair would leave: two concurrent
// refreshes for the same link can't both pass the gate. The bump happens
// BEFORE Apify dispatch so a downstream failure still burns the 6h window
// — this intentionally costs the creator a 6h retry if dispatch flakes,
// but protects Apify budget against spam through a flaky path.
//
// already_fresh: §5.2 returns `status: 'already_fresh'` when the creator
// already has fresh-enough data for every scrape_mode the platform
// requires (tiktok_profile for TikTok; ig_details + ig_posts for
// Instagram). The check runs BEFORE the throttle bump: if
// metric_snapshots has an `is_latest=true`, `status='fresh'` row per
// required mode whose `fetched_at` is within the throttle window (6h),
// we return the ids of those rows with `status='already_fresh'` and
// skip Apify entirely. This path is reachable today because the webhook
// RPCs (US-016..US-018) do set `status='fresh'` + `is_latest=true` on
// success.
//
// Dispatch: mirrors US-020 (auth-signup-creator). TikTok triggers 1
// run (tiktok_profile); Instagram triggers 2 runs (ig_details +
// ig_posts). Each run registers a per-run webhook pointing at
// /functions/v1/apify-webhook. waitSecs=60 matches the signup path so
// the UI can either render 'fresh' immediately or 'refreshing' and
// poll. Promise.allSettled — partial failure reports a 'failed' status
// for that mode; the creator keeps whatever they already had. If
// EVERY task rejected at the network layer the endpoint returns
// 502 APIFY_ERROR so the client can distinguish "apify is down" from
// "scrape will finish asynchronously".
//
// Spec gap: §5.2 specifies `snapshot_ids` on the `queued` response as
// pre-inserted `status='refreshing'` rows. US-016..US-020 ship with
// INSERT + ON CONFLICT DO NOTHING in the webhook RPCs (no UPDATE-or-
// INSERT), so pre-rows would leave permanent `refreshing` rows the
// webhook can't clear. Once a webhook RPC story extends each persist_*
// RPC to UPDATE-or-INSERT, this function can pre-insert the rows and
// return real ids on `queued`. Until then snapshot_ids is [] on
// `queued` and the UI must rely on realtime subscriptions to
// metric_snapshots keyed on social_link_id (per US-036).
// metrics_status keeps the client informed of the per-mode outcome —
// mirrors the US-020 shape so clients can share rendering code.
//
// Cost/rate: APIFY_KEY + APIFY_WEBHOOK_SECRET must be set. If absent,
// returns 500 SERVER_MISCONFIGURED before bumping `last_scrape_attempt_at`
// so the throttle is not burned when dispatch isn't possible.

import { createClient } from "npm:@supabase/supabase-js@2";
import { verifyJwt } from "../_shared/jwt.ts";
import { corsHeaders } from "../_shared/cors.ts";
import {
  type ApifyRunResult,
  type ApifyWebhookSpec,
  runInstagramDetails,
  runInstagramPosts,
  runTikTokProfile,
} from "../_shared/apify.ts";

const THROTTLE_SECS = 6 * 60 * 60;
const APIFY_WAIT_SECS = 60;
const APIFY_TERMINAL_EVENTS = [
  "ACTOR.RUN.SUCCEEDED",
  "ACTOR.RUN.FAILED",
  "ACTOR.RUN.TIMED_OUT",
  "ACTOR.RUN.ABORTED",
];
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type MetricsKey = "tiktok" | "ig_details" | "ig_posts";
type MetricsStatus = "fresh" | "refreshing" | "failed";

interface RefreshRequest {
  social_link_id?: unknown;
}

interface SocialLinkRow {
  id: string;
  user_id: string;
  platform: "tiktok" | "instagram";
  handle: string;
  status: string;
  last_scrape_attempt_at: string | null;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function bearerToken(req: Request): string | null {
  const raw = req.headers.get("Authorization") ?? req.headers.get("authorization");
  if (!raw) return null;
  const m = raw.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse(405, { error: "METHOD_NOT_ALLOWED" });
  }

  const token = bearerToken(req);
  if (!token) return jsonResponse(401, { error: "UNAUTHORIZED" });

  let claims;
  try {
    claims = await verifyJwt(token);
  } catch {
    return jsonResponse(401, { error: "UNAUTHORIZED" });
  }
  if (claims.app_role !== "creator") {
    return jsonResponse(403, { error: "FORBIDDEN" });
  }

  let body: RefreshRequest;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(400, { error: "INVALID_JSON" });
  }

  const socialLinkId =
    typeof body.social_link_id === "string" &&
    UUID_RE.test(body.social_link_id)
      ? body.social_link_id
      : null;
  if (!socialLinkId) {
    return jsonResponse(400, { error: "INVALID_REQUEST" });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const apifyKey = Deno.env.get("APIFY_KEY");
  const webhookSecret = Deno.env.get("APIFY_WEBHOOK_SECRET");
  if (!supabaseUrl || !serviceRoleKey || !apifyKey || !webhookSecret) {
    return jsonResponse(500, { error: "SERVER_MISCONFIGURED" });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: link, error: linkError } = await supabase
    .from("social_links")
    .select(
      "id,user_id,platform,handle,status,last_scrape_attempt_at",
    )
    .eq("id", socialLinkId)
    .maybeSingle();

  if (linkError) {
    console.error("social_links lookup failed", linkError);
    return jsonResponse(500, { error: "DB_ERROR" });
  }
  const row = link as SocialLinkRow | null;
  if (!row || row.user_id !== claims.sub) {
    // 404 rather than 403 so the endpoint doesn't leak which ids exist
    // for other creators.
    return jsonResponse(404, { error: "LINK_NOT_FOUND" });
  }
  if (row.status === "unlinked") {
    return jsonResponse(422, { error: "LINK_UNLINKED" });
  }

  const requiredModes = requiredScrapeModes(row.platform);
  const nowMs = Date.now();
  const cutoffIso = new Date(nowMs - THROTTLE_SECS * 1000).toISOString();

  // already_fresh short-circuit: the creator already has current data for
  // every required mode, so we skip Apify and return the existing ids.
  // Runs BEFORE the throttle bump so a caller who polls repeatedly while
  // data is fresh doesn't burn their 6h window.
  const freshSnapshots = await fetchLatestFreshSnapshots(
    supabase,
    row.id,
    requiredModes,
    cutoffIso,
  );
  if (freshSnapshots === "db_error") {
    return jsonResponse(500, { error: "DB_ERROR" });
  }
  if (freshSnapshots.size === requiredModes.length) {
    const alreadyFreshMetrics: Partial<Record<MetricsKey, MetricsStatus>> = {};
    for (const mode of requiredModes) {
      alreadyFreshMetrics[modeToMetricsKey(mode)] = "fresh";
    }
    return jsonResponse(200, {
      status: "already_fresh",
      snapshot_ids: requiredModes.map((m) => freshSnapshots.get(m)!),
      metrics_status: alreadyFreshMetrics,
    });
  }

  // Atomic 6h throttle check + bump in a single conditional UPDATE. If
  // zero rows come back the throttle was already active when we raced
  // another request; we then re-read `last_scrape_attempt_at` to compute
  // retry_after_sec. Concurrent callers can't both pass this gate.
  const nowIso = new Date(nowMs).toISOString();
  const { data: bumped, error: bumpError } = await supabase
    .from("social_links")
    .update({ last_scrape_attempt_at: nowIso })
    .eq("id", row.id)
    .or(`last_scrape_attempt_at.is.null,last_scrape_attempt_at.lt.${cutoffIso}`)
    .select("id");
  if (bumpError) {
    console.error("social_links last_scrape_attempt_at bump failed", bumpError);
    return jsonResponse(500, { error: "DB_ERROR" });
  }
  if (!bumped || bumped.length === 0) {
    const retryAfterSec = await computeRetryAfterSec(
      supabase,
      row.id,
      nowMs,
    );
    return jsonResponse(429, {
      error: "RATE_LIMIT",
      retry_after_sec: retryAfterSec,
    });
  }

  const { metricsStatus, allFailed } = await dispatchApifyRuns({
    supabaseUrl,
    webhookSecret,
    link: row,
  });

  if (allFailed) {
    return jsonResponse(502, { error: "APIFY_ERROR" });
  }

  return jsonResponse(200, {
    status: "queued",
    snapshot_ids: [] as string[],
    metrics_status: metricsStatus,
  });
});

function requiredScrapeModes(
  platform: SocialLinkRow["platform"],
): Array<"tiktok_profile" | "ig_details" | "ig_posts"> {
  return platform === "tiktok"
    ? ["tiktok_profile"]
    : ["ig_details", "ig_posts"];
}

function modeToMetricsKey(
  mode: "tiktok_profile" | "ig_details" | "ig_posts",
): MetricsKey {
  return mode === "tiktok_profile" ? "tiktok" : mode;
}

// Returns a Map<scrape_mode, snapshot_id> containing the latest fresh
// snapshot per required mode whose fetched_at is newer than the cutoff.
// The Map is empty-or-partial if any required mode lacks a fresh row.
// deno-lint-ignore no-explicit-any -- supabase-js generic args differ
// between the createClient call above (inferred as public schema) and
// any helper import; typing loosely avoids a widening mismatch.
async function fetchLatestFreshSnapshots(
  supabase: any,
  socialLinkId: string,
  requiredModes: Array<"tiktok_profile" | "ig_details" | "ig_posts">,
  cutoffIso: string,
): Promise<Map<string, string> | "db_error"> {
  const { data, error } = await supabase
    .from("metric_snapshots")
    .select("id,scrape_mode,fetched_at")
    .eq("social_link_id", socialLinkId)
    .eq("is_latest", true)
    .eq("status", "fresh")
    .in("scrape_mode", requiredModes)
    .gte("fetched_at", cutoffIso);
  if (error) {
    console.error("metric_snapshots lookup failed", error);
    return "db_error";
  }
  const rows = (data ?? []) as Array<{ id: string; scrape_mode: string }>;
  const out = new Map<string, string>();
  for (const r of rows) {
    if (requiredModes.includes(r.scrape_mode as (typeof requiredModes)[number])) {
      out.set(r.scrape_mode, r.id);
    }
  }
  return out;
}

// Re-reads last_scrape_attempt_at after the CAS UPDATE returned zero rows
// so the 429 carries an accurate retry_after_sec. If the read fails for
// any reason we fall back to the full throttle window rather than leak a
// DB_ERROR on a path that's already a rejection.
// deno-lint-ignore no-explicit-any -- see note above on supabase-js generics
async function computeRetryAfterSec(
  supabase: any,
  socialLinkId: string,
  nowMs: number,
): Promise<number> {
  const { data, error } = await supabase
    .from("social_links")
    .select("last_scrape_attempt_at")
    .eq("id", socialLinkId)
    .maybeSingle();
  if (error || !data?.last_scrape_attempt_at) {
    return THROTTLE_SECS;
  }
  const lastMs = Date.parse(data.last_scrape_attempt_at);
  if (!Number.isFinite(lastMs)) return THROTTLE_SECS;
  const elapsedSec = Math.floor((nowMs - lastMs) / 1000);
  return Math.max(1, THROTTLE_SECS - elapsedSec);
}

async function dispatchApifyRuns(params: {
  supabaseUrl: string;
  webhookSecret: string;
  link: SocialLinkRow;
}): Promise<{
  metricsStatus: Partial<Record<MetricsKey, MetricsStatus>>;
  allFailed: boolean;
}> {
  const { supabaseUrl, webhookSecret, link } = params;
  const metricsStatus: Partial<Record<MetricsKey, MetricsStatus>> = {};

  const webhookUrl = `${supabaseUrl}/functions/v1/apify-webhook`;
  const buildWebhook = (
    linkId: string,
    scrapeMode: "tiktok_profile" | "ig_details" | "ig_posts",
  ): ApifyWebhookSpec => ({
    eventTypes: APIFY_TERMINAL_EVENTS,
    requestUrl: webhookUrl,
    payloadTemplate: JSON.stringify({
      eventType: "{{eventType}}",
      resource: {
        id: "{{resource.id}}",
        defaultDatasetId: "{{resource.defaultDatasetId}}",
        status: "{{resource.status}}",
        actId: "{{resource.actId}}",
      },
      social_link_id: linkId,
      scrape_mode: scrapeMode,
      run_id: "{{resource.id}}",
      dataset_id: "{{resource.defaultDatasetId}}",
    }),
    headersTemplate: JSON.stringify({
      "X-Apify-Webhook-Secret": webhookSecret,
    }),
    shouldInterpolateStrings: true,
  });

  interface Task {
    key: MetricsKey;
    run: () => Promise<ApifyRunResult>;
  }
  const tasks: Task[] = [];
  if (link.platform === "tiktok") {
    tasks.push({
      key: "tiktok",
      run: () =>
        runTikTokProfile(link.handle, {
          waitSecs: APIFY_WAIT_SECS,
          webhooks: [buildWebhook(link.id, "tiktok_profile")],
        }),
    });
  } else if (link.platform === "instagram") {
    tasks.push({
      key: "ig_details",
      run: () =>
        runInstagramDetails(link.handle, {
          waitSecs: APIFY_WAIT_SECS,
          webhooks: [buildWebhook(link.id, "ig_details")],
        }),
    });
    tasks.push({
      key: "ig_posts",
      run: () =>
        runInstagramPosts(link.handle, {
          waitSecs: APIFY_WAIT_SECS,
          webhooks: [buildWebhook(link.id, "ig_posts")],
        }),
    });
  }

  const settled = await Promise.allSettled(tasks.map((t) => t.run()));
  let rejectedCount = 0;
  settled.forEach((outcome, i) => {
    const key = tasks[i].key;
    if (outcome.status === "fulfilled") {
      const s = outcome.value.status;
      metricsStatus[key] = s === "SUCCEEDED"
        ? "fresh"
        : s === "READY" || s === "RUNNING" ||
            s === "TIMING-OUT" || s === "ABORTING"
        ? "refreshing"
        : "failed";
    } else {
      rejectedCount += 1;
      console.error(`apify ${key} dispatch failed`, outcome.reason);
      metricsStatus[key] = "failed";
    }
  });

  // `allFailed` flags the case where every task rejected at the transport
  // layer (Apify down, credentials rejected, etc.). Partial failures or
  // terminal-but-non-SUCCEEDED statuses stay on 200 with per-key 'failed'
  // so the client can still render whatever succeeded.
  const allFailed = tasks.length > 0 && rejectedCount === tasks.length;
  return { metricsStatus, allFailed };
}


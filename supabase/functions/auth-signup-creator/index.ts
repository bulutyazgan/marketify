// Edge function: auth-signup-creator (US-019 + US-020)
//
// Contract:
//   POST { username: string, tiktok_handle?: string, instagram_handle?: string }
//     → 200 {
//         token: string,
//         user_id: string,
//         role: 'creator',
//         metrics_status: { tiktok?: Status, ig_details?: Status, ig_posts?: Status },
//       }
//       where Status is 'fresh' | 'refreshing' | 'failed'.
//     → 400 { error: 'INVALID_REQUEST' | 'INVALID_JSON' }
//     → 422 { error: 'HANDLE_REQUIRED' }
//     → 409 { error: 'USERNAME_TAKEN' | 'HANDLE_TAKEN' }
//     → 500 { error: 'SERVER_MISCONFIGURED' | 'DB_ERROR' | 'JWT_ERROR' }
//
// Auth: none. This is how a creator obtains their first JWT, so the
// endpoint is verify_jwt=false at the gateway. The handler itself mints
// the token via _shared/jwt.ts (HS256, MARKETIFY_JWT_SECRET).
//
// Atomicity: the users + creator_profiles + social_links inserts run
// inside a single Postgres transaction via the public.auth_signup_creator
// RPC (us_019 migration). A failure on any insert rolls back the flow.
// Apify dispatch happens AFTER the RPC commits — per spec §5.1, a
// dispatch failure does NOT roll back the account (the user gets their
// JWT, metrics_status carries the per-platform outcome so the client can
// decide whether to retry later or surface a 'refreshing' placeholder).
//
// Handle normalization: leading '@' is stripped and whitespace trimmed
// before the RPC call. Handles are compared case-insensitively (citext),
// matching social_links.handle's column type.
//
// Apify dispatch (US-020): once the RPC commits, we look up the
// freshly-inserted social_links rows, then kick one or more Apify runs in
// parallel via Promise.allSettled — tiktok_profile for TikTok handles;
// ig_details and ig_posts for Instagram handles. Each run is registered
// with a per-run webhook pointing back at /functions/v1/apify-webhook so
// the receiver can persist the metric_snapshots row when Apify finishes.
// The wait window is APIFY_WAIT_SECS (60s); runs that come back
// SUCCEEDED within the window are reported as 'fresh' (the webhook will
// also arrive and be deduped via the unique index on run_id), otherwise
// 'refreshing' and the client polls. A thrown dispatch is 'failed'.
//
// Pre-refreshing rows: the spec calls for pre-creating metric_snapshots
// rows in status='refreshing' before the scrape so the client has
// something to read. That's deferred — the existing US-016..US-018 RPCs
// INSERT on webhook arrival via ON CONFLICT DO NOTHING, so the row
// appears only once Apify finishes. Tracked as a spec gap in progress.txt.
//
// Rate limit: not implemented yet. Spec §5.1 requires per-IP throttling
// via a signup_attempts table (does not yet exist). Same status as the
// sibling auth-signup-lister — tracked in progress.txt Codebase Patterns.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { signJwt } from "../_shared/jwt.ts";
import { corsHeaders } from "../_shared/cors.ts";
import {
  type ApifyRunResult,
  type ApifyWebhookSpec,
  runInstagramDetails,
  runInstagramPosts,
  runTikTokProfile,
} from "../_shared/apify.ts";

const APIFY_WAIT_SECS = 60;
const APIFY_TERMINAL_EVENTS = [
  "ACTOR.RUN.SUCCEEDED",
  "ACTOR.RUN.FAILED",
  "ACTOR.RUN.TIMED_OUT",
  "ACTOR.RUN.ABORTED",
];

type MetricsKey = "tiktok" | "ig_details" | "ig_posts";
type MetricsStatus = "fresh" | "refreshing" | "failed";

interface SignupRequest {
  username?: unknown;
  tiktok_handle?: unknown;
  instagram_handle?: unknown;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function normalizeHandle(value: unknown): string | null {
  if (!isString(value)) return null;
  const stripped = value.trim().replace(/^@+/, "").trim();
  return stripped.length > 0 ? stripped : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse(405, { error: "METHOD_NOT_ALLOWED" });
  }

  let body: SignupRequest;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(400, { error: "INVALID_JSON" });
  }

  const username =
    isString(body.username) && body.username.trim().length > 0
      ? body.username.trim()
      : null;
  const tiktokHandle = normalizeHandle(body.tiktok_handle);
  const instagramHandle = normalizeHandle(body.instagram_handle);

  if (!username) {
    return jsonResponse(400, { error: "INVALID_REQUEST" });
  }
  if (!tiktokHandle && !instagramHandle) {
    return jsonResponse(422, { error: "HANDLE_REQUIRED" });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse(500, { error: "SERVER_MISCONFIGURED" });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await supabase.rpc("auth_signup_creator", {
    p_username: username,
    p_tiktok_handle: tiktokHandle,
    p_instagram_handle: instagramHandle,
  });

  if (error) {
    console.error("auth_signup_creator rpc error", error);
    return jsonResponse(500, { error: "DB_ERROR" });
  }

  const result = data as { user_id?: string; error?: string } | null;
  if (result?.error === "USERNAME_TAKEN") {
    return jsonResponse(409, { error: "USERNAME_TAKEN" });
  }
  if (result?.error === "HANDLE_TAKEN") {
    return jsonResponse(409, { error: "HANDLE_TAKEN" });
  }
  if (!result?.user_id) {
    console.error("auth_signup_creator returned unexpected shape", result);
    return jsonResponse(500, { error: "DB_ERROR" });
  }

  const userId = result.user_id;
  const sessionId = crypto.randomUUID();
  let token: string;
  try {
    token = await signJwt({
      sub: userId,
      role: "creator",
      session_id: sessionId,
    });
  } catch (err) {
    console.error("signJwt failed", err);
    return jsonResponse(500, { error: "JWT_ERROR" });
  }

  const metricsStatus = await dispatchApifyRuns({
    supabase,
    supabaseUrl,
    userId,
    tiktokHandle,
    instagramHandle,
  });

  return jsonResponse(200, {
    token,
    user_id: userId,
    role: "creator",
    metrics_status: metricsStatus,
  });
});

// Dispatches the Apify runs required for the freshly-created creator
// account. Returns a partial metrics_status map keyed by platform. If
// APIFY_KEY or APIFY_WEBHOOK_SECRET is unset (e.g. local dev without
// Apify credentials), logs a warning and returns {} — the account is
// still usable, the client just won't see any metrics until a future
// scrape picks it up. A failure to dispatch a single platform does not
// affect the others.
// deno-lint-ignore no-explicit-any -- supabase-js generic args differ between
// the createClient call above (inferred as public schema) and any helper
// import; typing this parameter loosely avoids a widening mismatch.
async function dispatchApifyRuns(params: {
  supabase: SupabaseClient<any, any, any>;
  supabaseUrl: string;
  userId: string;
  tiktokHandle: string | null;
  instagramHandle: string | null;
}): Promise<Partial<Record<MetricsKey, MetricsStatus>>> {
  const { supabase, supabaseUrl, userId, tiktokHandle, instagramHandle } =
    params;
  const metricsStatus: Partial<Record<MetricsKey, MetricsStatus>> = {};

  const apifyKey = Deno.env.get("APIFY_KEY");
  const webhookSecret = Deno.env.get("APIFY_WEBHOOK_SECRET");
  if (!apifyKey || !webhookSecret) {
    console.warn(
      "apify dispatch skipped: APIFY_KEY or APIFY_WEBHOOK_SECRET missing",
    );
    return metricsStatus;
  }

  const { data: links, error: linksError } = await supabase
    .from("social_links")
    .select("id,platform")
    .eq("user_id", userId);
  if (linksError) {
    console.error("social_links lookup failed", linksError);
    return metricsStatus;
  }

  const linkRows = (links ?? []) as Array<{ id: string; platform: string }>;
  const tiktokLinkId = linkRows.find((l) => l.platform === "tiktok")?.id;
  const igLinkId = linkRows.find((l) => l.platform === "instagram")?.id;

  const webhookUrl = `${supabaseUrl}/functions/v1/apify-webhook`;
  const buildWebhook = (
    linkId: string,
    scrapeMode: "tiktok_profile" | "ig_details" | "ig_posts",
  ): ApifyWebhookSpec => ({
    eventTypes: APIFY_TERMINAL_EVENTS,
    requestUrl: webhookUrl,
    // Build a `resource` object field-by-field using dot-notation
    // placeholders. Apify only substitutes placeholders that appear inside
    // quoted JSON string values when `shouldInterpolateStrings: true`; bare
    // unquoted `{{var}}` substitutes the raw JSON value but can't round-trip
    // through JSON.stringify. Sticking to the quoted form keeps the template
    // valid JSON before substitution and readable by any linter.
    // apify-webhook/index.ts validResource requires id, defaultDatasetId,
    // status, and actId on the resource object.
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
  if (tiktokHandle && tiktokLinkId) {
    tasks.push({
      key: "tiktok",
      run: () =>
        runTikTokProfile(tiktokHandle, {
          waitSecs: APIFY_WAIT_SECS,
          webhooks: [buildWebhook(tiktokLinkId, "tiktok_profile")],
        }),
    });
  }
  if (instagramHandle && igLinkId) {
    tasks.push({
      key: "ig_details",
      run: () =>
        runInstagramDetails(instagramHandle, {
          waitSecs: APIFY_WAIT_SECS,
          webhooks: [buildWebhook(igLinkId, "ig_details")],
        }),
    });
    tasks.push({
      key: "ig_posts",
      run: () =>
        runInstagramPosts(instagramHandle, {
          waitSecs: APIFY_WAIT_SECS,
          webhooks: [buildWebhook(igLinkId, "ig_posts")],
        }),
    });
  }

  if (tasks.length === 0) return metricsStatus;

  const settled = await Promise.allSettled(tasks.map((t) => t.run()));
  settled.forEach((outcome, i) => {
    const key = tasks[i].key;
    if (outcome.status === "fulfilled") {
      // Apify's waitForFinish returns either SUCCEEDED (complete) or a
      // transitional status when the wait expires: READY, RUNNING,
      // TIMING-OUT, ABORTING. All four mean the webhook will still
      // fire and complete the snapshot, so they map to 'refreshing'.
      // Anything else (e.g. FAILED, ABORTED, TIMED-OUT terminal) is a
      // terminal non-success — 'failed'. The webhook receiver will
      // also write the failed row; the two converge via the run_id
      // unique index.
      const s = outcome.value.status;
      metricsStatus[key] = s === "SUCCEEDED"
        ? "fresh"
        : s === "READY" || s === "RUNNING" ||
            s === "TIMING-OUT" || s === "ABORTING"
        ? "refreshing"
        : "failed";
    } else {
      console.error(`apify ${key} dispatch failed`, outcome.reason);
      metricsStatus[key] = "failed";
    }
  });

  return metricsStatus;
}

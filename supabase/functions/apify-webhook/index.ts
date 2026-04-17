// Edge function: apify-webhook (US-016)
//
// Contract:
//   POST (headers include X-Apify-Webhook-Secret)
//     body: {
//       eventType: 'ACTOR.RUN.SUCCEEDED'|'ACTOR.RUN.FAILED'
//                 |'ACTOR.RUN.TIMED_OUT'|'ACTOR.RUN.ABORTED',
//       resource: { id, defaultDatasetId, status, actId },
//       social_link_id, scrape_mode, run_id,
//       status?, apify_finished_at?, dataset_id?,   // injected via payloadTemplate
//     }
//     → 200 { ok: true, inserted?: bool, duplicate?: bool, skipped?: 'unsupported_scrape_mode' }
//     → 400 { error: 'INVALID_JSON' | 'INVALID_REQUEST' }
//     → 401 { error: 'UNAUTHORIZED' }
//     → 405 { error: 'METHOD_NOT_ALLOWED' }
//     → 500 { error: 'SERVER_MISCONFIGURED' | 'DB_ERROR' | 'APIFY_FETCH_ERROR' }
//
// Auth: no JWT — webhook-auth via constant-time compare of the
//   X-Apify-Webhook-Secret header against env APIFY_WEBHOOK_SECRET or
//   APIFY_WEBHOOK_SECRET_PREVIOUS (dual-secret rotation window per
//   docs/tech-architecture.md §3g). Deploy with --no-verify-jwt.
//
// Idempotency: the RPC public.apify_webhook_persist_tiktok_profile inserts
//   one metric_snapshots row keyed on apify_run_id; the partial unique index
//   metric_snapshots_run_uniq makes the second webhook for the same run a
//   no-op. RPC returns {inserted, duplicate, snapshot_id?}.
//
// Scope (US-016): tiktok_profile branch only. ig_details / ig_posts return
//   200 { skipped: 'unsupported_scrape_mode' } so Apify doesn't retry; the
//   matching branches ship with US-017.
//
// Pre-refreshing-row note (US-020 handoff): the RPC currently INSERTs (never
//   UPDATEs), so it assumes no existing snapshot row carries this apify_run_id.
//   US-020 (auth-signup-creator Apify dispatch) will pre-create snapshots in
//   status='refreshing' before the webhook arrives — at that point this RPC
//   (or the denorm trigger) must be extended to UPDATE-then-denorm. See the
//   spec-gap note in the us_016_apify_webhook_persist_rpc migration.

import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

const APIFY_API_BASE = "https://api.apify.com/v2";

interface WebhookBody {
  eventType?: unknown;
  resource?: unknown;
  social_link_id?: unknown;
  scrape_mode?: unknown;
  run_id?: unknown;
  status?: unknown;
  apify_finished_at?: unknown;
  dataset_id?: unknown;
}

interface ApifyResource {
  id: string;
  defaultDatasetId: string;
  status: string;
  actId: string;
}

interface TikTokAuthorMeta {
  fans?: number;
  following?: number;
  heart?: number;
  video?: number;
  verified?: boolean;
}

interface TikTokItem {
  authorMeta?: TikTokAuthorMeta;
  playCount?: number;
}

type MetricStatus = "fresh" | "failed";

type ScrapeMode = "tiktok_profile" | "ig_details" | "ig_posts";

const SUCCEEDED_EVENT = "ACTOR.RUN.SUCCEEDED";
const TERMINAL_EVENT_TYPES = new Set([
  SUCCEEDED_EVENT,
  "ACTOR.RUN.FAILED",
  "ACTOR.RUN.TIMED_OUT",
  "ACTOR.RUN.ABORTED",
]);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

// Constant-time string compare. Lengths are compared first; when lengths
// differ we still iterate over the longer string to keep timing flat.
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  const len = Math.max(aBytes.length, bBytes.length);
  let diff = aBytes.length ^ bBytes.length;
  for (let i = 0; i < len; i++) {
    const ac = i < aBytes.length ? aBytes[i] : 0;
    const bc = i < bBytes.length ? bBytes[i] : 0;
    diff |= ac ^ bc;
  }
  return diff === 0;
}

function verifyWebhookSecret(req: Request): boolean {
  const provided = req.headers.get("x-apify-webhook-secret");
  if (!isNonEmptyString(provided)) return false;
  const current = Deno.env.get("APIFY_WEBHOOK_SECRET") ?? "";
  const previous = Deno.env.get("APIFY_WEBHOOK_SECRET_PREVIOUS") ?? "";
  if (!current && !previous) return false;
  // Both comparisons always run (no short-circuit) so an attacker who has
  // recovered `current` can't time-distinguish whether `previous` is set.
  const matchCurrent = current ? timingSafeEqual(provided, current) : false;
  const matchPrevious = previous ? timingSafeEqual(provided, previous) : false;
  return matchCurrent || matchPrevious;
}

function validResource(value: unknown): value is ApifyResource {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return (
    isNonEmptyString(r.id) &&
    isNonEmptyString(r.defaultDatasetId) &&
    isNonEmptyString(r.status) &&
    isNonEmptyString(r.actId)
  );
}

function meanPlayCount(items: TikTokItem[]): number | null {
  const slice = items.slice(0, 10);
  const views: number[] = [];
  for (const it of slice) {
    if (typeof it?.playCount === "number" && Number.isFinite(it.playCount)) {
      views.push(it.playCount);
    }
  }
  if (views.length === 0) return null;
  const sum = views.reduce((acc, n) => acc + n, 0);
  return Math.round(sum / views.length);
}

async function fetchDatasetItems(
  datasetId: string,
  apifyKey: string,
): Promise<unknown[]> {
  const url = new URL(`${APIFY_API_BASE}/datasets/${datasetId}/items`);
  url.searchParams.set("token", apifyKey);
  url.searchParams.set("clean", "1");
  const res = await fetch(url.toString(), { method: "GET" });
  if (!res.ok) {
    // Don't include res body — Apify can echo the token-carrying URL inside
    // error payloads, and this lands in edge-function logs.
    throw new Error(
      `Apify dataset '${datasetId}' fetch failed: ${res.status} ${res.statusText}`,
    );
  }
  const items = await res.json();
  if (!Array.isArray(items)) {
    throw new Error(`Apify dataset '${datasetId}' returned non-array payload`);
  }
  return items;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse(405, { error: "METHOD_NOT_ALLOWED" });
  }

  if (!verifyWebhookSecret(req)) {
    return jsonResponse(401, { error: "UNAUTHORIZED" });
  }

  let body: WebhookBody;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(400, { error: "INVALID_JSON" });
  }

  if (
    !isNonEmptyString(body.eventType) ||
    !TERMINAL_EVENT_TYPES.has(body.eventType) ||
    !validResource(body.resource) ||
    !isNonEmptyString(body.social_link_id) ||
    !isNonEmptyString(body.scrape_mode) ||
    !isNonEmptyString(body.run_id)
  ) {
    return jsonResponse(400, { error: "INVALID_REQUEST" });
  }

  const scrapeMode = body.scrape_mode as ScrapeMode;
  if (scrapeMode !== "tiktok_profile") {
    // ig_details / ig_posts are wired in US-017; return 200 so Apify does not
    // retry. The social_link_id is intentionally not logged here — the row
    // will still be stuck 'refreshing' until the fail-stuck-refreshing cron
    // janitor (docs/tech-architecture.md §15) flips it to 'failed'.
    return jsonResponse(200, { ok: true, skipped: "unsupported_scrape_mode" });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse(500, { error: "SERVER_MISCONFIGURED" });
  }

  const resource = body.resource as ApifyResource;
  const runId = body.run_id;
  const socialLinkId = body.social_link_id;
  const fetchedAt = isNonEmptyString(body.apify_finished_at)
    ? body.apify_finished_at
    : new Date().toISOString();

  let nextStatus: MetricStatus;
  let followerCount: number | null = null;
  let followingCount: number | null = null;
  let totalLikes: number | null = null;
  let videoCount: number | null = null;
  let avgViewsLast10: number | null = null;
  let isVerified: boolean | null = null;
  let rawPayload: unknown = null;
  let errorMessage: string | null = null;

  if (body.eventType === SUCCEEDED_EVENT) {
    const apifyKey = Deno.env.get("APIFY_KEY");
    if (!apifyKey) {
      return jsonResponse(500, { error: "SERVER_MISCONFIGURED" });
    }
    let items: unknown[];
    try {
      items = await fetchDatasetItems(resource.defaultDatasetId, apifyKey);
    } catch (err) {
      console.error("apify dataset fetch failed", {
        run_id: runId,
        dataset_id: resource.defaultDatasetId,
        error: err instanceof Error ? err.message : String(err),
      });
      return jsonResponse(500, { error: "APIFY_FETCH_ERROR" });
    }
    rawPayload = items;
    const tiktokItems = items as TikTokItem[];
    const first = tiktokItems[0];
    const authorMeta = first?.authorMeta;
    if (authorMeta) {
      followerCount = typeof authorMeta.fans === "number" ? authorMeta.fans : null;
      followingCount = typeof authorMeta.following === "number"
        ? authorMeta.following
        : null;
      totalLikes = typeof authorMeta.heart === "number" ? authorMeta.heart : null;
      videoCount = typeof authorMeta.video === "number" ? authorMeta.video : null;
      isVerified = typeof authorMeta.verified === "boolean"
        ? authorMeta.verified
        : null;
    }
    avgViewsLast10 = meanPlayCount(tiktokItems);
    nextStatus = "fresh";
  } else {
    nextStatus = "failed";
    errorMessage = `apify_${body.eventType.toLowerCase().replace(/\./g, "_")}`;
    rawPayload = { resource, eventType: body.eventType };
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await supabase.rpc(
    "apify_webhook_persist_tiktok_profile",
    {
      p_run_id: runId,
      p_social_link_id: socialLinkId,
      p_status: nextStatus,
      p_fetched_at: fetchedAt,
      p_follower_count: followerCount,
      p_following_count: followingCount,
      p_total_likes: totalLikes,
      p_video_count: videoCount,
      p_avg_views_last_10: avgViewsLast10,
      p_is_verified: isVerified,
      p_raw_payload: rawPayload as never,
      p_error_message: errorMessage,
    },
  );

  if (error) {
    console.error("apify_webhook_persist_tiktok_profile rpc error", {
      run_id: runId,
      code: error.code,
      message: error.message,
    });
    return jsonResponse(500, { error: "DB_ERROR" });
  }

  const result = data as {
    inserted?: boolean;
    duplicate?: boolean;
    snapshot_id?: string;
  } | null;

  return jsonResponse(200, {
    ok: true,
    inserted: result?.inserted === true,
    duplicate: result?.duplicate === true,
  });
});

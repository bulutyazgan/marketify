// Edge function: submit-video (US-045)
//
// Contract:
//   POST { application_id: string,
//          video_url: string,
//          post_condition_affirmations: { [condition_id: string]: boolean } }
//     → 200 { submission_id: string, platform: 'tiktok'|'instagram' }
//     → 400 { error: 'INVALID_JSON' | 'INVALID_REQUEST' }
//     → 401 { error: 'UNAUTHORIZED' }
//     → 403 { error: 'FORBIDDEN' }                       // non-creator role
//     → 403 { error: 'APPLICATION_NOT_APPROVED' }
//     → 404 { error: 'APPLICATION_NOT_FOUND' }
//     → 409 { error: 'SUBMISSION_EXISTS' }
//     → 422 { error: 'INVALID_VIDEO_URL' }
//     → 422 { error: 'INCOMPLETE_AFFIRMATIONS',
//             missing_condition_ids: string[] }
//     → 502 { error: 'OEMBED_UNAVAILABLE' }               // TikTok upstream
//     → 500 { error: 'SERVER_MISCONFIGURED' | 'DB_ERROR' }
//
// Auth: Marketify JWT (HS256, MARKETIFY_JWT_SECRET). Deployed with
//       verify_jwt=false at the gateway because the gateway only knows
//       about Supabase's own JWT secret — the handler enforces auth.
//
// Request shape — the US-045 story AC specifies `{ application_id,
// video_url, post_condition_affirmations }`. The tech-architecture spec
// §5.7 names a future-compatible `{ videos: [...] }` array shape; per
// the Ralph convention when story AC and spec disagree at the field
// level the story AC wins. The DB layer models multi-video via
// `submission_videos.sort_order` so expanding to an array later is a
// non-breaking change to this endpoint.
//
// URL validation (docs/tech-architecture.md §3h):
//   - TikTok canonical + shortlinks accepted; canonical gives us the
//     numeric `external_id`.
//   - TikTok oEmbed endpoint is called to prove the URL points at a
//     real, currently-resolvable post. A 404 from TikTok → 422
//     INVALID_VIDEO_URL. Network/5xx failures from TikTok → 500.
//   - Instagram URLs are validated by regex-shape only because IG
//     oEmbed requires an app-level Meta token that we do not currently
//     have provisioned. See `_shared/oembed.ts` header.
//
// Affirmation gate — the spec treats POST conditions (e.g.
// "must_mention", "family_friendly") as creator attestations at
// submit-time rather than machine-checkable facts. Every `post`-kind
// condition on the application's pinned listing_version_id must appear
// in `post_condition_affirmations` with a literal `true` value. Missing
// or `false` entries → 422 INCOMPLETE_AFFIRMATIONS with the offending
// ids so the client can re-surface them.
//
// Concurrency — the RPC acquires a row lock on the application
// (FOR UPDATE) so a duplicate submit interleaving with this one is
// serialised and the second request receives SUBMISSION_EXISTS. The
// partial unique index `submissions_open_uniq` is the DB backstop.

import { createClient } from "npm:@supabase/supabase-js@2";
import { verifyJwt } from "../_shared/jwt.ts";
import { corsHeaders } from "../_shared/cors.ts";
import {
  classifyVideoUrl,
  fetchTikTokOembed,
  type OembedResult,
} from "../_shared/oembed.ts";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Guard against a malicious client pasting a megabyte of URL. TikTok /
// Instagram share URLs cap well under 300 chars in the wild; 2048 is
// the de facto browser URL ceiling.
const VIDEO_URL_MAX_LEN = 2048;

interface SubmitVideoRequest {
  application_id?: unknown;
  video_url?: unknown;
  post_condition_affirmations?: unknown;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function bearerToken(req: Request): string | null {
  const raw = req.headers.get("Authorization") ??
    req.headers.get("authorization");
  if (!raw) return null;
  const m = raw.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

function parseAffirmations(
  raw: unknown,
): Record<string, boolean> | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const out: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "boolean") return null;
    out[key] = value;
  }
  return out;
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
  if (claims.role !== "creator") {
    return jsonResponse(403, { error: "FORBIDDEN" });
  }

  let body: SubmitVideoRequest;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(400, { error: "INVALID_JSON" });
  }

  const applicationId =
    typeof body.application_id === "string" && UUID_RE.test(body.application_id)
      ? body.application_id
      : null;
  if (!applicationId) {
    return jsonResponse(400, { error: "INVALID_REQUEST" });
  }

  if (
    typeof body.video_url !== "string" ||
    body.video_url.trim().length === 0 ||
    body.video_url.length > VIDEO_URL_MAX_LEN
  ) {
    return jsonResponse(400, { error: "INVALID_REQUEST" });
  }
  const videoUrl = body.video_url.trim();

  const affirmations = parseAffirmations(body.post_condition_affirmations);
  if (affirmations === null) {
    return jsonResponse(400, { error: "INVALID_REQUEST" });
  }

  const classification = classifyVideoUrl(videoUrl);
  if (!classification) {
    return jsonResponse(422, { error: "INVALID_VIDEO_URL" });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse(500, { error: "SERVER_MISCONFIGURED" });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: application, error: appError } = await supabase
    .from("applications")
    .select("id,creator_id,status,listing_version_id")
    .eq("id", applicationId)
    .maybeSingle();

  if (appError) {
    console.error("applications lookup failed", appError);
    return jsonResponse(500, { error: "DB_ERROR" });
  }
  if (!application || application.creator_id !== claims.sub) {
    return jsonResponse(404, { error: "APPLICATION_NOT_FOUND" });
  }
  if (application.status !== "approved") {
    return jsonResponse(403, { error: "APPLICATION_NOT_APPROVED" });
  }
  // The applications.listing_version_id column is NOT NULL, but we guard
  // explicitly so a future mis-migrated row doesn't silently skip the
  // post-condition gate below — an empty `listing_conditions` fetch
  // would otherwise flow through with no affirmations required.
  if (!application.listing_version_id) {
    console.error("application missing listing_version_id", applicationId);
    return jsonResponse(500, { error: "DB_ERROR" });
  }

  const { data: postConditions, error: condError } = await supabase
    .from("listing_conditions")
    .select("id")
    .eq("listing_version_id", application.listing_version_id)
    .eq("kind", "post");

  if (condError) {
    console.error("listing_conditions lookup failed", condError);
    return jsonResponse(500, { error: "DB_ERROR" });
  }

  const missing: string[] = [];
  for (const row of postConditions ?? []) {
    if (affirmations[row.id] !== true) missing.push(row.id);
  }
  if (missing.length > 0) {
    return jsonResponse(422, {
      error: "INCOMPLETE_AFFIRMATIONS",
      missing_condition_ids: missing,
    });
  }

  // oEmbed lives after the cheap checks — a TikTok network call on a
  // request that would 404/403/422 anyway is pure waste and exposes
  // rate-limit surface to unauthenticated noise.
  let oembed: OembedResult | null = null;
  if (classification.platform === "tiktok") {
    try {
      oembed = await fetchTikTokOembed(videoUrl);
    } catch (err) {
      // 502 (not 500) because the failure is upstream — TikTok oEmbed
      // is unreachable or returning 5xx. Distinguishing this from
      // DB_ERROR lets the client tell retryable-upstream-outage apart
      // from a bug in our own database path.
      console.error("TikTok oEmbed fetch error", err);
      return jsonResponse(502, { error: "OEMBED_UNAVAILABLE" });
    }
    if (!oembed) {
      return jsonResponse(422, { error: "INVALID_VIDEO_URL" });
    }
  }

  const { data: rpcData, error: rpcError } = await supabase.rpc(
    "submit_video_rpc",
    {
      p_application_id: applicationId,
      p_creator_id: claims.sub,
      p_video_url: videoUrl,
      p_platform: classification.platform,
      p_external_id: classification.externalId,
      p_oembed: oembed ? oembed.raw : null,
    },
  );

  if (rpcError) {
    console.error("submit_video_rpc error", rpcError);
    return jsonResponse(500, { error: "DB_ERROR" });
  }

  const result = rpcData as
    | { submission_id?: string; error?: string }
    | null;

  // TOCTOU note: the TS-side status check at line ~184 runs before the
  // RPC re-checks under FOR UPDATE. If the lister flips the application
  // from `approved` → something else between the two reads, the RPC
  // catches it here. The reverse (pending → approved mid-request) is
  // caught earlier by the TS check and short-circuits to 403, which is
  // accepted as a narrow user-visible glitch — removing the early check
  // would require an extra round-trip to surface clean non-approved
  // errors on the 99% path. Matches the apply-to-listing pattern.
  if (result?.error === "APPLICATION_NOT_FOUND") {
    return jsonResponse(404, { error: "APPLICATION_NOT_FOUND" });
  }
  if (result?.error === "APPLICATION_NOT_APPROVED") {
    return jsonResponse(403, { error: "APPLICATION_NOT_APPROVED" });
  }
  if (result?.error === "SUBMISSION_EXISTS") {
    return jsonResponse(409, { error: "SUBMISSION_EXISTS" });
  }

  if (!result?.submission_id) {
    console.error("submit_video_rpc returned unexpected shape", result);
    return jsonResponse(500, { error: "DB_ERROR" });
  }

  return jsonResponse(200, {
    submission_id: result.submission_id,
    platform: classification.platform,
  });
});

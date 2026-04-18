// Edge function: apply-to-listing (US-041)
//
// Contract:
//   POST { listing_id: string, cover_note?: string }
//     → 200 { application_id: string, listing_version_id: string }
//     → 400 { error: 'INVALID_JSON' | 'INVALID_REQUEST' }
//     → 401 { error: 'UNAUTHORIZED' }
//     → 403 { error: 'FORBIDDEN' }                      // non-creator role
//     → 403 { error: 'INELIGIBLE',
//             failed_conditions: Array<{metric, platform, required, actual}> }
//     → 404 { error: 'LISTING_NOT_FOUND' }              // also covers draft/archived
//     → 409 { error: 'LISTING_NOT_ACTIVE' }
//     → 409 { error: 'LISTING_VERSION_CHANGED',
//             current_version_id: string }
//     → 409 { error: 'ALREADY_APPLIED' }
//     → 500 { error: 'SERVER_MISCONFIGURED' | 'DB_ERROR' }
//
// Auth: Marketify JWT (HS256, MARKETIFY_JWT_SECRET). Verifies via
//       _shared/jwt.ts and asserts role='creator'. Deployed with
//       verify_jwt=false at the gateway because the gateway only knows
//       about Supabase's own JWT secret — the handler enforces auth.
//
// Request shape — canonical per docs/tech-architecture.md §5.5
// (Req: `{ listing_id, cover_note? }`). The US-041 story AC names the
// optional field `pitch`; the spec name `cover_note` wins per the Ralph
// iteration rules and also matches the `public.applications.cover_note`
// column.
//
// Concurrency — we re-run eligibility in TS against the current version
// of the listing, then hand the same `expected_version_id` to the
// `public.apply_to_listing_rpc` RPC, which re-reads the listing under a
// row-level lock (SELECT ... FOR UPDATE). If the lister's version bump
// interleaves, the RPC sees a different current_version_id and returns
// LISTING_VERSION_CHANGED. This satisfies the §5.5 "re-run eligibility
// against the NOW-current version_id" invariant without duplicating the
// eligibility engine in PL/pgSQL. Spec §5.5 also enumerates
// LISTING_NOT_ACTIVE and ALREADY_APPLIED, both surfaced here.
//
// Fail-closed on missing metrics — inherited from the shared eligibility
// engine (docs/tech-architecture.md §3d): missing creator_profiles row,
// null platform fields, or unknown operators on a PRE condition all
// count as ineligible.

import { createClient } from "npm:@supabase/supabase-js@2";
import { verifyJwt } from "../_shared/jwt.ts";
import { corsHeaders } from "../_shared/cors.ts";
import {
  type ConditionRow,
  type CreatorProfileRow,
  EMPTY_CREATOR_METRICS,
  evaluatePreConditions,
} from "../_shared/eligibility.ts";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Hard cap on cover_note — the schema column is `text` (unlimited), but
// anything longer than a few paragraphs is almost certainly abuse or
// accidental paste. 2000 chars = roughly 400 words, plenty for a pitch.
const COVER_NOTE_MAX_LEN = 2000;

interface ApplyRequest {
  listing_id?: unknown;
  cover_note?: unknown;
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

  let body: ApplyRequest;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(400, { error: "INVALID_JSON" });
  }

  const listingId =
    typeof body.listing_id === "string" && UUID_RE.test(body.listing_id)
      ? body.listing_id
      : null;
  if (!listingId) {
    return jsonResponse(400, { error: "INVALID_REQUEST" });
  }

  let coverNote: string | null = null;
  if (body.cover_note !== undefined && body.cover_note !== null) {
    if (typeof body.cover_note !== "string") {
      return jsonResponse(400, { error: "INVALID_REQUEST" });
    }
    const trimmed = body.cover_note.trim();
    if (trimmed.length > COVER_NOTE_MAX_LEN) {
      return jsonResponse(400, { error: "INVALID_REQUEST" });
    }
    coverNote = trimmed.length > 0 ? trimmed : null;
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse(500, { error: "SERVER_MISCONFIGURED" });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: listing, error: listingError } = await supabase
    .from("listings")
    .select("id,status,current_version_id")
    .eq("id", listingId)
    .maybeSingle();

  if (listingError) {
    console.error("listings lookup failed", listingError);
    return jsonResponse(500, { error: "DB_ERROR" });
  }
  // Draft and archived collapse to 404 to match get-listing-detail's
  // visibility rules — there's nothing to apply to and we don't want to
  // leak id existence.
  if (!listing || listing.status === "draft" || listing.status === "archived") {
    return jsonResponse(404, { error: "LISTING_NOT_FOUND" });
  }
  // Non-active (paused / closed) listings are a 409 per §5.5. They are
  // visible for detail view but not applyable.
  if (listing.status !== "active") {
    return jsonResponse(409, { error: "LISTING_NOT_ACTIVE" });
  }

  const versionId = listing.current_version_id as string | null;
  if (!versionId) {
    console.error("listing missing current_version_id", listing.id);
    return jsonResponse(500, { error: "DB_ERROR" });
  }

  const [conditionsRes, profileRes] = await Promise.all([
    supabase
      .from("listing_conditions")
      .select("*")
      .eq("listing_version_id", versionId),
    supabase
      .from("creator_profiles")
      .select(
        "tiktok_follower_count,tiktok_avg_views_last_10,tiktok_total_likes," +
          "tiktok_video_count,tiktok_is_verified,instagram_follower_count," +
          "instagram_avg_views_last_10,instagram_media_count",
      )
      .eq("user_id", claims.sub)
      .maybeSingle(),
  ]);

  if (conditionsRes.error) {
    console.error("listing_conditions lookup failed", conditionsRes.error);
    return jsonResponse(500, { error: "DB_ERROR" });
  }
  if (profileRes.error) {
    console.error("creator_profiles lookup failed", profileRes.error);
    return jsonResponse(500, { error: "DB_ERROR" });
  }

  const conditions = (conditionsRes.data ?? []) as ConditionRow[];
  const metrics: CreatorProfileRow = profileRes.data ?? EMPTY_CREATOR_METRICS;
  const failed = evaluatePreConditions(conditions, metrics);
  if (failed.length > 0) {
    return jsonResponse(403, {
      error: "INELIGIBLE",
      failed_conditions: failed,
    });
  }

  const { data: rpcData, error: rpcError } = await supabase.rpc(
    "apply_to_listing_rpc",
    {
      p_listing_id: listingId,
      p_creator_id: claims.sub,
      p_expected_version_id: versionId,
      p_cover_note: coverNote,
    },
  );

  if (rpcError) {
    console.error("apply_to_listing_rpc error", rpcError);
    return jsonResponse(500, { error: "DB_ERROR" });
  }

  const result = rpcData as
    | {
      application_id?: string;
      listing_version_id?: string;
      error?: string;
      current_version_id?: string;
    }
    | null;

  if (result?.error === "LISTING_NOT_FOUND") {
    return jsonResponse(404, { error: "LISTING_NOT_FOUND" });
  }
  if (result?.error === "LISTING_NOT_ACTIVE") {
    return jsonResponse(409, { error: "LISTING_NOT_ACTIVE" });
  }
  if (result?.error === "LISTING_VERSION_CHANGED") {
    return jsonResponse(409, {
      error: "LISTING_VERSION_CHANGED",
      current_version_id: result.current_version_id,
    });
  }
  if (result?.error === "ALREADY_APPLIED") {
    return jsonResponse(409, { error: "ALREADY_APPLIED" });
  }

  if (!result?.application_id || !result.listing_version_id) {
    console.error("apply_to_listing_rpc returned unexpected shape", result);
    return jsonResponse(500, { error: "DB_ERROR" });
  }

  return jsonResponse(200, {
    application_id: result.application_id,
    listing_version_id: result.listing_version_id,
  });
});

// Edge function: decide-application (US-057)
//
// Contract:
//   POST { application_id: string,
//          action: 'approve' | 'reject',
//          decision_note?: string,
//          override_ineligible?: boolean }
//     → 200 { ok: true, status: 'approved' | 'rejected', decided_at: string }
//     → 200 { ok: false, drift: Array<{metric, platform, required, actual}> }
//             // approve path only — creator no longer meets pre-conditions;
//             // client opens the override confirmation dialog.
//     → 400 { error: 'INVALID_JSON' | 'INVALID_REQUEST' }
//     → 401 { error: 'UNAUTHORIZED' }
//     → 403 { error: 'FORBIDDEN' }                    // non-lister role
//     → 404 { error: 'APPLICATION_NOT_FOUND' }
//     → 403 { error: 'NOT_OWNER' }                    // not this lister's listing
//     → 409 { error: 'NOT_PENDING' }                  // already decided / withdrawn / cancelled
//     → 409 { error: 'LISTING_VERSION_CHANGED',
//             current_version_id: string }            // version raced; client re-opens
//     → 500 { error: 'SERVER_MISCONFIGURED' | 'DB_ERROR' }
//
// Auth: Marketify JWT (HS256, MARKETIFY_JWT_SECRET). Verifies via
//       _shared/jwt.ts and asserts role='lister'. Deployed with
//       verify_jwt=false at the gateway because the gateway only knows
//       about Supabase's own JWT secret — the handler enforces auth.
//
// Concurrency / version pin — same pattern as US-041's apply-to-listing
// (Codebase Pattern #105). For a non-override approve, we re-run pre-
// conditions in TS against the listing's CURRENT current_version_id, then
// hand that version to the RPC as `p_expected_version_id`. The RPC takes
// SELECT ... FOR UPDATE on the application row and re-reads
// listings.current_version_id — if a fresh `app_private.bump_listing_version`
// interleaved, the RPC returns LISTING_VERSION_CHANGED and the client
// reloads the review sheet.
//
// Override path (§4.6 OverrideEligibilityDialog) — when
// `override_ineligible=true`, we skip eligibility AND skip the version pin.
// Override is a deliberate force-approve: the lister has accepted the
// drift, so a freshly bumped version doesn't change their decision. We
// pass `p_expected_version_id=null` to the RPC.
//
// Drift response shape — `{ok:false, drift:[...]}` is intentionally NOT
// an HTTP error. The approve action succeeded "as a check"; the client
// uses the returned drift to render the override confirmation dialog and
// re-POST with `override_ineligible:true`. Per US-057 AC: "approve runs
// a NEW edge function ... returns {ok:true} or {ok:false, drift:string[]}".
// We return rich `FailedCondition` objects (same shape as apply-to-listing's
// `failed_conditions`) rather than opaque strings so the dialog can render
// "min_followers (tiktok): need 10000, have 7400" instead of a bare string.
//
// Reject path — never re-runs eligibility, never checks the version pin
// (rejecting a no-longer-eligible creator is always allowed and not a
// drift signal). `decision_note` is optional but persisted.

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

// Same cap as apply-to-listing's cover_note. decision_note is the lister-
// authored explanation surfaced in notifications + applications row history.
const DECISION_NOTE_MAX_LEN = 2000;

interface DecideRequest {
  application_id?: unknown;
  action?: unknown;
  decision_note?: unknown;
  override_ineligible?: unknown;
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
  if (claims.app_role !== "lister") {
    return jsonResponse(403, { error: "FORBIDDEN" });
  }

  let body: DecideRequest;
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

  const action = body.action === "approve" || body.action === "reject"
    ? body.action
    : null;
  if (!action) {
    return jsonResponse(400, { error: "INVALID_REQUEST" });
  }

  const overrideIneligible = body.override_ineligible === true;
  // Override is meaningless on a reject — silently ignore rather than 400
  // so a UI that always sets it can't accidentally lock out a reject.
  const effectiveOverride = action === "approve" && overrideIneligible;

  let decisionNote: string | null = null;
  if (body.decision_note !== undefined && body.decision_note !== null) {
    if (typeof body.decision_note !== "string") {
      return jsonResponse(400, { error: "INVALID_REQUEST" });
    }
    const trimmed = body.decision_note.trim();
    if (trimmed.length > DECISION_NOTE_MAX_LEN) {
      return jsonResponse(400, { error: "INVALID_REQUEST" });
    }
    decisionNote = trimmed.length > 0 ? trimmed : null;
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse(500, { error: "SERVER_MISCONFIGURED" });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Fetch the application + its listing in one round trip so we can check
  // ownership, current status, and resolve the listing's version BEFORE
  // running eligibility. We re-check all of this inside the RPC under a
  // row lock — these client-side checks are for early-return and to know
  // which version to evaluate against.
  const { data: appRow, error: appErr } = await supabase
    .from("applications")
    .select("id,status,creator_id,listing_id")
    .eq("id", applicationId)
    .maybeSingle();

  if (appErr) {
    console.error("applications lookup failed", appErr);
    return jsonResponse(500, { error: "DB_ERROR" });
  }
  if (!appRow) {
    return jsonResponse(404, { error: "APPLICATION_NOT_FOUND" });
  }
  if (appRow.status !== "pending") {
    return jsonResponse(409, { error: "NOT_PENDING" });
  }

  const { data: listing, error: listingErr } = await supabase
    .from("listings")
    .select("id,lister_id,current_version_id")
    .eq("id", appRow.listing_id)
    .maybeSingle();

  if (listingErr) {
    console.error("listings lookup failed", listingErr);
    return jsonResponse(500, { error: "DB_ERROR" });
  }
  if (!listing) {
    // Listing FK is on delete restrict so this should be unreachable.
    return jsonResponse(500, { error: "DB_ERROR" });
  }
  if (listing.lister_id !== claims.sub) {
    return jsonResponse(403, { error: "NOT_OWNER" });
  }

  const versionId = listing.current_version_id as string | null;
  if (!versionId) {
    console.error("listing missing current_version_id", listing.id);
    return jsonResponse(500, { error: "DB_ERROR" });
  }

  // Approve path eligibility re-check. Skipped on override (§4.6) and on
  // reject (rejecting an ineligible creator is always allowed).
  if (action === "approve" && !effectiveOverride) {
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
        .eq("user_id", appRow.creator_id)
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
    const drift = evaluatePreConditions(conditions, metrics);
    if (drift.length > 0) {
      // ok:false signals the client to render the override confirmation
      // dialog. This is NOT an HTTP error — the request itself succeeded
      // as a pre-flight eligibility probe.
      return jsonResponse(200, { ok: false, drift });
    }
  }

  const { data: rpcData, error: rpcError } = await supabase.rpc(
    "decide_application_rpc",
    {
      p_application_id: applicationId,
      p_lister_id: claims.sub,
      p_action: action,
      p_decision_note: decisionNote,
      // Reject and override paths skip the pin (null = "don't check version").
      p_expected_version_id: action === "approve" && !effectiveOverride
        ? versionId
        : null,
    },
  );

  if (rpcError) {
    console.error("decide_application_rpc error", rpcError);
    return jsonResponse(500, { error: "DB_ERROR" });
  }

  const result = rpcData as
    | {
      ok?: boolean;
      status?: string;
      decided_at?: string;
      error?: string;
      current_version_id?: string;
    }
    | null;

  if (result?.error === "APPLICATION_NOT_FOUND") {
    return jsonResponse(404, { error: "APPLICATION_NOT_FOUND" });
  }
  if (result?.error === "NOT_OWNER") {
    return jsonResponse(403, { error: "NOT_OWNER" });
  }
  if (result?.error === "NOT_PENDING") {
    return jsonResponse(409, { error: "NOT_PENDING" });
  }
  if (result?.error === "INVALID_ACTION") {
    return jsonResponse(400, { error: "INVALID_REQUEST" });
  }
  if (result?.error === "LISTING_VERSION_CHANGED") {
    return jsonResponse(409, {
      error: "LISTING_VERSION_CHANGED",
      current_version_id: result.current_version_id,
    });
  }

  if (!result?.ok || !result.status || !result.decided_at) {
    console.error("decide_application_rpc returned unexpected shape", result);
    return jsonResponse(500, { error: "DB_ERROR" });
  }

  return jsonResponse(200, {
    ok: true,
    status: result.status,
    decided_at: result.decided_at,
  });
});

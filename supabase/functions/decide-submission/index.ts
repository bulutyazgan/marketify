// Edge function: decide-submission (US-059)
//
// Contract:
//   POST { submission_id: string,
//          action: 'approve' | 'reject',
//          decision_note?: string,
//          override_ineligible?: boolean,
//          override_reason?: string }
//     → 200 { ok: true, status: 'approved' | 'rejected', decided_at: string }
//     → 400 { error: 'INVALID_JSON' | 'INVALID_REQUEST'
//                  | 'OVERRIDE_REASON_REQUIRED' }
//     → 401 { error: 'UNAUTHORIZED' }
//     → 403 { error: 'FORBIDDEN' }                    // non-lister role
//     → 404 { error: 'SUBMISSION_NOT_FOUND' }
//     → 403 { error: 'NOT_OWNER' }                    // not this lister's listing
//     → 409 { error: 'NOT_PENDING' }                  // already decided
//     → 500 { error: 'SERVER_MISCONFIGURED' | 'DB_ERROR' }
//
// Auth: Marketify JWT (HS256, MARKETIFY_JWT_SECRET). Same shape as
//       decide-application — the gateway accepts the token because
//       MARKETIFY_JWT_SECRET equals the project's PostgREST jwt_secret;
//       the handler additionally enforces app_role === 'lister'.
//
// Differences from decide-application (US-057):
// - No eligibility re-check. The submission review screen renders the
//   listing's POST-conditions, which the lister mentally evaluates and
//   ticks (§4.6 ConditionChecklist mode='review'). When the lister
//   decides any rows are failing AND still wants to approve, the client
//   sends override_ineligible=true + override_reason=<typed text>. We
//   trust the client's evaluation (the rules are subjective: "did the
//   creator say cruelty-free?" can't be machine-checked) and persist the
//   override audit fields.
// - No version pin. Submissions inherit their pinned listing_version_id
//   from their parent application — there's no version-changed race for
//   the lister review. (Spec gap: §4.7 doesn't carry a version pin on
//   submissions; the migration header for us_059_decide_submission_rpc
//   spells out the rationale.)
//
// Override path (§4.6 OverrideEligibilityDialog) — when
// override_ineligible=true we require a non-empty override_reason. The
// RPC mirrors the same invariant (returns OVERRIDE_REASON_REQUIRED),
// but we bounce the request at the edge for a faster 400 and to keep
// the validation closer to the client.

import { createClient } from "npm:@supabase/supabase-js@2";
import { verifyJwt } from "../_shared/jwt.ts";
import { corsHeaders } from "../_shared/cors.ts";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Same cap as decide-application's decision_note. The screen UX caps
// feedback text at 240 chars (§4.6) but we accept up to 2000 server-side
// to leave headroom and stay in lockstep with decide-application's
// matching field (Codebase Pattern #144 — 280-client / 2000-server cap
// split rationale).
const DECISION_NOTE_MAX_LEN = 2000;
// Override reason is a deliberate-friction field; the dialog UI shows a
// single-line input. 500 chars is generous for "what they typed" while
// still bounding payload size.
const OVERRIDE_REASON_MAX_LEN = 500;

interface DecideRequest {
  submission_id?: unknown;
  action?: unknown;
  decision_note?: unknown;
  override_ineligible?: unknown;
  override_reason?: unknown;
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

  const submissionId =
    typeof body.submission_id === "string" && UUID_RE.test(body.submission_id)
      ? body.submission_id
      : null;
  if (!submissionId) {
    return jsonResponse(400, { error: "INVALID_REQUEST" });
  }

  const action = body.action === "approve" || body.action === "reject"
    ? body.action
    : null;
  if (!action) {
    return jsonResponse(400, { error: "INVALID_REQUEST" });
  }

  const overrideIneligible = body.override_ineligible === true;
  // Override only matters on approve. Mirror decide-application's silent
  // collapse so a UI that always sets the flag can't lock out a reject.
  const effectiveOverride = action === "approve" && overrideIneligible;

  let overrideReason: string | null = null;
  if (effectiveOverride) {
    if (typeof body.override_reason !== "string") {
      return jsonResponse(400, { error: "OVERRIDE_REASON_REQUIRED" });
    }
    const trimmed = body.override_reason.trim();
    if (trimmed.length === 0) {
      return jsonResponse(400, { error: "OVERRIDE_REASON_REQUIRED" });
    }
    if (trimmed.length > OVERRIDE_REASON_MAX_LEN) {
      return jsonResponse(400, { error: "INVALID_REQUEST" });
    }
    overrideReason = trimmed;
  }

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

  // Pre-flight ownership check for fast 404 / 403 / 409 — the RPC
  // re-checks all of this under FOR UPDATE, but doing it here means we
  // surface clean error codes without parsing the RPC's jsonb shape for
  // every error.
  const { data: subRow, error: subErr } = await supabase
    .from("submissions")
    .select("id,status,application_id")
    .eq("id", submissionId)
    .maybeSingle();

  if (subErr) {
    console.error("submissions lookup failed", subErr);
    return jsonResponse(500, { error: "DB_ERROR" });
  }
  if (!subRow) {
    return jsonResponse(404, { error: "SUBMISSION_NOT_FOUND" });
  }
  if (subRow.status !== "pending") {
    return jsonResponse(409, { error: "NOT_PENDING" });
  }

  const { data: appRow, error: appErr } = await supabase
    .from("applications")
    .select("id,listing_id")
    .eq("id", subRow.application_id)
    .maybeSingle();

  if (appErr) {
    console.error("applications lookup failed", appErr);
    return jsonResponse(500, { error: "DB_ERROR" });
  }
  if (!appRow) {
    // FK is on delete restrict so this should be unreachable.
    return jsonResponse(500, { error: "DB_ERROR" });
  }

  const { data: listing, error: listingErr } = await supabase
    .from("listings")
    .select("id,lister_id")
    .eq("id", appRow.listing_id)
    .maybeSingle();

  if (listingErr) {
    console.error("listings lookup failed", listingErr);
    return jsonResponse(500, { error: "DB_ERROR" });
  }
  if (!listing) {
    return jsonResponse(500, { error: "DB_ERROR" });
  }
  if (listing.lister_id !== claims.sub) {
    return jsonResponse(403, { error: "NOT_OWNER" });
  }

  const { data: rpcData, error: rpcError } = await supabase.rpc(
    "decide_submission_rpc",
    {
      p_submission_id: submissionId,
      p_lister_id: claims.sub,
      p_action: action,
      p_decision_note: decisionNote,
      p_override: effectiveOverride,
      p_override_reason: overrideReason,
    },
  );

  if (rpcError) {
    console.error("decide_submission_rpc error", rpcError);
    return jsonResponse(500, { error: "DB_ERROR" });
  }

  const result = rpcData as
    | {
      ok?: boolean;
      status?: string;
      decided_at?: string;
      error?: string;
    }
    | null;

  if (result?.error === "SUBMISSION_NOT_FOUND") {
    return jsonResponse(404, { error: "SUBMISSION_NOT_FOUND" });
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
  if (result?.error === "OVERRIDE_REASON_REQUIRED") {
    return jsonResponse(400, { error: "OVERRIDE_REASON_REQUIRED" });
  }

  if (!result?.ok || !result.status || !result.decided_at) {
    console.error("decide_submission_rpc returned unexpected shape", result);
    return jsonResponse(500, { error: "DB_ERROR" });
  }

  return jsonResponse(200, {
    ok: true,
    status: result.status,
    decided_at: result.decided_at,
  });
});

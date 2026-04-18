// Edge function: update-listing-samples (US-055b)
//
// Contract:
//   POST {
//     listing_id: string (uuid),
//     urls:       string[]                    // each must classify as tiktok|instagram
//                                             // (whitespace-only entries are dropped),
//     confirm_cascade?: boolean (default false) // when sample_videos change AND
//                                             // pending applications > 0, the
//                                             // server returns 200 with
//                                             // needs_confirmation:true unless
//                                             // this flag is true.
//   }
//     → 200 { changed: false }
//     → 200 { changed: true, needs_confirmation: true, pending_count: number }
//     → 200 { changed: true, new_version_id: string, cancelled_pending_count: number }
//     → 400 { error: 'INVALID_JSON' | 'INVALID_REQUEST', field?: string }
//     → 401 { error: 'UNAUTHORIZED' }
//     → 403 { error: 'FORBIDDEN' }                // non-lister role OR not the listing's owner
//     → 404 { error: 'LISTING_NOT_FOUND' }
//     → 409 { error: 'INVALID_STATUS' }           // listing is draft/archived
//     → 500 { error: 'SERVER_MISCONFIGURED' | 'DB_ERROR' }
//
// Auth: Marketify HS256 JWT (MARKETIFY_JWT_SECRET), app_role must be 'lister'.
//       Gateway `verify_jwt` is disabled because Supabase-issued JWTs aren't
//       the same namespace — the handler enforces auth via _shared/jwt.ts.
//
// See US-055b progress entry for the rationale: sample-video edits version-
// bump the listing via the cascade trigger (us_010), and RLS only grants
// READ on sample_videos to listers, so the flow has to live server-side.

import { createClient } from "npm:@supabase/supabase-js@2";
import { verifyJwt } from "../_shared/jwt.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { classifyVideoUrl } from "../_shared/oembed.ts";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAMPLE_URLS_MAX = 10;

interface RawRequest {
  listing_id?: unknown;
  urls?: unknown;
  confirm_cascade?: unknown;
}

interface NormalizedSample {
  platform: "tiktok" | "instagram";
  url: string;
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

function validate(body: RawRequest):
  | { ok: true; listingId: string; samples: NormalizedSample[]; confirm: boolean }
  | { ok: false; field: string } {
  if (typeof body.listing_id !== "string" || !UUID_RE.test(body.listing_id)) {
    return { ok: false, field: "listing_id" };
  }
  if (!Array.isArray(body.urls)) {
    return { ok: false, field: "urls" };
  }
  if (body.urls.length > SAMPLE_URLS_MAX) {
    return { ok: false, field: "urls" };
  }
  const samples: NormalizedSample[] = [];
  for (const rawUrl of body.urls) {
    if (typeof rawUrl !== "string") {
      return { ok: false, field: "urls" };
    }
    const trimmed = rawUrl.trim();
    if (trimmed.length === 0) continue;
    const classification = classifyVideoUrl(trimmed);
    if (!classification) {
      return { ok: false, field: "urls" };
    }
    samples.push({ platform: classification.platform, url: trimmed });
  }
  let confirm = false;
  if (body.confirm_cascade !== undefined) {
    if (typeof body.confirm_cascade !== "boolean") {
      return { ok: false, field: "confirm_cascade" };
    }
    confirm = body.confirm_cascade;
  }
  return { ok: true, listingId: body.listing_id, samples, confirm };
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

  let raw: RawRequest;
  try {
    raw = await req.json();
  } catch {
    return jsonResponse(400, { error: "INVALID_JSON" });
  }

  const result = validate(raw);
  if (!result.ok) {
    return jsonResponse(400, { error: "INVALID_REQUEST", field: result.field });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse(500, { error: "SERVER_MISCONFIGURED" });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: rpcData, error: rpcError } = await supabase.rpc(
    "update_listing_samples_rpc",
    {
      p_lister_id: claims.sub,
      p_listing_id: result.listingId,
      p_samples: result.samples as unknown as Record<string, unknown>[],
      p_confirm_cascade: result.confirm,
    },
  );

  if (rpcError) {
    const msg = rpcError.message ?? "";
    if (msg.includes("NOT_FOUND")) {
      return jsonResponse(404, { error: "LISTING_NOT_FOUND" });
    }
    if (msg.includes("FORBIDDEN")) {
      return jsonResponse(403, { error: "FORBIDDEN" });
    }
    if (msg.includes("INVALID_STATUS")) {
      return jsonResponse(409, { error: "INVALID_STATUS" });
    }
    console.error("update_listing_samples_rpc error", rpcError);
    return jsonResponse(500, { error: "DB_ERROR" });
  }

  const shaped = rpcData as
    | {
        changed?: boolean;
        needs_confirmation?: boolean;
        pending_count?: number;
        new_version_id?: string;
        cancelled_pending_count?: number;
      }
    | null;

  if (!shaped || typeof shaped.changed !== "boolean") {
    console.error("update_listing_samples_rpc returned unexpected shape", rpcData);
    return jsonResponse(500, { error: "DB_ERROR" });
  }

  if (!shaped.changed) {
    return jsonResponse(200, { changed: false });
  }
  if (shaped.needs_confirmation === true) {
    return jsonResponse(200, {
      changed: true,
      needs_confirmation: true,
      pending_count: shaped.pending_count ?? 0,
    });
  }
  if (typeof shaped.new_version_id !== "string") {
    console.error("update_listing_samples_rpc commit shape missing new_version_id", rpcData);
    return jsonResponse(500, { error: "DB_ERROR" });
  }
  return jsonResponse(200, {
    changed: true,
    new_version_id: shaped.new_version_id,
    cancelled_pending_count: shaped.cancelled_pending_count ?? 0,
  });
});

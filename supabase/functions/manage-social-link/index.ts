// Edge function: manage-social-link (US-035)
//
// Contract:
//   POST add:    { action: 'add', platform: 'tiktok'|'instagram', handle: string }
//     → 200 { social_link_id: string }
//   POST unlink: { action: 'unlink', social_link_id: string }
//     → 200 { ok: true }
//     → 400 { error: 'INVALID_JSON' | 'INVALID_REQUEST' }
//     → 401 { error: 'UNAUTHORIZED' }
//     → 403 { error: 'FORBIDDEN' }
//     → 404 { error: 'LINK_NOT_FOUND' }
//     → 409 { error: 'ALREADY_LINKED' | 'HANDLE_TAKEN' }
//     → 500 { error: 'SERVER_MISCONFIGURED' | 'DB_ERROR' }
//
// Auth: Marketify JWT (HS256, MARKETIFY_JWT_SECRET). Verifies via
//       _shared/jwt.ts and asserts role='creator'. Deployed with
//       verify_jwt=false at the gateway; the handler enforces auth.
//
// Atomicity: single INSERT (add) or single UPDATE (unlink) inside the
// public.manage_social_link RPC's implicit transaction.
//
// Scope: this function does NOT kick Apify scrapes on add. Pulling metrics
// for a freshly-added handle is the job of US-036 (pull-to-refresh on
// Profile) — a pattern identical to metrics-refresh. Keeping scope tight
// here matches the story AC ("Add Handle / Unlink Handle actions wired to
// a small edge function").

import { createClient } from "npm:@supabase/supabase-js@2";
import { verifyJwt } from "../_shared/jwt.ts";
import { corsHeaders } from "../_shared/cors.ts";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HANDLE_RE = /^[a-zA-Z0-9_.]{1,30}$/;

type Platform = "tiktok" | "instagram";

interface AddRequest {
  action?: "add";
  platform?: unknown;
  handle?: unknown;
}
interface UnlinkRequest {
  action?: "unlink";
  social_link_id?: unknown;
}
type AnyRequest = AddRequest | UnlinkRequest | { action?: unknown };

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

function normalizeHandle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const stripped = value.trim().replace(/^@+/, "").trim();
  if (stripped.length === 0 || !HANDLE_RE.test(stripped)) return null;
  return stripped;
}

function parsePlatform(value: unknown): Platform | null {
  return value === "tiktok" || value === "instagram" ? value : null;
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

  let body: AnyRequest;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(400, { error: "INVALID_JSON" });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse(500, { error: "SERVER_MISCONFIGURED" });
  }
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  if (body.action === "add") {
    const platform = parsePlatform((body as AddRequest).platform);
    const handle = normalizeHandle((body as AddRequest).handle);
    if (!platform || !handle) {
      return jsonResponse(400, { error: "INVALID_REQUEST" });
    }
    const { data, error } = await supabase.rpc("manage_social_link", {
      p_user_id: claims.sub,
      p_action: "add",
      p_platform: platform,
      p_handle: handle,
      p_social_link_id: null,
    });
    if (error) {
      console.error("manage_social_link add rpc error", error);
      return jsonResponse(500, { error: "DB_ERROR" });
    }
    const result = data as
      | { social_link_id?: string; error?: string }
      | null;
    if (result?.error === "ALREADY_LINKED") {
      return jsonResponse(409, { error: "ALREADY_LINKED" });
    }
    if (result?.error === "HANDLE_TAKEN") {
      return jsonResponse(409, { error: "HANDLE_TAKEN" });
    }
    if (result?.error === "INVALID_REQUEST") {
      return jsonResponse(400, { error: "INVALID_REQUEST" });
    }
    if (!result?.social_link_id) {
      console.error("manage_social_link add returned unexpected shape", result);
      return jsonResponse(500, { error: "DB_ERROR" });
    }
    return jsonResponse(200, { social_link_id: result.social_link_id });
  }

  if (body.action === "unlink") {
    const socialLinkId =
      typeof (body as UnlinkRequest).social_link_id === "string" &&
        UUID_RE.test((body as UnlinkRequest).social_link_id as string)
        ? ((body as UnlinkRequest).social_link_id as string)
        : null;
    if (!socialLinkId) {
      return jsonResponse(400, { error: "INVALID_REQUEST" });
    }
    const { data, error } = await supabase.rpc("manage_social_link", {
      p_user_id: claims.sub,
      p_action: "unlink",
      p_platform: null,
      p_handle: null,
      p_social_link_id: socialLinkId,
    });
    if (error) {
      console.error("manage_social_link unlink rpc error", error);
      return jsonResponse(500, { error: "DB_ERROR" });
    }
    const result = data as { ok?: boolean; error?: string } | null;
    if (result?.error === "LINK_NOT_FOUND") {
      return jsonResponse(404, { error: "LINK_NOT_FOUND" });
    }
    if (result?.error === "INVALID_REQUEST") {
      return jsonResponse(400, { error: "INVALID_REQUEST" });
    }
    if (!result?.ok) {
      console.error(
        "manage_social_link unlink returned unexpected shape",
        result,
      );
      return jsonResponse(500, { error: "DB_ERROR" });
    }
    return jsonResponse(200, { ok: true });
  }

  return jsonResponse(400, { error: "INVALID_REQUEST" });
});

// Edge function: auth-signup-creator (US-019)
//
// Contract:
//   POST { username: string, tiktok_handle?: string, instagram_handle?: string }
//     → 200 { token: string, user_id: string, role: 'creator' }
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
//
// Handle normalization: leading '@' is stripped and whitespace trimmed
// before the RPC call. Handles are compared case-insensitively (citext),
// matching social_links.handle's column type.
//
// Scope: this function only records the handles. Kicking the Apify
// scrapes is deferred to US-020, which will wrap this handler.
//
// Rate limit: not implemented yet. Spec §5.1 requires per-IP throttling
// via a signup_attempts table (does not yet exist). Same status as the
// sibling auth-signup-lister — tracked in progress.txt Codebase Patterns.

import { createClient } from "npm:@supabase/supabase-js@2";
import { signJwt } from "../_shared/jwt.ts";
import { corsHeaders } from "../_shared/cors.ts";

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

  return jsonResponse(200, { token, user_id: userId, role: "creator" });
});

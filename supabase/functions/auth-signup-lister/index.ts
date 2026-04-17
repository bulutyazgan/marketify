// Edge function: auth-signup-lister (US-014)
//
// Contract:
//   POST { username: string, email: string, org_name: string, website_url?: string }
//     → 200 { token: string, user_id: string, role: 'lister' }
//     → 400 { error: 'INVALID_REQUEST' | 'INVALID_JSON' }
//     → 409 { error: 'USERNAME_TAKEN' | 'EMAIL_TAKEN' }
//     → 500 { error: 'SERVER_MISCONFIGURED' | 'DB_ERROR' | 'JWT_ERROR' }
//
// Auth: none. This is how a lister obtains their first JWT, so the endpoint
// is verify_jwt=false at the gateway. The handler itself mints the token via
// _shared/jwt.ts (HS256, MARKETIFY_JWT_SECRET).
//
// Atomicity: the users + lister_profiles inserts run inside a single
// Postgres transaction via the public.auth_signup_lister RPC (us_014
// migration). A failure on the second insert rolls back the first.
//
// Rate limit: not implemented yet. Spec §5.1 requires per-IP throttling via
// a signup_attempts table, which does not exist as of US-014. Tracked in
// progress.txt Codebase Patterns as a future-story item.

import { createClient } from "npm:@supabase/supabase-js@2";
import { signJwt } from "../_shared/jwt.ts";
import { corsHeaders } from "../_shared/cors.ts";

interface SignupRequest {
  username?: unknown;
  email?: unknown;
  org_name?: unknown;
  website_url?: unknown;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
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

  const username = isNonEmptyString(body.username) ? body.username.trim() : null;
  const email = isNonEmptyString(body.email) ? body.email.trim() : null;
  const orgName = isNonEmptyString(body.org_name) ? body.org_name.trim() : null;
  const websiteUrl = isNonEmptyString(body.website_url)
    ? body.website_url.trim()
    : null;

  if (!username || !email || !orgName) {
    return jsonResponse(400, { error: "INVALID_REQUEST" });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse(500, { error: "SERVER_MISCONFIGURED" });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await supabase.rpc("auth_signup_lister", {
    p_username: username,
    p_email: email,
    p_org_name: orgName,
    p_website_url: websiteUrl,
  });

  if (error) {
    console.error("auth_signup_lister rpc error", error);
    return jsonResponse(500, { error: "DB_ERROR" });
  }

  const result = data as { user_id?: string; error?: string } | null;
  if (result?.error === "USERNAME_TAKEN") {
    return jsonResponse(409, { error: "USERNAME_TAKEN" });
  }
  if (result?.error === "EMAIL_TAKEN") {
    return jsonResponse(409, { error: "EMAIL_TAKEN" });
  }
  if (!result?.user_id) {
    console.error("auth_signup_lister returned unexpected shape", result);
    return jsonResponse(500, { error: "DB_ERROR" });
  }

  const userId = result.user_id;
  const sessionId = crypto.randomUUID();
  let token: string;
  try {
    token = await signJwt({
      sub: userId,
      role: "lister",
      session_id: sessionId,
    });
  } catch (err) {
    console.error("signJwt failed", err);
    return jsonResponse(500, { error: "JWT_ERROR" });
  }

  return jsonResponse(200, { token, user_id: userId, role: "lister" });
});

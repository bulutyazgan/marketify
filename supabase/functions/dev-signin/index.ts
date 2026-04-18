// Edge function: dev-signin
//
// Contract:
//   POST { role: 'creator' | 'lister' }
//     → 200 {
//         token: string,
//         user_id: string,
//         role: 'creator' | 'lister',
//         username: string,
//         email: string | null,
//         created_at: string,
//         updated_at: string,
//       }
//     → 400 { error: 'INVALID_REQUEST' | 'INVALID_JSON' }
//     → 404 { error: 'DEV_SIGNIN_DISABLED' }
//     → 500 { error: 'SERVER_MISCONFIGURED' | 'DB_ERROR' | 'JWT_ERROR' }
//
// Purpose: demo/e2e convenience. Lets the dev bypass in the mobile app sign
// in as a single persistent account per role so a flow started as a lister
// (e.g. creating a campaign) is still visible after switching to the creator
// account and back. Without this, every tap on the dev bypass minted a fresh
// account with a Date.now()-suffixed username, which made cross-role flows
// impossible to demo.
//
// Idempotency: fixed usernames `dev_creator` and `dev_lister`. First call
// creates the account via the same RPCs the real signup endpoints use;
// subsequent calls look up the existing row and mint a fresh JWT.
//
// Gating: the handler only runs when ALLOW_DEV_SIGNIN is set to a truthy
// value in the Supabase project's env. Otherwise it returns 404 so the
// endpoint is effectively invisible in production.
//
// Auth: none — this is how the client obtains a JWT. Deployed with
// verify_jwt=false.

import { createClient } from "npm:@supabase/supabase-js@2";
import { signJwt, type AppRole } from "../_shared/jwt.ts";
import { corsHeaders } from "../_shared/cors.ts";

const DEV_CREATOR_USERNAME = "dev_creator";
const DEV_LISTER_USERNAME = "dev_lister";
const DEV_LISTER_EMAIL = "dev_lister@marketify.dev";
const DEV_LISTER_ORG = "Dev Co";
const DEV_CREATOR_TIKTOK_HANDLE = "dev_creator_tiktok";

interface SignInRequest {
  role?: unknown;
}

interface UserRow {
  id: string;
  username: string;
  email: string | null;
  role: AppRole;
  created_at: string;
  updated_at: string;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function isDevSigninEnabled(): boolean {
  const flag = Deno.env.get("ALLOW_DEV_SIGNIN");
  if (!flag) return false;
  return flag === "1" || flag.toLowerCase() === "true";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse(405, { error: "METHOD_NOT_ALLOWED" });
  }
  if (!isDevSigninEnabled()) {
    return jsonResponse(404, { error: "DEV_SIGNIN_DISABLED" });
  }

  let body: SignInRequest;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(400, { error: "INVALID_JSON" });
  }

  const role = body.role === "creator" || body.role === "lister"
    ? body.role
    : null;
  if (!role) {
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

  const username = role === "creator"
    ? DEV_CREATOR_USERNAME
    : DEV_LISTER_USERNAME;

  // Look up existing user first so repeated calls are idempotent.
  const { data: existing, error: lookupError } = await supabase
    .from("users")
    .select("id, username, email, role, created_at, updated_at")
    .eq("username", username)
    .is("deleted_at", null)
    .maybeSingle();
  if (lookupError) {
    console.error("dev-signin lookup error", lookupError);
    return jsonResponse(500, { error: "DB_ERROR" });
  }

  let user: UserRow;
  if (existing) {
    user = existing as UserRow;
  } else {
    const created = await createDevUser(supabase, role);
    if ("error" in created) {
      return jsonResponse(500, { error: created.error });
    }
    user = created.user;
  }

  const sessionId = crypto.randomUUID();
  let token: string;
  try {
    token = await signJwt({
      sub: user.id,
      app_role: user.role,
      session_id: sessionId,
    });
  } catch (err) {
    console.error("dev-signin signJwt failed", err);
    return jsonResponse(500, { error: "JWT_ERROR" });
  }

  return jsonResponse(200, {
    token,
    user_id: user.id,
    role: user.role,
    username: user.username,
    email: user.email,
    created_at: user.created_at,
    updated_at: user.updated_at,
  });
});

// deno-lint-ignore no-explicit-any -- supabase-js generic inference differs
// between typed and untyped callers; loosening here avoids widening.
async function createDevUser(
  supabase: any,
  role: AppRole,
): Promise<{ user: UserRow } | { error: string }> {
  if (role === "creator") {
    const { data, error } = await supabase.rpc("auth_signup_creator", {
      p_username: DEV_CREATOR_USERNAME,
      p_tiktok_handle: DEV_CREATOR_TIKTOK_HANDLE,
      p_instagram_handle: null,
    });
    if (error) {
      console.error("dev-signin creator rpc error", error);
      return { error: "DB_ERROR" };
    }
    const result = data as { user_id?: string; error?: string } | null;
    if (!result?.user_id) {
      console.error("dev-signin creator rpc unexpected", result);
      return { error: "DB_ERROR" };
    }
    return await fetchUser(supabase, result.user_id);
  }

  const { data, error } = await supabase.rpc("auth_signup_lister", {
    p_username: DEV_LISTER_USERNAME,
    p_email: DEV_LISTER_EMAIL,
    p_org_name: DEV_LISTER_ORG,
    p_website_url: null,
  });
  if (error) {
    console.error("dev-signin lister rpc error", error);
    return { error: "DB_ERROR" };
  }
  const result = data as { user_id?: string; error?: string } | null;
  if (!result?.user_id) {
    console.error("dev-signin lister rpc unexpected", result);
    return { error: "DB_ERROR" };
  }
  return await fetchUser(supabase, result.user_id);
}

// deno-lint-ignore no-explicit-any -- see note above.
async function fetchUser(
  supabase: any,
  userId: string,
): Promise<{ user: UserRow } | { error: string }> {
  const { data, error } = await supabase
    .from("users")
    .select("id, username, email, role, created_at, updated_at")
    .eq("id", userId)
    .single();
  if (error || !data) {
    console.error("dev-signin fetchUser error", error);
    return { error: "DB_ERROR" };
  }
  return { user: data as UserRow };
}

// Edge function: auth-signup-creator (US-019 + US-020)
//
// Contract:
//   POST { username: string, tiktok_handle?: string, instagram_handle?: string }
//     → 200 {
//         token: string,
//         user_id: string,
//         role: 'creator',
//         metrics_status: { tiktok?: Status, ig_details?: Status, ig_posts?: Status },
//       }
//       where Status is 'fresh' | 'refreshing' | 'failed'.
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
// Apify dispatch happens AFTER the RPC commits — per spec §5.1, a
// dispatch failure does NOT roll back the account (the user gets their
// JWT, metrics_status carries the per-platform outcome so the client can
// decide whether to retry later or surface a 'refreshing' placeholder).
//
// Handle normalization: leading '@' is stripped and whitespace trimmed
// before the RPC call. Handles are compared case-insensitively (citext),
// matching social_links.handle's column type.
//
// Apify dispatch (US-020): once the RPC commits, we look up the
// freshly-inserted social_links rows, then kick one or more Apify runs in
// parallel via Promise.allSettled — tiktok_profile for TikTok handles;
// ig_details and ig_posts for Instagram handles. Each run is registered
// with a per-run webhook pointing back at /functions/v1/apify-webhook so
// the receiver can persist the metric_snapshots row when Apify finishes.
// The wait window is APIFY_WAIT_SECS (60s); runs that come back
// SUCCEEDED within the window are reported as 'fresh' (the webhook will
// also arrive and be deduped via the unique index on run_id), otherwise
// 'refreshing' and the client polls. A thrown dispatch is 'failed'.
//
// Pre-refreshing rows: the spec calls for pre-creating metric_snapshots
// rows in status='refreshing' before the scrape so the client has
// something to read. That's deferred — the existing US-016..US-018 RPCs
// INSERT on webhook arrival via ON CONFLICT DO NOTHING, so the row
// appears only once Apify finishes. Tracked as a spec gap in progress.txt.
//
// Rate limit: not implemented yet. Spec §5.1 requires per-IP throttling
// via a signup_attempts table (does not yet exist). Same status as the
// sibling auth-signup-lister — tracked in progress.txt Codebase Patterns.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { signJwt } from "../_shared/jwt.ts";
import { corsHeaders } from "../_shared/cors.ts";
import {
  type ApifyDispatchLink,
  dispatchApifyForLinks,
  type MetricsKey,
  type MetricsStatus,
} from "../_shared/apify-dispatch.ts";

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
      app_role: "creator",
      session_id: sessionId,
    });
  } catch (err) {
    console.error("signJwt failed", err);
    return jsonResponse(500, { error: "JWT_ERROR" });
  }

  const metricsStatus = await dispatchApifyRuns({
    supabase,
    supabaseUrl,
    userId,
    tiktokHandle,
    instagramHandle,
  });

  return jsonResponse(200, {
    token,
    user_id: userId,
    role: "creator",
    metrics_status: metricsStatus,
  });
});

// Dispatches the Apify runs required for the freshly-created creator
// account. Returns a partial metrics_status map keyed by platform. If
// APIFY_KEY or APIFY_WEBHOOK_SECRET is unset (e.g. local dev without
// Apify credentials), logs a warning and returns {} — the account is
// still usable, the client just won't see any metrics until a future
// scrape picks it up. A failure to dispatch a single platform does not
// affect the others.
// deno-lint-ignore no-explicit-any -- supabase-js generic args differ between
// the createClient call above (inferred as public schema) and any helper
// import; typing this parameter loosely avoids a widening mismatch.
async function dispatchApifyRuns(params: {
  supabase: SupabaseClient<any, any, any>;
  supabaseUrl: string;
  userId: string;
  tiktokHandle: string | null;
  instagramHandle: string | null;
}): Promise<Partial<Record<MetricsKey, MetricsStatus>>> {
  const { supabase, supabaseUrl, userId } = params;

  // Env-var presence is checked inside dispatchApifyForLinks; no need to
  // gate the social_links lookup on it here.

  const { data: links, error: linksError } = await supabase
    .from("social_links")
    .select("id,platform,handle")
    .eq("user_id", userId);
  if (linksError) {
    console.error("social_links lookup failed", linksError);
    return {};
  }

  const linkRows = (links ?? []) as Array<
    { id: string; platform: string; handle: string }
  >;
  const dispatchLinks: ApifyDispatchLink[] = linkRows
    .filter((l) => l.platform === "tiktok" || l.platform === "instagram")
    .map((l) => ({
      linkId: l.id,
      platform: l.platform as "tiktok" | "instagram",
      handle: l.handle,
    }));

  return await dispatchApifyForLinks({ supabaseUrl, links: dispatchLinks });
}

// Edge function: create-listing (US-053)
//
// Contract:
//   POST {
//     title:           string (1..200 after trim),
//     description:     string (1..5000 after trim),
//     price_cents:     number (integer, >= 0, <= 1e9),
//     currency:        'USD' | 'EUR' | 'GBP',
//     max_submissions: number | null (integer, 1..99999),
//     pre_conditions: Array<{
//       platform: 'tiktok' | 'instagram',
//       metric:   'followers' | 'avg_views',
//       threshold: number (integer, >= 0),
//     }>,
//     post_conditions: Array<{ id: string (uuid), text: string (1..500 trim) }>,
//     sample_urls:     Array<string>  // each must classify as tiktok|instagram
//   }
//     → 201 { listing_id: string, version_id: string }
//     → 400 { error: 'INVALID_JSON' | 'INVALID_REQUEST', field?: string }
//     → 401 { error: 'UNAUTHORIZED' }
//     → 403 { error: 'FORBIDDEN' }                 // non-lister role
//     → 500 { error: 'SERVER_MISCONFIGURED' | 'DB_ERROR' }
//
// Auth: Marketify HS256 JWT (MARKETIFY_JWT_SECRET), app_role must be 'lister'.
//       Gateway `verify_jwt` is disabled because Supabase-issued JWTs aren't
//       the same namespace — the handler enforces auth via _shared/jwt.ts.
//
// The handler is the validation boundary: the RPC assumes caller has already
// normalized shape. We classify sample URLs here (via _shared/oembed.ts) so
// the DB sees the same platform label the wizard preview showed the user.
// Empty / whitespace-only URL rows are dropped silently (the wizard allows
// blank rows as drafting state per US-052).

import { createClient } from "npm:@supabase/supabase-js@2";
import { verifyJwt } from "../_shared/jwt.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { classifyVideoUrl } from "../_shared/oembed.ts";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TITLE_MIN = 1;
const TITLE_MAX = 200;
const DESCRIPTION_MIN = 1;
const DESCRIPTION_MAX = 5000;
const PRICE_CENTS_MAX = 1_000_000_000;
const MAX_SUBMISSIONS_MAX = 99_999;
const POST_TEXT_MAX = 500;
const PRE_CONDITIONS_MAX = 10;
const POST_CONDITIONS_MAX = 20;
const SAMPLE_URLS_MAX = 10;
// Cap pre-condition thresholds at PG int32 max — the RPC casts threshold to
// `::integer` when populating the min_followers_* cache columns, so a value
// above 2,147,483,647 would blow up inside the transaction as a DB_ERROR
// instead of the 400 INVALID_REQUEST the caller actually deserves.
const PRE_THRESHOLD_MAX = 2_147_483_647;
const ALLOWED_CURRENCIES = new Set(["USD", "EUR", "GBP"]);
const ALLOWED_PRE_PLATFORMS = new Set(["tiktok", "instagram"]);
const ALLOWED_PRE_METRICS = new Set(["followers", "avg_views"]);

interface RawRequest {
  title?: unknown;
  description?: unknown;
  price_cents?: unknown;
  currency?: unknown;
  max_submissions?: unknown;
  pre_conditions?: unknown;
  post_conditions?: unknown;
  sample_urls?: unknown;
}

interface RawPreCondition {
  platform?: unknown;
  metric?: unknown;
  threshold?: unknown;
}

interface RawPostCondition {
  id?: unknown;
  text?: unknown;
}

interface NormalizedPayload {
  title: string;
  description: string;
  price_cents: number;
  currency: string;
  max_submissions: number | null;
  pre_conditions: Array<{
    platform: "tiktok" | "instagram";
    metric: "followers" | "avg_views";
    threshold: number;
  }>;
  post_conditions: Array<{ id: string; text: string }>;
  sample_videos: Array<{ platform: "tiktok" | "instagram"; url: string }>;
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

function isNonNegativeSafeInt(n: unknown, max: number): n is number {
  return typeof n === "number" && Number.isFinite(n) && Number.isInteger(n) &&
    n >= 0 && n <= max;
}

function validate(body: RawRequest):
  | { ok: true; payload: NormalizedPayload }
  | { ok: false; field: string } {
  if (typeof body.title !== "string") return { ok: false, field: "title" };
  const title = body.title.trim();
  if (title.length < TITLE_MIN || title.length > TITLE_MAX) {
    return { ok: false, field: "title" };
  }

  if (typeof body.description !== "string") {
    return { ok: false, field: "description" };
  }
  const description = body.description.trim();
  if (
    description.length < DESCRIPTION_MIN ||
    description.length > DESCRIPTION_MAX
  ) {
    return { ok: false, field: "description" };
  }

  if (!isNonNegativeSafeInt(body.price_cents, PRICE_CENTS_MAX)) {
    return { ok: false, field: "price_cents" };
  }
  const priceCents = body.price_cents;

  if (typeof body.currency !== "string" || !ALLOWED_CURRENCIES.has(body.currency)) {
    return { ok: false, field: "currency" };
  }
  const currency = body.currency;

  let maxSubmissions: number | null = null;
  if (body.max_submissions !== null && body.max_submissions !== undefined) {
    if (
      typeof body.max_submissions !== "number" ||
      !Number.isInteger(body.max_submissions) ||
      body.max_submissions < 1 ||
      body.max_submissions > MAX_SUBMISSIONS_MAX
    ) {
      return { ok: false, field: "max_submissions" };
    }
    maxSubmissions = body.max_submissions;
  }

  if (!Array.isArray(body.pre_conditions)) {
    return { ok: false, field: "pre_conditions" };
  }
  if (body.pre_conditions.length > PRE_CONDITIONS_MAX) {
    return { ok: false, field: "pre_conditions" };
  }
  const preConditions: NormalizedPayload["pre_conditions"] = [];
  for (const rawRow of body.pre_conditions) {
    const row = rawRow as RawPreCondition;
    if (typeof row !== "object" || row === null) {
      return { ok: false, field: "pre_conditions" };
    }
    if (typeof row.platform !== "string" || !ALLOWED_PRE_PLATFORMS.has(row.platform)) {
      return { ok: false, field: "pre_conditions.platform" };
    }
    if (typeof row.metric !== "string" || !ALLOWED_PRE_METRICS.has(row.metric)) {
      return { ok: false, field: "pre_conditions.metric" };
    }
    if (!isNonNegativeSafeInt(row.threshold, PRE_THRESHOLD_MAX)) {
      return { ok: false, field: "pre_conditions.threshold" };
    }
    preConditions.push({
      platform: row.platform as "tiktok" | "instagram",
      metric: row.metric as "followers" | "avg_views",
      threshold: row.threshold,
    });
  }

  if (!Array.isArray(body.post_conditions)) {
    return { ok: false, field: "post_conditions" };
  }
  if (body.post_conditions.length > POST_CONDITIONS_MAX) {
    return { ok: false, field: "post_conditions" };
  }
  const postConditions: NormalizedPayload["post_conditions"] = [];
  const seenPostIds = new Set<string>();
  for (const rawRow of body.post_conditions) {
    const row = rawRow as RawPostCondition;
    if (typeof row !== "object" || row === null) {
      return { ok: false, field: "post_conditions" };
    }
    if (typeof row.id !== "string" || !UUID_RE.test(row.id)) {
      return { ok: false, field: "post_conditions.id" };
    }
    if (seenPostIds.has(row.id)) {
      return { ok: false, field: "post_conditions.id" };
    }
    seenPostIds.add(row.id);
    if (typeof row.text !== "string") {
      return { ok: false, field: "post_conditions.text" };
    }
    const text = row.text.trim();
    if (text.length === 0 || text.length > POST_TEXT_MAX) {
      return { ok: false, field: "post_conditions.text" };
    }
    postConditions.push({ id: row.id, text });
  }

  if (!Array.isArray(body.sample_urls)) {
    return { ok: false, field: "sample_urls" };
  }
  if (body.sample_urls.length > SAMPLE_URLS_MAX) {
    return { ok: false, field: "sample_urls" };
  }
  const sampleVideos: NormalizedPayload["sample_videos"] = [];
  for (const rawUrl of body.sample_urls) {
    if (typeof rawUrl !== "string") {
      return { ok: false, field: "sample_urls" };
    }
    const trimmed = rawUrl.trim();
    // Empty rows are wizard drafting state — drop silently so the user
    // doesn't need to explicitly remove them before tapping Publish.
    if (trimmed.length === 0) continue;
    const classification = classifyVideoUrl(trimmed);
    if (!classification) {
      return { ok: false, field: "sample_urls" };
    }
    sampleVideos.push({ platform: classification.platform, url: trimmed });
  }

  return {
    ok: true,
    payload: {
      title,
      description,
      price_cents: priceCents,
      currency,
      max_submissions: maxSubmissions,
      pre_conditions: preConditions,
      post_conditions: postConditions,
      sample_videos: sampleVideos,
    },
  };
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
    "create_listing_rpc",
    {
      p_lister_id: claims.sub,
      p_payload: result.payload as unknown as Record<string, unknown>,
    },
  );

  if (rpcError) {
    console.error("create_listing_rpc error", rpcError);
    return jsonResponse(500, { error: "DB_ERROR" });
  }

  const shaped = rpcData as
    | { listing_id?: string; version_id?: string }
    | null;
  if (!shaped?.listing_id || !shaped.version_id) {
    console.error("create_listing_rpc returned unexpected shape", rpcData);
    return jsonResponse(500, { error: "DB_ERROR" });
  }

  return jsonResponse(201, {
    listing_id: shaped.listing_id,
    version_id: shaped.version_id,
  });
});

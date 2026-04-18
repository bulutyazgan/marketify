// Edge function: get-listing-detail (US-039)
//
// Contract:
//   POST { listing_id: string }
//     → 200 {
//         listing:          <row from public.listings>,
//         conditions:       <rows from listing_conditions, both kinds>,
//         sample_videos:    <rows from sample_videos>,
//         eligibility: {
//           eligible:                boolean,
//           failed_conditions:       Array<{metric, platform, required, actual}>,
//           has_active_application:  boolean,
//         }
//       }
//     → 400 { error: 'INVALID_JSON' | 'INVALID_REQUEST' }
//     → 401 { error: 'UNAUTHORIZED' }
//     → 403 { error: 'FORBIDDEN' }       // non-creator role
//     → 404 { error: 'LISTING_NOT_FOUND' } // also covers draft/archived listings
//     → 500 { error: 'SERVER_MISCONFIGURED' | 'DB_ERROR' }
//
// Auth: Marketify JWT (HS256, MARKETIFY_JWT_SECRET). Verifies via
//       _shared/jwt.ts and asserts role='creator'. Deployed with
//       verify_jwt=false at the gateway because the gateway only knows
//       about Supabase's own JWT secret — the handler enforces auth.
//
// Response shape — primary reference is docs/tech-architecture.md §5.4
// (spec is authoritative per the Ralph iteration rules). Two deltas vs
// the US-039 story AC, both driven by §5.4:
//   1. `conditions` is a single array — the client splits by `kind`.
//      The story's `pre_conditions` / `post_conditions` split contradicts
//      §5.4's single `conditions: ListingCondition[]` field.
//   2. `eligibility.failed_conditions` is `Array<{metric, required, actual}>`
//      — the story's `reasons: string[]` contradicts §5.4. We also keep
//      `platform` as an additive disambiguator because `min_followers`
//      would otherwise be ambiguous across TikTok/Instagram; §5.4 is
//      under-specified on the item shape and an additive field is not
//      a structural departure.
//
// Eligibility — only PRE conditions gate apply-time eligibility per
// docs/tech-architecture.md §6.3 ("Pre-conditions: evaluated on all
// posts; post-conditions: evaluated on submissions"). POST conditions
// are returned in `conditions` for the UI to display but do not
// contribute to `eligible` / `failed_conditions`.
//
// Fail-closed on missing metrics (§3d): when the creator hasn't been
// scraped yet (or a specific platform field is NULL), the PRE condition
// keyed on that field fails — the spec calls this out explicitly for
// Instagram `min_avg_views_last_n` ("Listings that require … treat null
// as ineligible (fail-closed).") and we apply the same rule uniformly.
// The same rule extends to pre-condition rows with an unknown operator
// or unreadable metric: treat as failed rather than silently passing,
// so a future mis-migrated row can't flip a listing to eligible by
// accident.
//
// Visibility — a creator lookup against a `draft` or `archived` listing
// collapses to 404. Draft is never public; archived is terminal and no
// application path can succeed against it, so leaking its existence
// would only produce a dead-end detail view. `paused` and `closed` still
// return 200 so a creator with an existing application can view the
// detail; the Apply CTA in US-040 gates off `listing.status`.

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

interface DetailRequest {
  listing_id?: unknown;
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

  let body: DetailRequest;
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
    .select("*")
    .eq("id", listingId)
    .maybeSingle();

  if (listingError) {
    console.error("listings lookup failed", listingError);
    return jsonResponse(500, { error: "DB_ERROR" });
  }
  // Drafts are never visible to non-owners; archived is terminal and no
  // apply path can succeed against it. Both collapse to 404 so id
  // existence doesn't leak and the UI never lands on a dead-end detail
  // view. `paused`/`closed` stay accessible so a creator with an existing
  // application can still open the detail; the Apply CTA in US-040 gates
  // off `listing.status`.
  if (!listing || listing.status === "draft" || listing.status === "archived") {
    return jsonResponse(404, { error: "LISTING_NOT_FOUND" });
  }

  const versionId = listing.current_version_id as string | null;
  if (!versionId) {
    // Data-integrity guard — publish (US-010 POST /listings) is what sets
    // `current_version_id` on the first version; the bump trigger updates
    // it on subsequent edits. A non-draft/non-archived listing without a
    // current_version_id is a persistence bug, not a normal state — fail
    // with DB_ERROR rather than return an inconsistent response.
    console.error("listing missing current_version_id", listing.id);
    return jsonResponse(500, { error: "DB_ERROR" });
  }

  const [conditionsRes, videosRes, profileRes, appsRes] = await Promise.all([
    supabase
      .from("listing_conditions")
      .select("*")
      .eq("listing_version_id", versionId)
      .order("kind", { ascending: true })
      .order("metric", { ascending: true }),
    supabase
      .from("sample_videos")
      .select("*")
      .eq("listing_version_id", versionId)
      .order("sort_order", { ascending: true }),
    supabase
      .from("creator_profiles")
      .select(
        "tiktok_follower_count,tiktok_avg_views_last_10,tiktok_total_likes," +
          "tiktok_video_count,tiktok_is_verified,instagram_follower_count," +
          "instagram_avg_views_last_10,instagram_media_count",
      )
      .eq("user_id", claims.sub)
      .maybeSingle(),
    supabase
      .from("applications")
      .select("id")
      .eq("listing_id", listingId)
      .eq("creator_id", claims.sub)
      .in("status", ["pending", "approved"])
      .limit(1),
  ]);

  if (conditionsRes.error) {
    console.error("listing_conditions lookup failed", conditionsRes.error);
    return jsonResponse(500, { error: "DB_ERROR" });
  }
  if (videosRes.error) {
    console.error("sample_videos lookup failed", videosRes.error);
    return jsonResponse(500, { error: "DB_ERROR" });
  }
  if (profileRes.error) {
    console.error("creator_profiles lookup failed", profileRes.error);
    return jsonResponse(500, { error: "DB_ERROR" });
  }
  if (appsRes.error) {
    console.error("applications lookup failed", appsRes.error);
    return jsonResponse(500, { error: "DB_ERROR" });
  }

  const conditions = (conditionsRes.data ?? []) as ConditionRow[];

  // Creator profile is created by the signup flow (US-014/US-019) so every
  // creator JWT should have one, but treat a missing row as fully-null
  // metrics — fail-closed on every numeric threshold.
  const metrics: CreatorProfileRow = profileRes.data ?? EMPTY_CREATOR_METRICS;

  const failed = evaluatePreConditions(conditions, metrics);
  const eligible = failed.length === 0;
  const hasActiveApplication = (appsRes.data ?? []).length > 0;

  return jsonResponse(200, {
    listing,
    conditions,
    sample_videos: videosRes.data ?? [],
    eligibility: {
      eligible,
      failed_conditions: failed,
      has_active_application: hasActiveApplication,
    },
  });
});

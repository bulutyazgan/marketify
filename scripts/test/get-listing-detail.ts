// Smoke test for the deployed get-listing-detail edge function (US-039).
//
// Usage: bun run scripts/test/get-listing-detail.ts
// Requires SUPABASE_URL and SUPABASE_ANON_KEY always. MARKETIFY_JWT_SECRET
// unlocks JWT-authed tests; SUPABASE_SERVICE_ROLE_KEY unlocks the
// ineligibility case (needs to mutate creator_profiles.tiktok_follower_count
// below threshold + restore it). Missing either secret SKIPs the
// corresponding assertions with a printed notice rather than failing.
//
// Asserts:
//   1. Missing Authorization → 401 UNAUTHORIZED                               [always]
//   2. Non-Bearer token → 401 UNAUTHORIZED                                    [always]
//   3. JWT signed with wrong secret → 401 UNAUTHORIZED                        [always]
//   4. Lister-role JWT → 403 FORBIDDEN                                        [jwtSecret]
//   5. Malformed JSON body → 400 INVALID_JSON                                 [jwtSecret]
//   6. Missing listing_id → 400 INVALID_REQUEST                               [jwtSecret]
//   7. Non-UUID listing_id → 400 INVALID_REQUEST                              [jwtSecret]
//   8. Unknown listing_id → 404 LISTING_NOT_FOUND                             [jwtSecret]
//   9. Seed creator + seed listing (1k/500 thresholds, creator has 93.7M/15k)
//      → 200 with eligible:true, conditions[] containing both pre+post,
//        sample_videos, has_active_application:false                          [jwtSecret]
//  10. Same call after mutating creator_profiles.tiktok_follower_count to 500
//      → 200 with eligible:false AND failed_conditions including tiktok
//        min_followers with required=1000, actual=500                         [jwtSecret + serviceRole]

const supabaseUrl = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const jwtSecret = process.env.MARKETIFY_JWT_SECRET;
if (!supabaseUrl || !anonKey) {
  console.error("SUPABASE_URL and SUPABASE_ANON_KEY are required in .env");
  process.exit(1);
}
if (!jwtSecret) {
  console.log(
    "MARKETIFY_JWT_SECRET missing — skipping assertions 4–10",
  );
}
if (!serviceRoleKey) {
  console.log(
    "SUPABASE_SERVICE_ROLE_KEY missing — skipping assertion 10 (ineligible)",
  );
}

const endpoint = `${supabaseUrl}/functions/v1/get-listing-detail`;

// Seed fixtures — same UUIDs used by other smoke tests.
const SEED_CREATOR_USER_ID = "11111111-1111-1111-1111-111111111002";
const SEED_LISTING_ID = "11111111-1111-1111-1111-111111111010";

const encoder = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function signMarketifyJwt(
  claims: { sub: string; app_role: "creator" | "lister"; session_id: string },
  secret: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload = { ...claims, role: "authenticated", iat: now, exp: now + 300 };
  const header = b64url(encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = b64url(encoder.encode(JSON.stringify(payload)));
  const signingInput = `${header}.${body}`;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(signingInput));
  return `${signingInput}.${b64url(new Uint8Array(sig))}`;
}

async function post(
  bodyValue: string | Record<string, unknown> | null,
  authHeader: string | null,
) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    apikey: anonKey!,
  };
  if (authHeader) headers["Authorization"] = authHeader;
  const res = await fetch(endpoint, {
    method: "POST",
    headers,
    body: bodyValue == null
      ? undefined
      : typeof bodyValue === "string"
      ? bodyValue
      : JSON.stringify(bodyValue),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

function expect(label: string, cond: boolean, ctx: unknown) {
  if (!cond) {
    console.error(`FAIL ${label}:`, JSON.stringify(ctx, null, 2));
    process.exit(1);
  }
  console.log(`ok — ${label}`);
}

async function setCreatorMetric(
  column: "tiktok_follower_count",
  value: number | null,
): Promise<void> {
  const res = await fetch(
    `${supabaseUrl}/rest/v1/creator_profiles?user_id=eq.${SEED_CREATOR_USER_ID}`,
    {
      method: "PATCH",
      headers: {
        apikey: serviceRoleKey!,
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({ [column]: value }),
    },
  );
  if (!res.ok) {
    throw new Error(`setCreatorMetric failed: ${res.status} ${await res.text()}`);
  }
}

// Snapshot the seed creator's tiktok_follower_count so we can restore it
// after the ineligibility case. Only fetched when we have service role.
let originalTiktokFollowerCount: number | null = null;
if (serviceRoleKey) {
  const snapRes = await fetch(
    `${supabaseUrl}/rest/v1/creator_profiles?user_id=eq.${SEED_CREATOR_USER_ID}&select=tiktok_follower_count`,
    {
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
      },
    },
  );
  if (!snapRes.ok) {
    console.error("creator_profiles snapshot failed:", await snapRes.text());
    process.exit(1);
  }
  const rows = (await snapRes.json()) as Array<{ tiktok_follower_count: number | null }>;
  if (rows.length === 0) {
    console.error(
      "seed creator_profiles missing — run seed fixtures before this test",
    );
    process.exit(1);
  }
  originalTiktokFollowerCount = rows[0].tiktok_follower_count;
}

let restored = false;
async function restore() {
  if (restored || !serviceRoleKey) return;
  restored = true;
  await setCreatorMetric("tiktok_follower_count", originalTiktokFollowerCount);
}

try {
  // 1. No Authorization header
  {
    const r = await post({ listing_id: SEED_LISTING_ID }, null);
    expect(
      "missing auth → 401 UNAUTHORIZED",
      r.status === 401 && r.data?.error === "UNAUTHORIZED",
      r,
    );
  }

  // 2. Non-Bearer scheme
  {
    const r = await post({ listing_id: SEED_LISTING_ID }, "Basic abcdef");
    expect(
      "non-bearer → 401 UNAUTHORIZED",
      r.status === 401 && r.data?.error === "UNAUTHORIZED",
      r,
    );
  }

  // 3. JWT signed with wrong secret
  {
    const badJwt = await signMarketifyJwt(
      {
        sub: SEED_CREATOR_USER_ID,
        app_role: "creator",
        session_id: crypto.randomUUID(),
      },
      "wrong-secret-" + Math.random().toString(36).slice(2),
    );
    const r = await post({ listing_id: SEED_LISTING_ID }, `Bearer ${badJwt}`);
    expect(
      "wrong-secret JWT → 401 UNAUTHORIZED",
      r.status === 401 && r.data?.error === "UNAUTHORIZED",
      r,
    );
  }

  if (jwtSecret) {
    // 4. Lister-role JWT (valid signature, wrong role)
    {
      const listerJwt = await signMarketifyJwt(
        { sub: crypto.randomUUID(), app_role: "lister", session_id: crypto.randomUUID() },
        jwtSecret,
      );
      const r = await post({ listing_id: SEED_LISTING_ID }, `Bearer ${listerJwt}`);
      expect(
        "lister-role JWT → 403 FORBIDDEN",
        r.status === 403 && r.data?.error === "FORBIDDEN",
        r,
      );
    }

    const creatorJwt = await signMarketifyJwt(
      {
        sub: SEED_CREATOR_USER_ID,
        app_role: "creator",
        session_id: crypto.randomUUID(),
      },
      jwtSecret,
    );
    const creatorAuth = `Bearer ${creatorJwt}`;

    // 5. Malformed JSON body
    {
      const r = await post("{not-json", creatorAuth);
      expect(
        "malformed JSON → 400 INVALID_JSON",
        r.status === 400 && r.data?.error === "INVALID_JSON",
        r,
      );
    }

    // 6. Missing listing_id
    {
      const r = await post({}, creatorAuth);
      expect(
        "missing listing_id → 400 INVALID_REQUEST",
        r.status === 400 && r.data?.error === "INVALID_REQUEST",
        r,
      );
    }

    // 7. Non-UUID listing_id
    {
      const r = await post({ listing_id: "not-a-uuid" }, creatorAuth);
      expect(
        "non-UUID listing_id → 400 INVALID_REQUEST",
        r.status === 400 && r.data?.error === "INVALID_REQUEST",
        r,
      );
    }

    // 8. Unknown listing_id
    {
      const r = await post(
        { listing_id: "00000000-0000-0000-0000-000000000000" },
        creatorAuth,
      );
      expect(
        "unknown listing_id → 404 LISTING_NOT_FOUND",
        r.status === 404 && r.data?.error === "LISTING_NOT_FOUND",
        r,
      );
    }

    // 9. Happy path — seed creator is eligible for seed listing
    {
      const r = await post({ listing_id: SEED_LISTING_ID }, creatorAuth);
      const d = r.data;
      const conds: Array<{
        kind: string;
        metric: string;
        platform: string | null;
        operator: string;
        numeric_threshold: string | number | null;
      }> = Array.isArray(d?.conditions) ? d.conditions : [];
      const preCount = conds.filter((c) => c.kind === "pre").length;
      const postCount = conds.filter((c) => c.kind === "post").length;
      const tiktokFollowers = conds.find(
        (c) =>
          c.kind === "pre" && c.platform === "tiktok" &&
          c.metric === "min_followers",
      );
      expect(
        "happy path → 200 with eligible:true + conditions[] + sample_videos",
        r.status === 200 &&
          d?.listing?.id === SEED_LISTING_ID &&
          Array.isArray(d?.conditions) &&
          preCount >= 2 &&
          postCount >= 1 &&
          !!tiktokFollowers &&
          tiktokFollowers.operator === "gte" &&
          Number(tiktokFollowers.numeric_threshold) === 1000 &&
          Array.isArray(d?.sample_videos) &&
          d.sample_videos.length >= 1 &&
          d?.eligibility?.eligible === true &&
          Array.isArray(d.eligibility.failed_conditions) &&
          d.eligibility.failed_conditions.length === 0 &&
          d.eligibility.has_active_application === false,
        r,
      );
    }

    if (serviceRoleKey) {
      // 10. Force-fail the TikTok min_followers pre-condition
      {
        await setCreatorMetric("tiktok_follower_count", 500);
        const r = await post({ listing_id: SEED_LISTING_ID }, creatorAuth);
        const d = r.data;
        const ttFail = (d?.eligibility?.failed_conditions ?? []).find(
          (f: { metric: string; platform: string }) =>
            f.metric === "min_followers" && f.platform === "tiktok",
        );
        expect(
          "below-threshold → 200 eligible:false + tiktok min_followers failure",
          r.status === 200 &&
            d?.eligibility?.eligible === false &&
            !!ttFail &&
            ttFail.metric === "min_followers" &&
            ttFail.platform === "tiktok" &&
            ttFail.required === 1000 &&
            ttFail.actual === 500,
          r,
        );
        // Restore immediately — the finally block also restores, but doing
        // it inline keeps state consistent if later assertions are added.
        await setCreatorMetric(
          "tiktok_follower_count",
          originalTiktokFollowerCount,
        );
      }
    }
  }

  console.log("all get-listing-detail smoke tests passed");
} finally {
  await restore();
}

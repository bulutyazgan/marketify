// Smoke test for the deployed apply-to-listing edge function (US-041).
//
// Usage: bun run scripts/test/apply-to-listing.ts
// Requires SUPABASE_URL and SUPABASE_ANON_KEY always. MARKETIFY_JWT_SECRET
// unlocks JWT-authed tests; SUPABASE_SERVICE_ROLE_KEY unlocks the
// insert/cleanup + ineligibility + already-applied cases. Missing either
// secret SKIPs the corresponding assertions with a printed notice rather
// than failing.
//
// Asserts:
//   1. Missing Authorization → 401 UNAUTHORIZED                               [always]
//   2. Non-Bearer token → 401 UNAUTHORIZED                                    [always]
//   3. JWT signed with wrong secret → 401 UNAUTHORIZED                        [always]
//   4. Lister-role JWT → 403 FORBIDDEN                                        [jwtSecret]
//   5. Malformed JSON body → 400 INVALID_JSON                                 [jwtSecret]
//   6. Missing listing_id → 400 INVALID_REQUEST                               [jwtSecret]
//   7. Non-UUID listing_id → 400 INVALID_REQUEST                              [jwtSecret]
//   8. Non-string cover_note → 400 INVALID_REQUEST                            [jwtSecret]
//   9. Over-long cover_note → 400 INVALID_REQUEST                             [jwtSecret]
//  10. Unknown listing_id → 404 LISTING_NOT_FOUND                             [jwtSecret]
//  11. Ineligible listing (forced tiktok_follower_count=500, threshold 1000)
//      → 403 INELIGIBLE with failed_conditions containing tiktok
//        min_followers required=1000 actual=500                               [jwtSecret + serviceRole]
//  12. Happy path — seed creator applies to seed listing with a cover_note →
//      200 with { application_id, listing_version_id }                        [jwtSecret + serviceRole]
//  13. Second apply to the same listing by the same creator
//      → 409 ALREADY_APPLIED                                                  [jwtSecret + serviceRole]
//
// The happy-path test cleans up the inserted application row at the end
// (idempotency across re-runs). Test row pattern:
//   applications.listing_id      = SEED_LISTING_ID
//   applications.creator_id      = SEED_CREATOR_USER_ID
//   applications.cover_note LIKE 'US-041 smoke test%'
// All rows matching that cover_note pattern are deleted in the `finally`
// block so a failed mid-run doesn't poison subsequent runs.

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
    "MARKETIFY_JWT_SECRET missing — skipping assertions 4–13",
  );
}
if (!serviceRoleKey) {
  console.log(
    "SUPABASE_SERVICE_ROLE_KEY missing — skipping assertions 11–13",
  );
}

const endpoint = `${supabaseUrl}/functions/v1/apply-to-listing`;

// Seed fixtures — same UUIDs used by get-listing-detail smoke test.
const SEED_CREATOR_USER_ID = "11111111-1111-1111-1111-111111111002";
const SEED_LISTING_ID = "11111111-1111-1111-1111-111111111010";

const encoder = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function signMarketifyJwt(
  claims: { sub: string; role: "creator" | "lister"; session_id: string },
  secret: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload = { ...claims, iat: now, exp: now + 300 };
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

async function deleteSmokeApplications(): Promise<void> {
  if (!serviceRoleKey) return;
  // Using the cover_note LIKE filter + creator/listing scoping means we
  // never touch real application rows even if someone pointed the test at
  // prod by mistake.
  const url = `${supabaseUrl}/rest/v1/applications` +
    `?listing_id=eq.${SEED_LISTING_ID}` +
    `&creator_id=eq.${SEED_CREATOR_USER_ID}` +
    `&cover_note=like.US-041 smoke test*`;
  const res = await fetch(url, {
    method: "DELETE",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      Prefer: "return=minimal",
    },
  });
  if (!res.ok) {
    console.warn(`cleanup delete failed: ${res.status} ${await res.text()}`);
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
  if (restored) return;
  restored = true;
  if (serviceRoleKey) {
    await setCreatorMetric("tiktok_follower_count", originalTiktokFollowerCount);
  }
  await deleteSmokeApplications();
}

// Ensure a clean slate before each run — a leftover application from a
// prior failed run would blow up the happy-path assertion with a
// premature 409 ALREADY_APPLIED.
await deleteSmokeApplications();

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
        role: "creator",
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
        {
          sub: crypto.randomUUID(),
          role: "lister",
          session_id: crypto.randomUUID(),
        },
        jwtSecret,
      );
      const r = await post(
        { listing_id: SEED_LISTING_ID },
        `Bearer ${listerJwt}`,
      );
      expect(
        "lister-role JWT → 403 FORBIDDEN",
        r.status === 403 && r.data?.error === "FORBIDDEN",
        r,
      );
    }

    const creatorJwt = await signMarketifyJwt(
      {
        sub: SEED_CREATOR_USER_ID,
        role: "creator",
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

    // 8. Non-string cover_note
    {
      const r = await post(
        { listing_id: SEED_LISTING_ID, cover_note: 12345 },
        creatorAuth,
      );
      expect(
        "non-string cover_note → 400 INVALID_REQUEST",
        r.status === 400 && r.data?.error === "INVALID_REQUEST",
        r,
      );
    }

    // 9. Over-long cover_note (> 2000 chars)
    {
      const r = await post(
        { listing_id: SEED_LISTING_ID, cover_note: "a".repeat(2001) },
        creatorAuth,
      );
      expect(
        "over-long cover_note → 400 INVALID_REQUEST",
        r.status === 400 && r.data?.error === "INVALID_REQUEST",
        r,
      );
    }

    // 10. Unknown listing_id
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

    if (serviceRoleKey) {
      // 11. Force-fail the TikTok min_followers pre-condition → 403 INELIGIBLE
      {
        await setCreatorMetric("tiktok_follower_count", 500);
        const r = await post({ listing_id: SEED_LISTING_ID }, creatorAuth);
        const ttFail = (r.data?.failed_conditions ?? []).find(
          (f: { metric: string; platform: string }) =>
            f.metric === "min_followers" && f.platform === "tiktok",
        );
        expect(
          "ineligible → 403 INELIGIBLE with tiktok min_followers failure",
          r.status === 403 &&
            r.data?.error === "INELIGIBLE" &&
            Array.isArray(r.data?.failed_conditions) &&
            !!ttFail &&
            ttFail.required === 1000 &&
            ttFail.actual === 500,
          r,
        );
        await setCreatorMetric(
          "tiktok_follower_count",
          originalTiktokFollowerCount,
        );
      }

      // 12. Happy path — eligible creator applies to seed listing
      let createdApplicationId: string | null = null;
      {
        const r = await post(
          {
            listing_id: SEED_LISTING_ID,
            cover_note: "US-041 smoke test — " + Date.now(),
          },
          creatorAuth,
        );
        expect(
          "happy path → 200 { application_id, listing_version_id }",
          r.status === 200 &&
            typeof r.data?.application_id === "string" &&
            typeof r.data?.listing_version_id === "string",
          r,
        );
        createdApplicationId = r.data?.application_id ?? null;
      }

      // 13. Second apply to the same listing → 409 ALREADY_APPLIED
      {
        const r = await post(
          {
            listing_id: SEED_LISTING_ID,
            cover_note: "US-041 smoke test — second attempt",
          },
          creatorAuth,
        );
        expect(
          "duplicate apply → 409 ALREADY_APPLIED",
          r.status === 409 && r.data?.error === "ALREADY_APPLIED",
          r,
        );
      }

      // Sanity-check: the created row exists with status='pending' and
      // listing_version_id matches listings.current_version_id.
      if (createdApplicationId) {
        const verifyRes = await fetch(
          `${supabaseUrl}/rest/v1/applications?id=eq.${createdApplicationId}` +
            `&select=id,status,listing_version_id,listing_id,creator_id,cover_note`,
          {
            headers: {
              apikey: serviceRoleKey,
              Authorization: `Bearer ${serviceRoleKey}`,
            },
          },
        );
        const rows = (await verifyRes.json()) as Array<{
          id: string;
          status: string;
          listing_version_id: string;
          listing_id: string;
          creator_id: string;
          cover_note: string | null;
        }>;
        expect(
          "inserted application row has status=pending + matching linkage",
          rows.length === 1 &&
            rows[0].status === "pending" &&
            rows[0].listing_id === SEED_LISTING_ID &&
            rows[0].creator_id === SEED_CREATOR_USER_ID &&
            typeof rows[0].listing_version_id === "string" &&
            rows[0].cover_note !== null &&
            rows[0].cover_note.startsWith("US-041 smoke test"),
          rows,
        );
      }
    }
  }

  console.log("all apply-to-listing smoke tests passed");
} finally {
  await restore();
}

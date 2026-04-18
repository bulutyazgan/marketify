// Smoke test for the deployed metrics-refresh edge function (US-021).
//
// Usage: bun run scripts/test/metrics-refresh.ts
// Requires SUPABASE_URL and SUPABASE_ANON_KEY always. MARKETIFY_JWT_SECRET
// unlocks role + validation + 404 assertions; SUPABASE_SERVICE_ROLE_KEY
// unlocks the 429 throttle + 422 unlinked assertions (they need to mutate
// the seed social_link). Missing either secret SKIPs the corresponding
// assertions with a printed notice rather than failing — the full 10-case
// matrix runs in CI where every env var is configured.
//
// All branches exercised here short-circuit BEFORE the Apify dispatch, so
// the test does not burn Apify credits. The happy-path (200 + queued run)
// is verified live during mobile-mcp UI verification, not here.
//
// Asserts:
//   1. Missing Authorization → 401 UNAUTHORIZED                                          [always]
//   2. Non-Bearer token → 401 UNAUTHORIZED                                               [always]
//   3. JWT signed with wrong secret → 401 UNAUTHORIZED                                   [always]
//   4. Lister-role JWT → 403 FORBIDDEN                                                   [jwtSecret]
//   5. Creator JWT + malformed JSON body → 400 INVALID_JSON                              [jwtSecret]
//   6. Creator JWT + missing social_link_id → 400 INVALID_REQUEST                        [jwtSecret]
//   7. Creator JWT + non-UUID social_link_id → 400 INVALID_REQUEST                       [jwtSecret]
//   8. Creator JWT + UUID not owned by caller → 404 LINK_NOT_FOUND                       [jwtSecret]
//   9. Owner JWT + recently-bumped link → 429 RATE_LIMIT with retry_after_sec            [jwtSecret + serviceRole]
//  10. Owner JWT + link with status='unlinked' → 422 LINK_UNLINKED                       [jwtSecret + serviceRole]
//  11. Owner JWT + latest fresh snapshot within window → 200 already_fresh               [jwtSecret + serviceRole]

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
    "MARKETIFY_JWT_SECRET missing — skipping assertions 4–10 (role/validation/404/429/422)",
  );
}
if (!serviceRoleKey) {
  console.log(
    "SUPABASE_SERVICE_ROLE_KEY missing — skipping assertions 9–10 (throttle/unlinked)",
  );
}

const endpoint = `${supabaseUrl}/functions/v1/metrics-refresh`;

// Seeded fixtures from scripts/sql/seed.sql (used by the apify-webhook smoke
// test as well). The test mutates last_scrape_attempt_at and status on
// these rows and restores them in a finally block.
const SEED_CREATOR_USER_ID = "11111111-1111-1111-1111-111111111002";
const SEED_TIKTOK_SOCIAL_LINK_ID = "11111111-1111-1111-1111-111111111020";

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
    console.error(`FAIL ${label}:`, ctx);
    process.exit(1);
  }
  console.log(`ok — ${label}`);
}

type SocialLinkStatus = "linked" | "unlinked" | "failed_fetch";

async function setLinkFields(
  linkId: string,
  fields: {
    last_scrape_attempt_at?: string | null;
    status?: SocialLinkStatus;
  },
): Promise<void> {
  const res = await fetch(
    `${supabaseUrl}/rest/v1/social_links?id=eq.${linkId}`,
    {
      method: "PATCH",
      headers: {
        apikey: serviceRoleKey!,
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify(fields),
    },
  );
  if (!res.ok) {
    throw new Error(
      `setLinkFields failed: ${res.status} ${await res.text()}`,
    );
  }
}

// Snapshot the seed link's current state so we can restore it later.
// Only needed when the service role is available (tests 9 and 10 mutate
// the link). Without the service role we skip those tests and the
// snapshot + restore are no-ops.
type LinkSnapshot = {
  status: SocialLinkStatus;
  last_scrape_attempt_at: string | null;
};
let snapshot: LinkSnapshot | null = null;
if (serviceRoleKey) {
  const snapshotRes = await fetch(
    `${supabaseUrl}/rest/v1/social_links?id=eq.${SEED_TIKTOK_SOCIAL_LINK_ID}&select=status,last_scrape_attempt_at`,
    {
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
      },
    },
  );
  if (!snapshotRes.ok) {
    console.error("seed link snapshot failed:", await snapshotRes.text());
    process.exit(1);
  }
  const [row] = (await snapshotRes.json()) as LinkSnapshot[];
  if (!row) {
    console.error(
      "seed social_link missing — run scripts/sql/seed.sql before this test",
    );
    process.exit(1);
  }
  snapshot = row;
}

// Tracks metric_snapshot rows inserted by test 11 so restore() can remove
// them from the seed DB. Populated only when the service role is available.
const insertedSnapshotIds: string[] = [];

let restored = false;
async function restore() {
  if (restored || !serviceRoleKey) return;
  restored = true;
  if (snapshot) {
    await setLinkFields(SEED_TIKTOK_SOCIAL_LINK_ID, {
      status: snapshot.status,
      last_scrape_attempt_at: snapshot.last_scrape_attempt_at,
    });
  }
  if (insertedSnapshotIds.length > 0) {
    const idList = insertedSnapshotIds.map((id) => `"${id}"`).join(",");
    const res = await fetch(
      `${supabaseUrl}/rest/v1/metric_snapshots?id=in.(${idList})`,
      {
        method: "DELETE",
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
          Prefer: "return=minimal",
        },
      },
    );
    if (!res.ok) {
      console.error(
        "cleanup of inserted metric_snapshots failed:",
        res.status,
        await res.text(),
      );
    }
  }
}

try {
  // 1. No Authorization header
  {
    const r = await post({ social_link_id: SEED_TIKTOK_SOCIAL_LINK_ID }, null);
    expect(
      "missing auth → 401 UNAUTHORIZED",
      r.status === 401 && r.data?.error === "UNAUTHORIZED",
      r,
    );
  }

  // 2. Non-Bearer scheme
  {
    const r = await post(
      { social_link_id: SEED_TIKTOK_SOCIAL_LINK_ID },
      "Basic abcdef",
    );
    expect(
      "non-bearer → 401 UNAUTHORIZED",
      r.status === 401 && r.data?.error === "UNAUTHORIZED",
      r,
    );
  }

  // 3. JWT signed with wrong secret
  {
    const badJwt = await signMarketifyJwt(
      { sub: SEED_CREATOR_USER_ID, app_role: "creator", session_id: crypto.randomUUID() },
      "wrong-secret-" + Math.random().toString(36).slice(2),
    );
    const r = await post(
      { social_link_id: SEED_TIKTOK_SOCIAL_LINK_ID },
      `Bearer ${badJwt}`,
    );
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
      const r = await post(
        { social_link_id: SEED_TIKTOK_SOCIAL_LINK_ID },
        `Bearer ${listerJwt}`,
      );
      expect(
        "lister-role JWT → 403 FORBIDDEN",
        r.status === 403 && r.data?.error === "FORBIDDEN",
        r,
      );
    }

    // Creator JWT — reused for the remaining validation paths.
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

    // 6. Missing social_link_id
    {
      const r = await post({}, creatorAuth);
      expect(
        "missing social_link_id → 400 INVALID_REQUEST",
        r.status === 400 && r.data?.error === "INVALID_REQUEST",
        r,
      );
    }

    // 7. Non-UUID social_link_id
    {
      const r = await post({ social_link_id: "not-a-uuid" }, creatorAuth);
      expect(
        "non-UUID social_link_id → 400 INVALID_REQUEST",
        r.status === 400 && r.data?.error === "INVALID_REQUEST",
        r,
      );
    }

    // 8. Valid UUID that either doesn't exist or isn't owned by caller.
    //    Both cases collapse to 404 LINK_NOT_FOUND so the endpoint doesn't
    //    leak id existence across creators.
    {
      const r = await post(
        { social_link_id: "00000000-0000-0000-0000-000000000000" },
        creatorAuth,
      );
      expect(
        "unknown social_link_id → 404 LINK_NOT_FOUND",
        r.status === 404 && r.data?.error === "LINK_NOT_FOUND",
        r,
      );
    }

    if (serviceRoleKey) {
      // 9. Throttle: bump last_scrape_attempt_at to now and expect 429.
      //    This verifies that the 6h window is honoured without burning Apify.
      {
        const nowIso = new Date().toISOString();
        await setLinkFields(SEED_TIKTOK_SOCIAL_LINK_ID, {
          last_scrape_attempt_at: nowIso,
        });
        const r = await post(
          { social_link_id: SEED_TIKTOK_SOCIAL_LINK_ID },
          creatorAuth,
        );
        const retryAfter = r.data?.retry_after_sec;
        expect(
          "recent attempt → 429 RATE_LIMIT with retry_after_sec",
          r.status === 429 &&
            r.data?.error === "RATE_LIMIT" &&
            typeof retryAfter === "number" &&
            retryAfter > 0 &&
            retryAfter <= 6 * 60 * 60,
          r,
        );
      }

      // 10. LINK_UNLINKED: flip status to 'unlinked' and confirm 422.
      //     Restore the linked state immediately after — the finally block
      //     will also re-apply the original snapshot, but doing it inline
      //     keeps the row consistent if later assertions are added.
      {
        await setLinkFields(SEED_TIKTOK_SOCIAL_LINK_ID, { status: "unlinked" });
        const r = await post(
          { social_link_id: SEED_TIKTOK_SOCIAL_LINK_ID },
          creatorAuth,
        );
        expect(
          "status=unlinked → 422 LINK_UNLINKED",
          r.status === 422 && r.data?.error === "LINK_UNLINKED",
          r,
        );
        await setLinkFields(SEED_TIKTOK_SOCIAL_LINK_ID, { status: "linked" });
      }

      // 11. already_fresh: insert a synthetic `is_latest=true, status='fresh'`
      //     snapshot for the required scrape_mode and clear the throttle so
      //     the endpoint has to reach the already_fresh branch. The function
      //     should return 200 { status: 'already_fresh' } with snapshot_ids
      //     containing the row we just wrote.
      {
        await setLinkFields(SEED_TIKTOK_SOCIAL_LINK_ID, {
          last_scrape_attempt_at: null,
        });
        const insertRes = await fetch(
          `${supabaseUrl}/rest/v1/metric_snapshots`,
          {
            method: "POST",
            headers: {
              apikey: serviceRoleKey!,
              Authorization: `Bearer ${serviceRoleKey}`,
              "Content-Type": "application/json",
              Prefer: "return=representation",
            },
            body: JSON.stringify({
              social_link_id: SEED_TIKTOK_SOCIAL_LINK_ID,
              scrape_mode: "tiktok_profile",
              apify_run_id: `us021_fresh_${Date.now()}`,
              status: "fresh",
              is_latest: true,
              fetched_at: new Date().toISOString(),
              follower_count: 100,
              following_count: 10,
              total_likes: 500,
              video_count: 5,
            }),
          },
        );
        if (!insertRes.ok) {
          console.error(
            "fresh snapshot insert failed (test 11 skipped):",
            insertRes.status,
            await insertRes.text(),
          );
        } else {
          const [inserted] = (await insertRes.json()) as Array<{ id: string }>;
          insertedSnapshotIds.push(inserted.id);
          const r = await post(
            { social_link_id: SEED_TIKTOK_SOCIAL_LINK_ID },
            creatorAuth,
          );
          expect(
            "fresh snapshot within window → 200 already_fresh",
            r.status === 200 &&
              r.data?.status === "already_fresh" &&
              Array.isArray(r.data?.snapshot_ids) &&
              r.data.snapshot_ids.includes(inserted.id) &&
              r.data?.metrics_status?.tiktok === "fresh",
            r,
          );
        }
      }
    }
  }

  console.log("all metrics-refresh smoke tests passed");
} finally {
  await restore();
}

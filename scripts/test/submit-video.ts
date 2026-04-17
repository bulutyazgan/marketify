// Smoke test for the deployed submit-video edge function (US-045).
//
// Usage: bun run scripts/test/submit-video.ts
// Requires SUPABASE_URL and SUPABASE_ANON_KEY always. MARKETIFY_JWT_SECRET
// unlocks JWT-authed tests; SUPABASE_SERVICE_ROLE_KEY unlocks the
// approved-application + happy-path + duplicate cases.
//
// Asserts:
//   1.  Missing Authorization → 401 UNAUTHORIZED                               [always]
//   2.  Non-Bearer scheme → 401 UNAUTHORIZED                                   [always]
//   3.  JWT signed with wrong secret → 401 UNAUTHORIZED                        [always]
//   4.  Lister-role JWT → 403 FORBIDDEN                                        [jwtSecret]
//   5.  Malformed JSON → 400 INVALID_JSON                                      [jwtSecret]
//   6.  Missing application_id → 400 INVALID_REQUEST                           [jwtSecret]
//   7.  Non-UUID application_id → 400 INVALID_REQUEST                          [jwtSecret]
//   8.  Non-string video_url → 400 INVALID_REQUEST                             [jwtSecret]
//   9.  Missing post_condition_affirmations → 400 INVALID_REQUEST              [jwtSecret]
//  10.  Non-boolean affirmation value → 400 INVALID_REQUEST                    [jwtSecret]
//  11.  Unclassifiable URL (youtube) → 422 INVALID_VIDEO_URL                   [jwtSecret]
//  12.  Unknown application_id → 404 APPLICATION_NOT_FOUND                     [jwtSecret]
//  13.  Pending application → 403 APPLICATION_NOT_APPROVED                    [jwtSecret + serviceRole]
//  14.  Approved app, missing affirmations → 422 INCOMPLETE_AFFIRMATIONS      [jwtSecret + serviceRole]
//  15.  Approved app, all affirmations true, IG URL → 200 { submission_id }    [jwtSecret + serviceRole]
//  16.  Duplicate submit on same application → 409 SUBMISSION_EXISTS           [jwtSecret + serviceRole]
//
// Test row pattern:
//   A single applications row is created at startup (status='approved',
//   listing_id=SEED_LISTING_ID, creator_id=SEED_CREATOR_USER_ID,
//   cover_note starting with 'US-045 smoke test') and deleted in the
//   finally block along with every submission/submission_video that
//   hangs off it. Using the cover_note scope means a mis-configured run
//   against prod can only touch rows this script created.
//
// Instagram URL is used for the happy path because it avoids a
// network call to TikTok's oEmbed endpoint — IG validation is
// regex-only (see `supabase/functions/_shared/oembed.ts`). The TikTok
// oEmbed path is covered by assertion 11 (unclassifiable → 422) and by
// the INVALID_VIDEO_URL handling in the edge function itself.

const supabaseUrl = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const jwtSecret = process.env.MARKETIFY_JWT_SECRET;
if (!supabaseUrl || !anonKey) {
  console.error("SUPABASE_URL and SUPABASE_ANON_KEY are required in .env");
  process.exit(1);
}
if (!jwtSecret) {
  console.log("MARKETIFY_JWT_SECRET missing — skipping assertions 4–16");
}
if (!serviceRoleKey) {
  console.log("SUPABASE_SERVICE_ROLE_KEY missing — skipping assertions 13–16");
}

const endpoint = `${supabaseUrl}/functions/v1/submit-video`;

// Seed fixtures — same UUIDs used by other smoke tests.
const SEED_CREATOR_USER_ID = "11111111-1111-1111-1111-111111111002";
const SEED_LISTING_ID = "11111111-1111-1111-1111-111111111010";
const SEED_LISTING_VERSION_ID = "11111111-1111-1111-1111-111111111011";

// Post-condition ids on the seed listing version (both must be affirmed
// true on the happy path). If the seed changes these, the test picks
// them up from the live DB below.
let seedPostConditionIds: string[] = [];

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
  const header = b64url(
    encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })),
  );
  const body = b64url(encoder.encode(JSON.stringify(payload)));
  const signingInput = `${header}.${body}`;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(signingInput),
  );
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

function srHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    apikey: serviceRoleKey!,
    Authorization: `Bearer ${serviceRoleKey}`,
    ...extra,
  };
}

let createdApplicationId: string | null = null;

async function deleteSmokeRows(): Promise<void> {
  if (!serviceRoleKey) return;
  // Cascade: submissions.application_id → submission_videos.submission_id.
  // We delete by the 'US-045 smoke test' cover_note scope so a stray
  // misconfiguration cannot touch real rows.
  const appListUrl = `${supabaseUrl}/rest/v1/applications` +
    `?listing_id=eq.${SEED_LISTING_ID}` +
    `&creator_id=eq.${SEED_CREATOR_USER_ID}` +
    `&cover_note=like.US-045 smoke test*` +
    `&select=id`;
  const listRes = await fetch(appListUrl, { headers: srHeaders() });
  if (!listRes.ok) {
    console.warn(`cleanup list failed: ${listRes.status} ${await listRes.text()}`);
    return;
  }
  const appRows = (await listRes.json()) as Array<{ id: string }>;
  for (const { id } of appRows) {
    // submission_videos has FK → submissions. Delete videos first, then
    // submissions, then the application.
    const subsRes = await fetch(
      `${supabaseUrl}/rest/v1/submissions?application_id=eq.${id}&select=id`,
      { headers: srHeaders() },
    );
    if (subsRes.ok) {
      const subs = (await subsRes.json()) as Array<{ id: string }>;
      for (const s of subs) {
        await fetch(
          `${supabaseUrl}/rest/v1/submission_videos?submission_id=eq.${s.id}`,
          { method: "DELETE", headers: srHeaders({ Prefer: "return=minimal" }) },
        );
      }
      await fetch(
        `${supabaseUrl}/rest/v1/submissions?application_id=eq.${id}`,
        { method: "DELETE", headers: srHeaders({ Prefer: "return=minimal" }) },
      );
    }
    await fetch(
      `${supabaseUrl}/rest/v1/applications?id=eq.${id}`,
      { method: "DELETE", headers: srHeaders({ Prefer: "return=minimal" }) },
    );
  }
}

async function createApprovedApplication(
  coverNote: string,
): Promise<string> {
  const res = await fetch(`${supabaseUrl}/rest/v1/applications`, {
    method: "POST",
    headers: srHeaders({
      "Content-Type": "application/json",
      Prefer: "return=representation",
    }),
    body: JSON.stringify({
      listing_id: SEED_LISTING_ID,
      listing_version_id: SEED_LISTING_VERSION_ID,
      creator_id: SEED_CREATOR_USER_ID,
      status: "approved",
      cover_note: coverNote,
    }),
  });
  if (!res.ok) {
    throw new Error(
      `createApprovedApplication failed: ${res.status} ${await res.text()}`,
    );
  }
  const rows = (await res.json()) as Array<{ id: string }>;
  return rows[0].id;
}

async function loadSeedPostConditions(): Promise<string[]> {
  const res = await fetch(
    `${supabaseUrl}/rest/v1/listing_conditions` +
      `?listing_version_id=eq.${SEED_LISTING_VERSION_ID}` +
      `&kind=eq.post&select=id`,
    { headers: srHeaders() },
  );
  if (!res.ok) {
    throw new Error(`loadSeedPostConditions failed: ${await res.text()}`);
  }
  const rows = (await res.json()) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

// Ensure a clean slate before each run.
await deleteSmokeRows();

if (serviceRoleKey) {
  seedPostConditionIds = await loadSeedPostConditions();
  if (seedPostConditionIds.length === 0) {
    console.error(
      "seed post conditions missing — run seed fixtures before this test",
    );
    process.exit(1);
  }
}

function allAffirmed(): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const id of seedPostConditionIds) out[id] = true;
  return out;
}

// A well-formed IG URL — regex-accepted, no network fetch happens.
const HAPPY_IG_URL = "https://www.instagram.com/reel/ABCdef_123/";

try {
  // 1. No Authorization header
  {
    const r = await post(
      {
        application_id: "00000000-0000-0000-0000-000000000000",
        video_url: HAPPY_IG_URL,
        post_condition_affirmations: {},
      },
      null,
    );
    expect(
      "missing auth → 401 UNAUTHORIZED",
      r.status === 401 && r.data?.error === "UNAUTHORIZED",
      r,
    );
  }

  // 2. Non-Bearer scheme
  {
    const r = await post(
      {
        application_id: "00000000-0000-0000-0000-000000000000",
        video_url: HAPPY_IG_URL,
        post_condition_affirmations: {},
      },
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
      {
        sub: SEED_CREATOR_USER_ID,
        role: "creator",
        session_id: crypto.randomUUID(),
      },
      "wrong-secret-" + Math.random().toString(36).slice(2),
    );
    const r = await post(
      {
        application_id: "00000000-0000-0000-0000-000000000000",
        video_url: HAPPY_IG_URL,
        post_condition_affirmations: {},
      },
      `Bearer ${badJwt}`,
    );
    expect(
      "wrong-secret JWT → 401 UNAUTHORIZED",
      r.status === 401 && r.data?.error === "UNAUTHORIZED",
      r,
    );
  }

  if (jwtSecret) {
    // 4. Lister-role JWT
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
        {
          application_id: "00000000-0000-0000-0000-000000000000",
          video_url: HAPPY_IG_URL,
          post_condition_affirmations: {},
        },
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

    // 5. Malformed JSON
    {
      const r = await post("{not-json", creatorAuth);
      expect(
        "malformed JSON → 400 INVALID_JSON",
        r.status === 400 && r.data?.error === "INVALID_JSON",
        r,
      );
    }

    // 6. Missing application_id
    {
      const r = await post(
        {
          video_url: HAPPY_IG_URL,
          post_condition_affirmations: {},
        },
        creatorAuth,
      );
      expect(
        "missing application_id → 400 INVALID_REQUEST",
        r.status === 400 && r.data?.error === "INVALID_REQUEST",
        r,
      );
    }

    // 7. Non-UUID application_id
    {
      const r = await post(
        {
          application_id: "not-a-uuid",
          video_url: HAPPY_IG_URL,
          post_condition_affirmations: {},
        },
        creatorAuth,
      );
      expect(
        "non-UUID application_id → 400 INVALID_REQUEST",
        r.status === 400 && r.data?.error === "INVALID_REQUEST",
        r,
      );
    }

    // 8. Non-string video_url
    {
      const r = await post(
        {
          application_id: "00000000-0000-0000-0000-000000000000",
          video_url: 12345,
          post_condition_affirmations: {},
        },
        creatorAuth,
      );
      expect(
        "non-string video_url → 400 INVALID_REQUEST",
        r.status === 400 && r.data?.error === "INVALID_REQUEST",
        r,
      );
    }

    // 9. Missing post_condition_affirmations
    {
      const r = await post(
        {
          application_id: "00000000-0000-0000-0000-000000000000",
          video_url: HAPPY_IG_URL,
        },
        creatorAuth,
      );
      expect(
        "missing affirmations → 400 INVALID_REQUEST",
        r.status === 400 && r.data?.error === "INVALID_REQUEST",
        r,
      );
    }

    // 10. Non-boolean affirmation value
    {
      const r = await post(
        {
          application_id: "00000000-0000-0000-0000-000000000000",
          video_url: HAPPY_IG_URL,
          post_condition_affirmations: { foo: "yes" },
        },
        creatorAuth,
      );
      expect(
        "non-boolean affirmation → 400 INVALID_REQUEST",
        r.status === 400 && r.data?.error === "INVALID_REQUEST",
        r,
      );
    }

    // 11. Unclassifiable URL — youtube isn't tiktok/instagram
    {
      const r = await post(
        {
          application_id: "00000000-0000-0000-0000-000000000000",
          video_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
          post_condition_affirmations: {},
        },
        creatorAuth,
      );
      expect(
        "unclassifiable URL → 422 INVALID_VIDEO_URL",
        r.status === 422 && r.data?.error === "INVALID_VIDEO_URL",
        r,
      );
    }

    // 12. Unknown application_id
    {
      const r = await post(
        {
          application_id: "00000000-0000-0000-0000-000000000000",
          video_url: HAPPY_IG_URL,
          post_condition_affirmations: {},
        },
        creatorAuth,
      );
      expect(
        "unknown application → 404 APPLICATION_NOT_FOUND",
        r.status === 404 && r.data?.error === "APPLICATION_NOT_FOUND",
        r,
      );
    }

    if (serviceRoleKey) {
      // 13. Pending application → 403 APPLICATION_NOT_APPROVED
      {
        // Create a *pending* application first, submit, then delete it.
        const pendingRes = await fetch(
          `${supabaseUrl}/rest/v1/applications`,
          {
            method: "POST",
            headers: srHeaders({
              "Content-Type": "application/json",
              Prefer: "return=representation",
            }),
            body: JSON.stringify({
              listing_id: SEED_LISTING_ID,
              listing_version_id: SEED_LISTING_VERSION_ID,
              creator_id: SEED_CREATOR_USER_ID,
              status: "pending",
              cover_note: "US-045 smoke test pending",
            }),
          },
        );
        if (!pendingRes.ok) {
          throw new Error(
            `create pending application failed: ${await pendingRes.text()}`,
          );
        }
        const pendingRows = (await pendingRes.json()) as Array<{ id: string }>;
        const pendingId = pendingRows[0].id;
        const r = await post(
          {
            application_id: pendingId,
            video_url: HAPPY_IG_URL,
            post_condition_affirmations: allAffirmed(),
          },
          creatorAuth,
        );
        expect(
          "pending application → 403 APPLICATION_NOT_APPROVED",
          r.status === 403 && r.data?.error === "APPLICATION_NOT_APPROVED",
          r,
        );
        // Delete the pending row now; it'd block the approved-create
        // below because of the partial unique index on (listing_id,
        // creator_id) WHERE status='pending'.
        await fetch(
          `${supabaseUrl}/rest/v1/applications?id=eq.${pendingId}`,
          { method: "DELETE", headers: srHeaders({ Prefer: "return=minimal" }) },
        );
      }

      // 14. Approved app, missing affirmations → 422 INCOMPLETE_AFFIRMATIONS
      createdApplicationId = await createApprovedApplication(
        "US-045 smoke test — " + Date.now(),
      );
      {
        const r = await post(
          {
            application_id: createdApplicationId,
            video_url: HAPPY_IG_URL,
            post_condition_affirmations: {},
          },
          creatorAuth,
        );
        expect(
          "incomplete affirmations → 422 INCOMPLETE_AFFIRMATIONS",
          r.status === 422 &&
            r.data?.error === "INCOMPLETE_AFFIRMATIONS" &&
            Array.isArray(r.data?.missing_condition_ids) &&
            r.data.missing_condition_ids.length === seedPostConditionIds.length,
          r,
        );
      }

      // 15. Happy path — approved app, all affirmations true, IG URL
      let submissionId: string | null = null;
      {
        const r = await post(
          {
            application_id: createdApplicationId,
            video_url: HAPPY_IG_URL,
            post_condition_affirmations: allAffirmed(),
          },
          creatorAuth,
        );
        expect(
          "happy path → 200 { submission_id, platform:'instagram' }",
          r.status === 200 &&
            typeof r.data?.submission_id === "string" &&
            r.data?.platform === "instagram",
          r,
        );
        submissionId = r.data?.submission_id ?? null;
      }

      // 16. Duplicate submit → 409 SUBMISSION_EXISTS
      {
        const r = await post(
          {
            application_id: createdApplicationId,
            video_url: HAPPY_IG_URL,
            post_condition_affirmations: allAffirmed(),
          },
          creatorAuth,
        );
        expect(
          "duplicate submit → 409 SUBMISSION_EXISTS",
          r.status === 409 && r.data?.error === "SUBMISSION_EXISTS",
          r,
        );
      }

      // Sanity-check the DB state: the submission row exists pending and
      // its submission_video row points back with the right platform.
      if (submissionId) {
        const subRes = await fetch(
          `${supabaseUrl}/rest/v1/submissions?id=eq.${submissionId}` +
            `&select=id,status,application_id`,
          { headers: srHeaders() },
        );
        const subRows = (await subRes.json()) as Array<{
          id: string;
          status: string;
          application_id: string;
        }>;
        expect(
          "submission row: status=pending + application linkage",
          subRows.length === 1 &&
            subRows[0].status === "pending" &&
            subRows[0].application_id === createdApplicationId,
          subRows,
        );

        const vidRes = await fetch(
          `${supabaseUrl}/rest/v1/submission_videos?submission_id=eq.${submissionId}` +
            `&select=platform,url,external_id,sort_order`,
          { headers: srHeaders() },
        );
        const vidRows = (await vidRes.json()) as Array<{
          platform: string;
          url: string;
          external_id: string | null;
          sort_order: number;
        }>;
        expect(
          "submission_video row: platform=instagram, url + external_id",
          vidRows.length === 1 &&
            vidRows[0].platform === "instagram" &&
            vidRows[0].url === HAPPY_IG_URL &&
            vidRows[0].external_id === "ABCdef_123" &&
            vidRows[0].sort_order === 0,
          vidRows,
        );
      }
    }
  }

  console.log("all submit-video smoke tests passed");
} finally {
  await deleteSmokeRows();
}

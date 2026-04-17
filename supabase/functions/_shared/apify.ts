// Apify client wrapper for Marketify edge functions.
//
// Contract: runTikTokProfile(handle, { waitSecs? })    -> { runId, datasetId, status }
//           runInstagramDetails(handle, { waitSecs? }) -> { runId, datasetId, status }
//           runInstagramPosts(handle, { waitSecs? })   -> { runId, datasetId, status }
// Actors:   `clockworks/tiktok-scraper` (REST slug `clockworks~tiktok-scraper`),
//           `apify/instagram-scraper`  (REST slug `apify~instagram-scraper`).
//           Actor input shapes per docs/tech-architecture.md §3b / §3c.
// Endpoint: POST https://api.apify.com/v2/acts/<slug>/runs?token=<key>&waitForFinish=<secs>.
//           The waitForFinish query parameter makes Apify block up to `waitSecs`
//           seconds before returning the run object, so callers can either parse
//           results inline (status=SUCCEEDED) or fall back to webhook-completed
//           delivery when the wait expires (status=RUNNING).
// Secret:   APIFY_KEY env var (the Apify API token).
// Auth:     no inbound auth requirement — this module is a building block for
//           edge functions that have already verified JWT.

const APIFY_API_BASE = "https://api.apify.com/v2";

const TIKTOK_ACTOR_SLUG = "clockworks~tiktok-scraper";
const INSTAGRAM_ACTOR_SLUG = "apify~instagram-scraper";

const DEFAULT_WAIT_SECS = 60;

export interface ApifyRunResult {
  runId: string;
  datasetId: string;
  status: string;
}

export interface ApifyRunOptions {
  waitSecs?: number;
}

function readApifyKey(): string {
  const k = Deno.env.get("APIFY_KEY");
  if (!k) throw new Error("APIFY_KEY is not set");
  return k;
}

async function startActorRun(
  slug: string,
  input: Record<string, unknown>,
  waitSecs: number,
): Promise<ApifyRunResult> {
  if (!Number.isFinite(waitSecs) || waitSecs < 0) {
    throw new Error("waitSecs must be a non-negative finite number");
  }
  const url = new URL(`${APIFY_API_BASE}/acts/${slug}/runs`);
  url.searchParams.set("token", readApifyKey());
  url.searchParams.set("waitForFinish", String(Math.floor(waitSecs)));

  const res = await fetch(url.toString(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });

  if (!res.ok) {
    // Response body is intentionally not included — Apify sometimes echoes
    // the request URL (which carries the APIFY_KEY query param) inside error
    // payloads, and this error will land in edge-function logs.
    throw new Error(
      `Apify actor '${slug}' run failed: ${res.status} ${res.statusText}`,
    );
  }

  const payload = (await res.json()) as {
    data?: { id?: string; defaultDatasetId?: string; status?: string };
  };
  const data = payload.data;
  if (
    !data ||
    typeof data.id !== "string" ||
    typeof data.defaultDatasetId !== "string" ||
    typeof data.status !== "string"
  ) {
    throw new Error(
      `Apify actor '${slug}' returned malformed run payload`,
    );
  }
  return {
    runId: data.id,
    datasetId: data.defaultDatasetId,
    status: data.status,
  };
}

export async function runTikTokProfile(
  handle: string,
  options: ApifyRunOptions = {},
): Promise<ApifyRunResult> {
  if (!handle) throw new Error("handle is required");
  return await startActorRun(
    TIKTOK_ACTOR_SLUG,
    {
      profiles: [handle],
      resultsPerPage: 10,
      profileScrapeSections: ["videos"],
      profileSorting: "latest",
      excludePinnedPosts: true,
      shouldDownloadVideos: false,
      shouldDownloadCovers: false,
    },
    options.waitSecs ?? DEFAULT_WAIT_SECS,
  );
}

export async function runInstagramDetails(
  handle: string,
  options: ApifyRunOptions = {},
): Promise<ApifyRunResult> {
  if (!handle) throw new Error("handle is required");
  return await startActorRun(
    INSTAGRAM_ACTOR_SLUG,
    {
      directUrls: [`https://www.instagram.com/${handle}/`],
      resultsType: "details",
      resultsLimit: 1,
      addParentData: false,
    },
    options.waitSecs ?? DEFAULT_WAIT_SECS,
  );
}

export async function runInstagramPosts(
  handle: string,
  options: ApifyRunOptions = {},
): Promise<ApifyRunResult> {
  if (!handle) throw new Error("handle is required");
  return await startActorRun(
    INSTAGRAM_ACTOR_SLUG,
    {
      directUrls: [`https://www.instagram.com/${handle}/`],
      resultsType: "posts",
      resultsLimit: 10,
      addParentData: false,
    },
    options.waitSecs ?? DEFAULT_WAIT_SECS,
  );
}

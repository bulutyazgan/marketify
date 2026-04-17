// Unit tests for the Apify client wrapper.
//
// Replace `globalThis.fetch` with a spy, then assert each wrapper function
// constructs the correct URL (actor slug + token + waitForFinish) and POST
// body (actor input shape per docs/tech-architecture.md §3b / §3c).
//
// Run: deno test --allow-env supabase/functions/_shared/apify.test.ts

import {
  assertEquals,
  assertRejects,
} from "jsr:@std/assert@1";

import {
  runInstagramDetails,
  runInstagramPosts,
  runTikTokProfile,
} from "./apify.ts";

type Captured = { url: string; init: RequestInit };

function installFetchSpy(
  response: Record<string, unknown>,
  init: ResponseInit = { status: 201 },
): { captured: Captured[]; restore: () => void } {
  const original = globalThis.fetch;
  const captured: Captured[] = [];
  globalThis.fetch = ((input: string | URL | Request, reqInit?: RequestInit) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
    captured.push({ url, init: reqInit ?? {} });
    return Promise.resolve(
      new Response(JSON.stringify(response), {
        status: init.status ?? 201,
        headers: { "content-type": "application/json" },
      }),
    );
    // deno-lint-ignore no-explicit-any -- fetch has many overloads; the spy matches the subset we use
  }) as any;
  return { captured, restore: () => { globalThis.fetch = original; } };
}

function stubRunResponse() {
  return {
    data: {
      id: "run_abc123",
      defaultDatasetId: "ds_xyz789",
      status: "SUCCEEDED",
    },
  };
}

function setApifyKey(value: string | null) {
  if (value === null) Deno.env.delete("APIFY_KEY");
  else Deno.env.set("APIFY_KEY", value);
}

Deno.test("runTikTokProfile builds the tiktok actor run request", async () => {
  setApifyKey("test-token");
  const { captured, restore } = installFetchSpy(stubRunResponse());
  try {
    const result = await runTikTokProfile("charlidamelio");

    assertEquals(captured.length, 1);
    const url = new URL(captured[0].url);
    assertEquals(url.origin + url.pathname,
      "https://api.apify.com/v2/acts/clockworks~tiktok-scraper/runs");
    assertEquals(url.searchParams.get("token"), "test-token");
    assertEquals(url.searchParams.get("waitForFinish"), "60");

    assertEquals(captured[0].init.method, "POST");
    const headers = new Headers(captured[0].init.headers as HeadersInit);
    assertEquals(headers.get("content-type"), "application/json");

    const body = JSON.parse(captured[0].init.body as string);
    assertEquals(body, {
      profiles: ["charlidamelio"],
      resultsPerPage: 10,
      profileScrapeSections: ["videos"],
      profileSorting: "latest",
      excludePinnedPosts: true,
      shouldDownloadVideos: false,
      shouldDownloadCovers: false,
    });

    assertEquals(result, {
      runId: "run_abc123",
      datasetId: "ds_xyz789",
      status: "SUCCEEDED",
    });
  } finally {
    restore();
  }
});

Deno.test("runInstagramDetails builds the ig details actor run request", async () => {
  setApifyKey("test-token");
  const { captured, restore } = installFetchSpy(stubRunResponse());
  try {
    await runInstagramDetails("nasa", { waitSecs: 90 });

    const url = new URL(captured[0].url);
    assertEquals(url.origin + url.pathname,
      "https://api.apify.com/v2/acts/apify~instagram-scraper/runs");
    assertEquals(url.searchParams.get("token"), "test-token");
    assertEquals(url.searchParams.get("waitForFinish"), "90");

    const body = JSON.parse(captured[0].init.body as string);
    assertEquals(body, {
      directUrls: ["https://www.instagram.com/nasa/"],
      resultsType: "details",
      resultsLimit: 1,
      addParentData: false,
    });
  } finally {
    restore();
  }
});

Deno.test("runInstagramPosts builds the ig posts actor run request", async () => {
  setApifyKey("test-token");
  const { captured, restore } = installFetchSpy(stubRunResponse());
  try {
    await runInstagramPosts("nasa");

    const url = new URL(captured[0].url);
    assertEquals(url.origin + url.pathname,
      "https://api.apify.com/v2/acts/apify~instagram-scraper/runs");
    assertEquals(url.searchParams.get("token"), "test-token");
    assertEquals(url.searchParams.get("waitForFinish"), "60");

    const body = JSON.parse(captured[0].init.body as string);
    assertEquals(body, {
      directUrls: ["https://www.instagram.com/nasa/"],
      resultsType: "posts",
      resultsLimit: 10,
      addParentData: false,
    });
  } finally {
    restore();
  }
});

Deno.test("throws when APIFY_KEY is not set", async () => {
  setApifyKey(null);
  const { restore } = installFetchSpy(stubRunResponse());
  try {
    await assertRejects(
      () => runTikTokProfile("someone"),
      Error,
      "APIFY_KEY is not set",
    );
  } finally {
    restore();
  }
});

Deno.test("throws when Apify returns non-2xx", async () => {
  setApifyKey("test-token");
  const { restore } = installFetchSpy(
    { error: { type: "actor-not-found", message: "nope" } },
    { status: 404 },
  );
  try {
    await assertRejects(
      () => runTikTokProfile("someone"),
      Error,
      "Apify actor",
    );
  } finally {
    restore();
  }
});

Deno.test("throws when response is missing required run fields", async () => {
  setApifyKey("test-token");
  const { restore } = installFetchSpy({ data: { id: "run_1" } });
  try {
    await assertRejects(
      () => runTikTokProfile("someone"),
      Error,
      "malformed",
    );
  } finally {
    restore();
  }
});

Deno.test("rejects empty handle without calling fetch", async () => {
  setApifyKey("test-token");
  const { captured, restore } = installFetchSpy(stubRunResponse());
  try {
    await assertRejects(
      () => runTikTokProfile(""),
      Error,
      "handle is required",
    );
    assertEquals(captured.length, 0);
  } finally {
    restore();
  }
});

Deno.test("rejects negative waitSecs", async () => {
  setApifyKey("test-token");
  const { captured, restore } = installFetchSpy(stubRunResponse());
  try {
    await assertRejects(
      () => runTikTokProfile("x", { waitSecs: -1 }),
      Error,
      "waitSecs",
    );
    assertEquals(captured.length, 0);
  } finally {
    restore();
  }
});

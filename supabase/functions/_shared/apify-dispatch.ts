// Shared helper: dispatches Apify runs for one or more social_links rows
// and returns a partial metrics_status map keyed by platform/scrape mode.
//
// Used by auth-signup-creator (US-020) and manage-social-link (US-035) so
// both flows kick the same Apify scrapes with identical webhook payloads.
//
// Env: APIFY_KEY + APIFY_WEBHOOK_SECRET. If either is missing (e.g. local
// dev without Apify credentials), logs a warning and returns {}.

import {
  type ApifyRunResult,
  type ApifyWebhookSpec,
  runInstagramDetails,
  runInstagramPosts,
  runTikTokProfile,
} from "./apify.ts";

const APIFY_WAIT_SECS = 60;
const APIFY_TERMINAL_EVENTS = [
  "ACTOR.RUN.SUCCEEDED",
  "ACTOR.RUN.FAILED",
  "ACTOR.RUN.TIMED_OUT",
  "ACTOR.RUN.ABORTED",
];

export interface ApifyDispatchLink {
  linkId: string;
  platform: "tiktok" | "instagram";
  handle: string;
}

export type MetricsKey = "tiktok" | "ig_details" | "ig_posts";
export type MetricsStatus = "fresh" | "refreshing" | "failed";

export async function dispatchApifyForLinks(params: {
  supabaseUrl: string;
  links: ApifyDispatchLink[];
}): Promise<Partial<Record<MetricsKey, MetricsStatus>>> {
  const { supabaseUrl, links } = params;
  const metricsStatus: Partial<Record<MetricsKey, MetricsStatus>> = {};

  const apifyKey = Deno.env.get("APIFY_KEY");
  const webhookSecret = Deno.env.get("APIFY_WEBHOOK_SECRET");
  if (!apifyKey || !webhookSecret) {
    console.warn(
      "apify dispatch skipped: APIFY_KEY or APIFY_WEBHOOK_SECRET missing",
    );
    return metricsStatus;
  }

  const webhookUrl = `${supabaseUrl}/functions/v1/apify-webhook`;
  const buildWebhook = (
    linkId: string,
    scrapeMode: "tiktok_profile" | "ig_details" | "ig_posts",
  ): ApifyWebhookSpec => ({
    eventTypes: APIFY_TERMINAL_EVENTS,
    requestUrl: webhookUrl,
    payloadTemplate: JSON.stringify({
      eventType: "{{eventType}}",
      resource: {
        id: "{{resource.id}}",
        defaultDatasetId: "{{resource.defaultDatasetId}}",
        status: "{{resource.status}}",
        actId: "{{resource.actId}}",
      },
      social_link_id: linkId,
      scrape_mode: scrapeMode,
      // Mirrors resource.id — apify-webhook validates body.run_id directly
      // (it's the apify_run_id idempotency key on metric_snapshots).
      run_id: "{{resource.id}}",
    }),
    headersTemplate: JSON.stringify({
      "X-Apify-Webhook-Secret": webhookSecret,
    }),
    shouldInterpolateStrings: true,
  });

  interface Task {
    key: MetricsKey;
    run: () => Promise<ApifyRunResult>;
  }
  const tasks: Task[] = [];
  for (const link of links) {
    if (link.platform === "tiktok") {
      tasks.push({
        key: "tiktok",
        run: () =>
          runTikTokProfile(link.handle, {
            waitSecs: APIFY_WAIT_SECS,
            webhooks: [buildWebhook(link.linkId, "tiktok_profile")],
          }),
      });
    } else if (link.platform === "instagram") {
      tasks.push({
        key: "ig_details",
        run: () =>
          runInstagramDetails(link.handle, {
            waitSecs: APIFY_WAIT_SECS,
            webhooks: [buildWebhook(link.linkId, "ig_details")],
          }),
      });
      tasks.push({
        key: "ig_posts",
        run: () =>
          runInstagramPosts(link.handle, {
            waitSecs: APIFY_WAIT_SECS,
            webhooks: [buildWebhook(link.linkId, "ig_posts")],
          }),
      });
    }
  }

  if (tasks.length === 0) return metricsStatus;

  const settled = await Promise.allSettled(tasks.map((t) => t.run()));
  settled.forEach((outcome, i) => {
    const key = tasks[i].key;
    if (outcome.status === "fulfilled") {
      const s = outcome.value.status;
      metricsStatus[key] = s === "SUCCEEDED"
        ? "fresh"
        : s === "READY" || s === "RUNNING" ||
            s === "TIMING-OUT" || s === "ABORTING"
        ? "refreshing"
        : "failed";
    } else {
      console.error(`apify ${key} dispatch failed`, outcome.reason);
      metricsStatus[key] = "failed";
    }
  });

  return metricsStatus;
}

// Eligibility engine — shared between get-listing-detail and
// apply-to-listing (US-039 + US-041).
//
// Pre-conditions are evaluated against the creator's denormalized metrics
// from `creator_profiles`. Only pre-conditions gate apply-time eligibility
// per docs/tech-architecture.md §6.3. Post-conditions are returned by
// get-listing-detail for UI display and evaluated later on submissions.
//
// Fail-closed on missing metrics (§3d): when the creator hasn't been
// scraped yet (or a specific platform field is NULL), the pre-condition
// keyed on that field fails. Same rule extends to pre-condition rows with
// an unknown operator or unreadable metric — treat as failed rather than
// silently pass, so a future mis-migrated row can't flip a listing to
// eligible by accident.

export type Platform = "tiktok" | "instagram";
export type ConditionKind = "pre" | "post";

export interface ConditionRow {
  id: string;
  listing_version_id: string;
  kind: ConditionKind;
  metric: string;
  platform: Platform | null;
  operator: string;
  numeric_threshold: string | number | null;
  text_threshold: string | null;
  bool_threshold: boolean | null;
  created_at: string;
}

export interface CreatorProfileRow {
  tiktok_follower_count: number | null;
  tiktok_avg_views_last_10: number | null;
  tiktok_total_likes: number | null;
  tiktok_video_count: number | null;
  tiktok_is_verified: boolean | null;
  instagram_follower_count: number | null;
  instagram_avg_views_last_10: number | null;
  instagram_media_count: number | null;
}

export interface FailedCondition {
  metric: string;
  platform: Platform | null;
  required: number | boolean;
  actual: number | boolean | null;
}

export const EMPTY_CREATOR_METRICS: CreatorProfileRow = {
  tiktok_follower_count: null,
  tiktok_avg_views_last_10: null,
  tiktok_total_likes: null,
  tiktok_video_count: null,
  tiktok_is_verified: null,
  instagram_follower_count: null,
  instagram_avg_views_last_10: null,
  instagram_media_count: null,
};

// Evaluate a single pre-condition against the creator's denormalized
// metrics. Returns `null` on pass, or the failed-condition detail on fail.
// Missing data (null actual for a numeric threshold) fails closed per §3d.
export function evaluatePreCondition(
  condition: ConditionRow,
  metrics: CreatorProfileRow,
): FailedCondition | null {
  const { metric, platform, operator } = condition;
  if (operator === "gte") {
    const required = Number(condition.numeric_threshold);
    // Malformed numeric_threshold (NULL or non-numeric) fails closed per §3d —
    // schema CHECKs should prevent this today, but a future mis-migrated row
    // must not flip a condition to "always passes" just because it's unreadable.
    if (!Number.isFinite(required)) {
      return { metric, platform, required: 0, actual: null };
    }
    const actual = readNumericMetric(metrics, platform, metric);
    if (actual === null || actual < required) {
      return { metric, platform, required, actual };
    }
    return null;
  }
  if (operator === "bool") {
    const required = condition.bool_threshold === true;
    const actual = readBoolMetric(metrics, platform, metric);
    if (actual !== required) {
      return { metric, platform, required, actual };
    }
    return null;
  }
  // Unknown operator on a PRE row — fail-closed per §3d. `eq`/`contains`/`lte`
  // are reserved for post-conditions today (e.g. post_must_mention uses
  // 'contains'), so this branch should be unreachable; if a future migration
  // misplaces an operator, we'd rather block an apply than silently allow it.
  console.warn("pre-condition with unknown operator treated as failed", {
    condition_id: condition.id,
    operator,
    metric,
    platform,
  });
  const parsed = Number(condition.numeric_threshold);
  return {
    metric,
    platform,
    required: Number.isFinite(parsed) ? parsed : 0,
    actual: null,
  };
}

// Evaluate every pre-condition and return the (possibly empty) list of
// failures. Post-conditions are ignored.
export function evaluatePreConditions(
  conditions: ConditionRow[],
  metrics: CreatorProfileRow,
): FailedCondition[] {
  const failed: FailedCondition[] = [];
  for (const c of conditions) {
    if (c.kind !== "pre") continue;
    const miss = evaluatePreCondition(c, metrics);
    if (miss) failed.push(miss);
  }
  return failed;
}

function readNumericMetric(
  metrics: CreatorProfileRow,
  platform: Platform | null,
  metric: string,
): number | null {
  if (platform === "tiktok") {
    switch (metric) {
      case "min_followers":
        return metrics.tiktok_follower_count;
      case "min_avg_views_last_n":
        return metrics.tiktok_avg_views_last_10;
      case "min_total_likes":
        return metrics.tiktok_total_likes;
      case "min_videos_posted":
        return metrics.tiktok_video_count;
      default:
        return null;
    }
  }
  if (platform === "instagram") {
    switch (metric) {
      case "min_followers":
        return metrics.instagram_follower_count;
      case "min_avg_views_last_n":
        return metrics.instagram_avg_views_last_10;
      case "min_videos_posted":
        return metrics.instagram_media_count;
      default:
        return null;
    }
  }
  return null;
}

function readBoolMetric(
  metrics: CreatorProfileRow,
  platform: Platform | null,
  metric: string,
): boolean | null {
  if (platform === "tiktok" && metric === "verified_only") {
    return metrics.tiktok_is_verified;
  }
  return null;
}

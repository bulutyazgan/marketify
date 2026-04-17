-- US-017 — RPC backing the apify-webhook edge function (ig_details branch).
--
-- Contract: public.apify_webhook_persist_ig_details(
--   p_run_id text, p_social_link_id uuid,
--   p_status public.metric_status, p_fetched_at timestamptz,
--   p_follower_count int, p_following_count int,
--   p_media_count int, p_is_verified boolean,
--   p_raw_payload jsonb, p_error_message text
-- ) returns jsonb:
--   {"inserted": true,  "duplicate": false, "snapshot_id": "<uuid>"}  on fresh insert
--   {"inserted": false, "duplicate": true}                              on ON CONFLICT no-op
--
-- Behavior: Inserts one public.metric_snapshots row keyed on apify_run_id with
--   scrape_mode='ig_details'. The partial unique index metric_snapshots_run_uniq
--   (US-007) enforces webhook-delivery idempotency — a second webhook carrying
--   the same run_id hits ON CONFLICT DO NOTHING and returns duplicate=true.
--
--   ig_details owns these metric_snapshots columns per
--   docs/tech-architecture.md §4.7 lines 576-581 comments:
--     follower_count, following_count, video_count (= postsCount),
--     is_verified. total_likes and avg_views_last_10 are left NULL
--     (ig_posts owns avg_views_last_10; total_likes is tiktok-only).
--
--   On a fresh-status insert the US-007 BEFORE INSERT trigger trg_denorm_metrics
--   fires and — under the (social_link_id, scrape_mode) advisory lock — mirrors
--   into public.creator_profiles: instagram_follower_count, instagram_media_count,
--   metrics_fetched_at (guarded with greatest()). is_verified and following_count
--   remain forensic-only on metric_snapshots — there is no instagram_is_verified
--   or instagram_following_count denorm column in v1 (spec §4.7 creator_profiles
--   block). On a 'failed'-status row, denorm_metrics short-circuits on
--   new.status <> 'fresh', sets is_latest=false, skips the denorm writes.
--
-- Auth: revoked from anon / authenticated / public. Granted only to
--   service_role (the edge function's client).
--
-- Spec gap handoff — US-020 pre-refreshing rows:
--   US-020 will pre-create metric_snapshots rows in status='refreshing' before
--   the webhook arrives, so run_id is attached at dispatch time. This RPC does
--   NOT currently detect a pre-existing 'refreshing' row — ON CONFLICT DO
--   NOTHING no-ops and the row stays 'refreshing' until the fail-stuck-
--   refreshing janitor cron flips it to 'failed'. Same constraint as US-016's
--   tiktok_profile RPC. US-020 must extend this RPC (UPDATE-then-INSERT) or the
--   denorm trigger (fire BEFORE UPDATE) before pre-refreshing rows ship.
--   Tracked in progress.txt Codebase Patterns.

create or replace function public.apify_webhook_persist_ig_details(
  p_run_id text,
  p_social_link_id uuid,
  p_status public.metric_status,
  p_fetched_at timestamptz,
  p_follower_count int,
  p_following_count int,
  p_media_count int,
  p_is_verified boolean,
  p_raw_payload jsonb,
  p_error_message text
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_snapshot_id uuid;
begin
  if p_run_id is null or length(p_run_id) = 0 then
    raise exception 'p_run_id must be non-empty';
  end if;
  if p_status not in ('fresh'::public.metric_status, 'failed'::public.metric_status) then
    raise exception 'p_status must be fresh or failed, got %', p_status;
  end if;

  insert into public.metric_snapshots (
    social_link_id,
    scrape_mode,
    apify_run_id,
    status,
    follower_count,
    following_count,
    video_count,
    is_verified,
    raw_payload,
    fetched_at,
    error_message
  ) values (
    p_social_link_id,
    'ig_details'::public.scrape_mode,
    p_run_id,
    p_status,
    p_follower_count,
    p_following_count,
    p_media_count,
    p_is_verified,
    p_raw_payload,
    p_fetched_at,
    p_error_message
  )
  on conflict (apify_run_id) where apify_run_id is not null
  do nothing
  returning id into v_snapshot_id;

  if v_snapshot_id is null then
    return jsonb_build_object('inserted', false, 'duplicate', true);
  end if;

  return jsonb_build_object(
    'inserted', true,
    'duplicate', false,
    'snapshot_id', v_snapshot_id
  );
end;
$$;

revoke all on function public.apify_webhook_persist_ig_details(
  text, uuid, public.metric_status, timestamptz,
  int, int, int, boolean, jsonb, text
) from public;
revoke all on function public.apify_webhook_persist_ig_details(
  text, uuid, public.metric_status, timestamptz,
  int, int, int, boolean, jsonb, text
) from anon, authenticated;
grant execute on function public.apify_webhook_persist_ig_details(
  text, uuid, public.metric_status, timestamptz,
  int, int, int, boolean, jsonb, text
) to service_role;

comment on function public.apify_webhook_persist_ig_details(
  text, uuid, public.metric_status, timestamptz,
  int, int, int, boolean, jsonb, text
) is 'US-017 webhook persistence RPC for ig_details scrape_mode. Idempotent via partial unique index metric_snapshots_run_uniq on apify_run_id. Returns jsonb {inserted, duplicate, snapshot_id?}.';

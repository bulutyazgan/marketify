-- US-018 — RPC backing the apify-webhook edge function (ig_posts branch).
--
-- Contract: public.apify_webhook_persist_ig_posts(
--   p_run_id text, p_social_link_id uuid,
--   p_status public.metric_status, p_fetched_at timestamptz,
--   p_avg_views_last_10 int,
--   p_raw_payload jsonb, p_error_message text
-- ) returns jsonb:
--   {"inserted": true,  "duplicate": false, "snapshot_id": "<uuid>"}  on fresh insert
--   {"inserted": false, "duplicate": true}                              on ON CONFLICT no-op
--
-- Behavior: Inserts one public.metric_snapshots row keyed on apify_run_id with
--   scrape_mode='ig_posts'. The partial unique index metric_snapshots_run_uniq
--   (US-007) enforces webhook-delivery idempotency — a second webhook carrying
--   the same run_id hits ON CONFLICT DO NOTHING and returns duplicate=true.
--
--   ig_posts owns exactly one metric_snapshots column per
--   docs/tech-architecture.md §4.7 lines 576-581 comments:
--     avg_views_last_10
--   follower_count, following_count, total_likes, video_count, is_verified are
--   all left NULL (ig_details / tiktok_profile own them — see US-016/US-017).
--
--   On a fresh-status insert the US-007 BEFORE INSERT trigger trg_denorm_metrics
--   fires and — under the (social_link_id, scrape_mode) advisory lock — mirrors
--   into public.creator_profiles: instagram_avg_views_last_10, metrics_fetched_at
--   (guarded with greatest()). On a 'failed'-status row, denorm_metrics short-
--   circuits on new.status <> 'fresh', sets is_latest=false, skips the denorm
--   writes.
--
--   Spec §3c: when an Instagram profile has zero `type === "Video"` posts, the
--   edge function passes p_avg_views_last_10 = NULL. The denorm trigger writes
--   NULL into instagram_avg_views_last_10; the UI surfaces this as "Not enough
--   video posts to compute" and listings that gate on min_avg_views_last_n on
--   Instagram treat NULL as ineligible (fail-closed).
--
-- Auth: revoked from anon / authenticated / public. Granted only to
--   service_role (the edge function's client).
--
-- Spec gap handoff — US-020 pre-refreshing rows:
--   Same constraint as US-016/US-017: this RPC does pure INSERT + ON CONFLICT
--   DO NOTHING and does not transition a pre-existing 'refreshing' row. US-020
--   must extend this RPC (or the denorm trigger) to UPDATE-then-denorm before
--   pre-refreshing rows ship. Tracked in progress.txt Codebase Patterns.

create or replace function public.apify_webhook_persist_ig_posts(
  p_run_id text,
  p_social_link_id uuid,
  p_status public.metric_status,
  p_fetched_at timestamptz,
  p_avg_views_last_10 int,
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
    avg_views_last_10,
    raw_payload,
    fetched_at,
    error_message
  ) values (
    p_social_link_id,
    'ig_posts'::public.scrape_mode,
    p_run_id,
    p_status,
    p_avg_views_last_10,
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

revoke all on function public.apify_webhook_persist_ig_posts(
  text, uuid, public.metric_status, timestamptz, int, jsonb, text
) from public;
revoke all on function public.apify_webhook_persist_ig_posts(
  text, uuid, public.metric_status, timestamptz, int, jsonb, text
) from anon, authenticated;
grant execute on function public.apify_webhook_persist_ig_posts(
  text, uuid, public.metric_status, timestamptz, int, jsonb, text
) to service_role;

comment on function public.apify_webhook_persist_ig_posts(
  text, uuid, public.metric_status, timestamptz, int, jsonb, text
) is 'US-018 webhook persistence RPC for ig_posts scrape_mode. Idempotent via partial unique index metric_snapshots_run_uniq on apify_run_id. Returns jsonb {inserted, duplicate, snapshot_id?}.';

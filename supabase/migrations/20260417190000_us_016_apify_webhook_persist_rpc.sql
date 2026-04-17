-- US-016 — RPC backing the apify-webhook edge function (tiktok_profile branch).
--
-- Contract: public.apify_webhook_persist_tiktok_profile(
--   p_run_id text, p_social_link_id uuid,
--   p_status public.metric_status, p_fetched_at timestamptz,
--   p_follower_count int, p_following_count int,
--   p_total_likes bigint, p_video_count int,
--   p_avg_views_last_10 int, p_is_verified boolean,
--   p_raw_payload jsonb, p_error_message text
-- ) returns jsonb:
--   {"inserted": true,  "duplicate": false, "snapshot_id": "<uuid>"}  on fresh insert
--   {"inserted": false, "duplicate": true}                              on ON CONFLICT no-op
--
-- Behavior: Inserts one public.metric_snapshots row keyed on apify_run_id.
--   The partial unique index metric_snapshots_run_uniq (US-007) enforces
--   webhook-delivery idempotency: a second webhook carrying the same run_id
--   hits ON CONFLICT DO NOTHING and returns duplicate=true.
--
--   When a fresh 'fresh'-status row is inserted, the US-007 BEFORE INSERT
--   trigger trg_denorm_metrics fires — advisory-lock serialized — and mirrors
--   the tiktok_profile denorm columns to public.creator_profiles. When a
--   'failed'-status row is inserted, denorm_metrics short-circuits on
--   new.status <> 'fresh', sets is_latest=false, and skips the denorm
--   writes. That is the spec's design for retry-by-next-cron behavior.
--
-- Auth: revoked from anon / authenticated / public. Granted only to
--   service_role (the edge function's client).
--
-- Spec gap handoff — US-020 pre-refreshing rows:
--   US-020 (auth-signup-creator Apify dispatch) will pre-create metric_snapshots
--   rows in status='refreshing' before the webhook arrives, so the Apify run's
--   run_id is attached from dispatch time. This RPC does NOT currently detect
--   and transition a pre-existing 'refreshing' row — ON CONFLICT DO NOTHING
--   would no-op and the row would stay 'refreshing' until the fail-stuck-
--   refreshing janitor cron (Codebase Pattern §16 spec gap) flips it to
--   'failed'. US-020 must extend either this RPC (to UPDATE-then-INSERT) or the
--   app_private.denorm_metrics trigger (to also fire BEFORE UPDATE) before
--   pre-refreshing rows ship. Tracked in progress.txt Codebase Patterns.

create or replace function public.apify_webhook_persist_tiktok_profile(
  p_run_id text,
  p_social_link_id uuid,
  p_status public.metric_status,
  p_fetched_at timestamptz,
  p_follower_count int,
  p_following_count int,
  p_total_likes bigint,
  p_video_count int,
  p_avg_views_last_10 int,
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
    total_likes,
    video_count,
    avg_views_last_10,
    is_verified,
    raw_payload,
    fetched_at,
    error_message
  ) values (
    p_social_link_id,
    'tiktok_profile'::public.scrape_mode,
    p_run_id,
    p_status,
    p_follower_count,
    p_following_count,
    p_total_likes,
    p_video_count,
    p_avg_views_last_10,
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

revoke all on function public.apify_webhook_persist_tiktok_profile(
  text, uuid, public.metric_status, timestamptz,
  int, int, bigint, int, int, boolean, jsonb, text
) from public;
revoke all on function public.apify_webhook_persist_tiktok_profile(
  text, uuid, public.metric_status, timestamptz,
  int, int, bigint, int, int, boolean, jsonb, text
) from anon, authenticated;
grant execute on function public.apify_webhook_persist_tiktok_profile(
  text, uuid, public.metric_status, timestamptz,
  int, int, bigint, int, int, boolean, jsonb, text
) to service_role;

comment on function public.apify_webhook_persist_tiktok_profile(
  text, uuid, public.metric_status, timestamptz,
  int, int, bigint, int, int, boolean, jsonb, text
) is 'US-016 webhook persistence RPC for tiktok_profile scrape_mode. Idempotent via partial unique index metric_snapshots_run_uniq on apify_run_id. Returns jsonb {inserted, duplicate, snapshot_id?}.';

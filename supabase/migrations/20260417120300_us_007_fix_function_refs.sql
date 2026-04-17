-- US-007 follow-up #3: fix the previous requalification.
--
-- us_007_qualify_function_refs incorrectly schema-qualified `greatest()` and
-- `now()` as `pg_catalog.<fn>()`. `GREATEST` is a SQL parser construct, not a
-- callable function, so `pg_catalog.greatest(...)` raises 42883 at trigger
-- fire time. `now()` lives in pg_catalog and resolves bare even when the
-- user-set search_path is empty (pg_catalog is always implicitly searched).
--
-- This migration recreates both functions with bare `greatest()` / `now()`
-- and re-asserts `set search_path = ''` (CREATE OR REPLACE FUNCTION drops
-- prior SET clauses).

create or replace function app_private.check_metric_snapshot_coherence()
returns trigger
language plpgsql
set search_path = ''
as $$
declare p public.platform;
begin
  select sl.platform into p from public.social_links sl where sl.id = new.social_link_id;
  if p is null then
    raise exception 'social_link % not found', new.social_link_id;
  end if;
  if (p = 'tiktok'::public.platform
        and new.scrape_mode <> 'tiktok_profile'::public.scrape_mode)
  or (p = 'instagram'::public.platform
        and new.scrape_mode not in ('ig_details'::public.scrape_mode, 'ig_posts'::public.scrape_mode)) then
    raise exception 'scrape_mode % incoherent with platform %', new.scrape_mode, p;
  end if;
  return new;
end $$;

create or replace function app_private.denorm_metrics()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  sl       public.social_links%rowtype;
  lock_key bigint;
begin
  if new.status <> 'fresh'::public.metric_status then
    new.is_latest := false;
    return new;
  end if;

  lock_key := pg_catalog.hashtextextended(new.social_link_id::text || ':' || new.scrape_mode::text, 0);
  perform pg_catalog.pg_advisory_xact_lock(lock_key);

  update public.metric_snapshots
     set is_latest = false
   where social_link_id = new.social_link_id
     and scrape_mode    = new.scrape_mode
     and is_latest;

  new.is_latest := true;

  select * into sl from public.social_links where id = new.social_link_id;

  if new.scrape_mode = 'tiktok_profile'::public.scrape_mode then
    update public.creator_profiles
       set tiktok_follower_count    = new.follower_count,
           tiktok_avg_views_last_10 = new.avg_views_last_10,
           tiktok_total_likes       = new.total_likes,
           tiktok_video_count       = new.video_count,
           tiktok_is_verified       = new.is_verified,
           metrics_fetched_at       = greatest(metrics_fetched_at, new.fetched_at),
           updated_at               = now()
     where user_id = sl.user_id;

  elsif new.scrape_mode = 'ig_details'::public.scrape_mode then
    update public.creator_profiles
       set instagram_follower_count = new.follower_count,
           instagram_media_count    = new.video_count,
           metrics_fetched_at       = greatest(metrics_fetched_at, new.fetched_at),
           updated_at               = now()
     where user_id = sl.user_id;

  elsif new.scrape_mode = 'ig_posts'::public.scrape_mode then
    update public.creator_profiles
       set instagram_avg_views_last_10 = new.avg_views_last_10,
           metrics_fetched_at          = greatest(metrics_fetched_at, new.fetched_at),
           updated_at                  = now()
     where user_id = sl.user_id;
  end if;

  return new;
end $$;

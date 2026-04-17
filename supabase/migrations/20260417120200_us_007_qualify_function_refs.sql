-- US-007 follow-up #2: requalify trigger function bodies for empty search_path.
--
-- The previous migration set `search_path = ''` on both trigger functions to
-- clear the `function_search_path_mutable` advisor. With an empty search_path,
-- unqualified user-defined types (e.g. `platform`, `scrape_mode`) no longer
-- resolve. We rewrite both function bodies with `public.<type>` casts on enum
-- literals and `pg_catalog.<fn>` on built-ins. Restating `set search_path = ''`
-- because CREATE OR REPLACE FUNCTION does not preserve prior SET clauses.
--
-- NOTE: this version qualifies `greatest()` and `now()` as `pg_catalog.*`,
-- which is INCORRECT — `GREATEST` is a SQL parser built-in (not a callable
-- function) and cannot be schema-qualified. The runtime error surfaces only
-- when the trigger fires on a fresh tiktok_profile row. Fixed in
-- us_007_fix_function_refs (the next migration).

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
           metrics_fetched_at       = pg_catalog.greatest(metrics_fetched_at, new.fetched_at),
           updated_at               = pg_catalog.now()
     where user_id = sl.user_id;

  elsif new.scrape_mode = 'ig_details'::public.scrape_mode then
    update public.creator_profiles
       set instagram_follower_count = new.follower_count,
           instagram_media_count    = new.video_count,
           metrics_fetched_at       = pg_catalog.greatest(metrics_fetched_at, new.fetched_at),
           updated_at               = pg_catalog.now()
     where user_id = sl.user_id;

  elsif new.scrape_mode = 'ig_posts'::public.scrape_mode then
    update public.creator_profiles
       set instagram_avg_views_last_10 = new.avg_views_last_10,
           metrics_fetched_at          = pg_catalog.greatest(metrics_fetched_at, new.fetched_at),
           updated_at                  = pg_catalog.now()
     where user_id = sl.user_id;
  end if;

  return new;
end $$;

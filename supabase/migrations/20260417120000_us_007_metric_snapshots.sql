-- US-007: metric_snapshots + denormalization trigger.
--
-- Per docs/tech-architecture.md §4.7 block 6 (lines 564-597) and the trigger
-- definitions in §15 (lines 1205-1291).
--
-- Three pieces:
--   1. public.metric_snapshots — historized rows, one per Apify run.
--   2. app_private.check_metric_snapshot_coherence — BEFORE INSERT/UPDATE
--      trigger ensuring scrape_mode matches the linked social_link.platform.
--   3. app_private.denorm_metrics — BEFORE INSERT trigger that, for fresh
--      rows, demotes the previous latest under a (social_link, scrape_mode)
--      advisory lock and mirrors the owned columns into creator_profiles.
--
-- Spec gap (story text vs. spec DDL): the story acceptance criterion says the
-- advisory lock is keyed on (user_id, scrape_mode); the spec keys it on
-- (social_link_id, scrape_mode). The two are functionally equivalent because
-- social_links has a partial unique index on (user_id, platform). Following
-- the spec verbatim.

-- =========================================================
-- 1. metric_snapshots table
-- =========================================================
create table public.metric_snapshots (
  id                uuid primary key default gen_random_uuid(),
  social_link_id    uuid not null references public.social_links(id) on delete cascade,
  scrape_mode       scrape_mode not null,
  apify_run_id      text,
  status            metric_status not null,
  follower_count    integer,
  following_count   integer,
  total_likes       bigint,
  video_count       integer,
  avg_views_last_10 integer,
  is_verified       boolean,
  raw_payload       jsonb,
  fetched_at        timestamptz not null default now(),
  is_latest         boolean not null default false,
  error_message     text
);

create index on public.metric_snapshots (social_link_id, fetched_at desc);

-- Only one "latest" snapshot per (social_link, scrape_mode); IG has at most two.
create unique index metric_snapshots_latest
  on public.metric_snapshots (social_link_id, scrape_mode) where is_latest;

-- Idempotency for webhook redeliveries — same Apify run never inserts twice.
create unique index metric_snapshots_run_uniq
  on public.metric_snapshots (apify_run_id) where apify_run_id is not null;

-- Janitor cron `fail-stuck-refreshing` scans here. Partial keeps it sub-ms.
create index metric_snapshots_stuck_idx
  on public.metric_snapshots (fetched_at) where status = 'refreshing';

-- =========================================================
-- 2. Coherence trigger: scrape_mode ↔ social_link.platform
-- =========================================================
create or replace function app_private.check_metric_snapshot_coherence()
returns trigger language plpgsql as $$
declare p platform;
begin
  select platform into p from public.social_links where id = new.social_link_id;
  if p is null then
    raise exception 'social_link % not found', new.social_link_id;
  end if;
  if (p = 'tiktok'    and new.scrape_mode <> 'tiktok_profile')
  or (p = 'instagram' and new.scrape_mode not in ('ig_details', 'ig_posts')) then
    raise exception 'scrape_mode % incoherent with platform %', new.scrape_mode, p;
  end if;
  return new;
end $$;

create trigger trg_metric_snapshots_coherence
  before insert or update of scrape_mode, social_link_id on public.metric_snapshots
  for each row execute function app_private.check_metric_snapshot_coherence();

-- =========================================================
-- 3. Race-free latest-row promotion + denormalization trigger
-- =========================================================
-- BEFORE INSERT so we can mutate new.is_latest; advisory lock serializes
-- concurrent webhook deliveries / manual refreshes for the same
-- (social_link, scrape_mode) pair.
create or replace function app_private.denorm_metrics()
returns trigger language plpgsql security definer as $$
declare
  sl       public.social_links%rowtype;
  lock_key bigint;
begin
  if new.status <> 'fresh' then
    -- 'refreshing' and 'failed' rows never become latest, never denormalize.
    new.is_latest := false;
    return new;
  end if;

  lock_key := hashtextextended(new.social_link_id::text || ':' || new.scrape_mode::text, 0);
  perform pg_advisory_xact_lock(lock_key);

  update public.metric_snapshots
     set is_latest = false
   where social_link_id = new.social_link_id
     and scrape_mode    = new.scrape_mode
     and is_latest;

  new.is_latest := true;

  select * into sl from public.social_links where id = new.social_link_id;

  if new.scrape_mode = 'tiktok_profile' then
    update public.creator_profiles
       set tiktok_follower_count    = new.follower_count,
           tiktok_avg_views_last_10 = new.avg_views_last_10,
           tiktok_total_likes       = new.total_likes,
           tiktok_video_count       = new.video_count,
           tiktok_is_verified       = new.is_verified,
           metrics_fetched_at       = greatest(metrics_fetched_at, new.fetched_at),
           updated_at               = now()
     where user_id = sl.user_id;

  elsif new.scrape_mode = 'ig_details' then
    update public.creator_profiles
       set instagram_follower_count = new.follower_count,
           instagram_media_count    = new.video_count,
           metrics_fetched_at       = greatest(metrics_fetched_at, new.fetched_at),
           updated_at               = now()
     where user_id = sl.user_id;

  elsif new.scrape_mode = 'ig_posts' then
    update public.creator_profiles
       set instagram_avg_views_last_10 = new.avg_views_last_10,
           metrics_fetched_at          = greatest(metrics_fetched_at, new.fetched_at),
           updated_at                  = now()
     where user_id = sl.user_id;
  end if;

  return new;
end $$;

create trigger trg_denorm_metrics
  before insert on public.metric_snapshots
  for each row execute function app_private.denorm_metrics();

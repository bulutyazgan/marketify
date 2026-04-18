-- US-035b: clear denorm cache + drop snapshots when unlinking a social link.
--
-- The original us_035 unlink path only flipped social_links.status='unlinked'
-- (soft-delete). Two consequences in production:
--   1. creator_profiles.<platform>_* denorm columns kept the unlinked
--      account's numbers — and the creator profile screen reads from that
--      denorm cache directly. Re-linking a different handle on the same
--      platform left the OLD numbers visible until a fresh scrape on the new
--      handle landed (and indefinitely if the scrape was slow / failed).
--   2. metric_snapshots rows tied to the unlinked link never went away —
--      the FK is on-delete-cascade but soft-delete bypasses it.
--
-- This migration:
--   (a) Replaces public.manage_social_link to delete metric_snapshots and NULL
--       the platform's denorm columns inside the same transaction as the
--       social_links update.
--   (b) Backfills the existing data: drops snapshots for already-unlinked
--       links, then for each (user, platform) recomputes the denorm cache
--       from the most-recent fresh snapshot of the currently-active link
--       (or NULLs it if no active link / no fresh snapshot).

create or replace function public.manage_social_link(
  p_user_id uuid,
  p_action text,
  p_platform public.platform default null,
  p_handle extensions.citext default null,
  p_social_link_id uuid default null
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_new_id            uuid;
  v_unlinked_platform public.platform;
  v_constraint        text;
begin
  if p_action = 'add' then
    if p_platform is null or p_handle is null or length(trim(p_handle::text)) = 0 then
      return jsonb_build_object('error', 'INVALID_REQUEST');
    end if;

    insert into public.social_links (user_id, platform, handle)
    values (p_user_id, p_platform, p_handle)
    returning id into v_new_id;
    return jsonb_build_object('social_link_id', v_new_id);

  elsif p_action = 'unlink' then
    if p_social_link_id is null then
      return jsonb_build_object('error', 'INVALID_REQUEST');
    end if;

    update public.social_links
       set status     = 'unlinked'::public.social_link_status,
           updated_at = pg_catalog.now()
     where id        = p_social_link_id
       and user_id   = p_user_id
       and status    <> 'unlinked'::public.social_link_status
     returning platform into v_unlinked_platform;

    if v_unlinked_platform is null then
      return jsonb_build_object('error', 'LINK_NOT_FOUND');
    end if;

    -- Drop snapshots tied to the now-unlinked link. Soft-delete bypasses the
    -- FK on-delete-cascade, so without this they accumulate as cruft.
    delete from public.metric_snapshots
     where social_link_id = p_social_link_id;

    -- Reset the platform's denorm cache so the profile screen stops showing
    -- the old account's numbers between unlink and the next successful scrape.
    if v_unlinked_platform = 'tiktok'::public.platform then
      update public.creator_profiles
         set tiktok_follower_count    = null,
             tiktok_avg_views_last_10 = null,
             tiktok_total_likes       = null,
             tiktok_video_count       = null,
             tiktok_is_verified       = null,
             updated_at               = pg_catalog.now()
       where user_id = p_user_id;
    elsif v_unlinked_platform = 'instagram'::public.platform then
      update public.creator_profiles
         set instagram_follower_count    = null,
             instagram_avg_views_last_10 = null,
             instagram_media_count       = null,
             updated_at                  = pg_catalog.now()
       where user_id = p_user_id;
    end if;

    return jsonb_build_object('ok', true);

  else
    return jsonb_build_object('error', 'INVALID_REQUEST');
  end if;

exception
  when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint = 'social_links_user_platform_uniq' then
      return jsonb_build_object('error', 'ALREADY_LINKED');
    elsif v_constraint = 'social_links_platform_handle_uniq' then
      return jsonb_build_object('error', 'HANDLE_TAKEN');
    else
      raise;
    end if;
end;
$$;

comment on function public.manage_social_link(
  uuid, text, public.platform, extensions.citext, uuid
) is 'US-035 manage-social-link RPC. Add inserts a social_links row; unlink soft-deletes (status=unlinked), drops snapshots for that link, and resets the platform denorm cache on creator_profiles. Service_role only.';

-- ---- One-shot heal of pre-existing rows -------------------------------

-- (1) Drop snapshots tied to already-unlinked links.
delete from public.metric_snapshots ms
 using public.social_links sl
 where ms.social_link_id = sl.id
   and sl.status = 'unlinked'::public.social_link_status;

-- (2) Recompute TikTok denorm from the latest fresh tiktok_profile snapshot
--     of each user's active TikTok link.
with active_tt_latest as (
  select sl.user_id,
         ms.follower_count, ms.avg_views_last_10, ms.total_likes,
         ms.video_count, ms.is_verified, ms.fetched_at,
         row_number() over (
           partition by sl.user_id
           order by ms.fetched_at desc
         ) as rn
  from public.social_links sl
  join public.metric_snapshots ms on ms.social_link_id = sl.id
  where sl.platform   = 'tiktok'::public.platform
    and sl.status     <> 'unlinked'::public.social_link_status
    and ms.scrape_mode = 'tiktok_profile'::public.scrape_mode
    and ms.status      = 'fresh'::public.metric_status
)
update public.creator_profiles cp
   set tiktok_follower_count    = a.follower_count,
       tiktok_avg_views_last_10 = a.avg_views_last_10,
       tiktok_total_likes       = a.total_likes,
       tiktok_video_count       = a.video_count,
       tiktok_is_verified       = a.is_verified,
       metrics_fetched_at       = greatest(cp.metrics_fetched_at, a.fetched_at),
       updated_at               = now()
  from active_tt_latest a
 where a.user_id = cp.user_id
   and a.rn      = 1;

-- (3) NULL TikTok denorm for users with no active TikTok link at all.
update public.creator_profiles cp
   set tiktok_follower_count    = null,
       tiktok_avg_views_last_10 = null,
       tiktok_total_likes       = null,
       tiktok_video_count       = null,
       tiktok_is_verified       = null,
       updated_at               = now()
 where not exists (
   select 1 from public.social_links sl
    where sl.user_id  = cp.user_id
      and sl.platform = 'tiktok'::public.platform
      and sl.status   <> 'unlinked'::public.social_link_status
 )
 and (cp.tiktok_follower_count    is not null
   or cp.tiktok_avg_views_last_10 is not null
   or cp.tiktok_total_likes       is not null
   or cp.tiktok_video_count       is not null
   or cp.tiktok_is_verified       is not null);

-- (4) Recompute Instagram details denorm (follower_count + media_count)
--     from the latest fresh ig_details snapshot.
with active_igd_latest as (
  select sl.user_id, ms.follower_count, ms.video_count, ms.fetched_at,
         row_number() over (
           partition by sl.user_id
           order by ms.fetched_at desc
         ) as rn
  from public.social_links sl
  join public.metric_snapshots ms on ms.social_link_id = sl.id
  where sl.platform   = 'instagram'::public.platform
    and sl.status     <> 'unlinked'::public.social_link_status
    and ms.scrape_mode = 'ig_details'::public.scrape_mode
    and ms.status      = 'fresh'::public.metric_status
)
update public.creator_profiles cp
   set instagram_follower_count = a.follower_count,
       instagram_media_count    = a.video_count,
       metrics_fetched_at       = greatest(cp.metrics_fetched_at, a.fetched_at),
       updated_at               = now()
  from active_igd_latest a
 where a.user_id = cp.user_id
   and a.rn      = 1;

-- (5) Recompute Instagram avg_views_last_10 from the latest fresh ig_posts
--     snapshot (separate scrape_mode, separate trigger branch).
with active_igp_latest as (
  select sl.user_id, ms.avg_views_last_10, ms.fetched_at,
         row_number() over (
           partition by sl.user_id
           order by ms.fetched_at desc
         ) as rn
  from public.social_links sl
  join public.metric_snapshots ms on ms.social_link_id = sl.id
  where sl.platform   = 'instagram'::public.platform
    and sl.status     <> 'unlinked'::public.social_link_status
    and ms.scrape_mode = 'ig_posts'::public.scrape_mode
    and ms.status      = 'fresh'::public.metric_status
)
update public.creator_profiles cp
   set instagram_avg_views_last_10 = a.avg_views_last_10,
       metrics_fetched_at          = greatest(cp.metrics_fetched_at, a.fetched_at),
       updated_at                  = now()
  from active_igp_latest a
 where a.user_id = cp.user_id
   and a.rn      = 1;

-- (6) NULL Instagram denorm for users with no active Instagram link.
update public.creator_profiles cp
   set instagram_follower_count    = null,
       instagram_avg_views_last_10 = null,
       instagram_media_count       = null,
       updated_at                  = now()
 where not exists (
   select 1 from public.social_links sl
    where sl.user_id  = cp.user_id
      and sl.platform = 'instagram'::public.platform
      and sl.status   <> 'unlinked'::public.social_link_status
 )
 and (cp.instagram_follower_count    is not null
   or cp.instagram_avg_views_last_10 is not null
   or cp.instagram_media_count       is not null);

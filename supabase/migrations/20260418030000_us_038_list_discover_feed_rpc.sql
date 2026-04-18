-- US-038 — SECURITY DEFINER function `list_discover_feed(p_eligible_only)` that
-- returns active listings joined to users (lister handle) with optional
-- eligibility filtering against the caller's creator_profiles cache columns.
--
-- Why a DEFINER RPC instead of a PostgREST .select('...,users!lister_id(username)')
-- embed: `users_self_select` (us_009) restricts selects to the caller's own row,
-- so an embed would silently null every lister_handle in the feed. Pattern #117
-- documents the failure mode; pattern #118 is the reusable skeleton.
--
-- Eligibility filter (when p_eligible_only = true) mirrors the Discover feed AC:
-- status = 'active' AND min_followers_tiktok <= creator.tiktok_follower_count
-- AND min_followers_instagram <= creator.instagram_follower_count, with null
-- thresholds treated as 0 (no requirement) and null creator metrics treated as
-- 0 (non-linked platform fails any non-zero threshold — matches the eligibility
-- engine's "fail-closed on null actual" rule in _shared/eligibility.ts).
--
-- Execute granted to `authenticated` only; anon/public revoked. Listers hitting
-- this function would get zero eligible rows (no creator_profiles row → all
-- metrics coalesce to 0) but that's moot — the (creator) route group layout
-- gates the feed screen behind role='creator'.

create or replace function public.list_discover_feed(p_eligible_only boolean default true)
returns table (
  id                       uuid,
  title                    text,
  price_cents              integer,
  currency                 text,
  lister_handle            text,
  min_followers_tiktok     integer,
  min_followers_instagram  integer,
  created_at               timestamptz
)
language sql
security definer
stable
set search_path = ''
as $$
  select l.id,
         l.title,
         l.price_cents,
         l.currency,
         u.username::text as lister_handle,
         l.min_followers_tiktok,
         l.min_followers_instagram,
         l.created_at
  from public.listings l
  join public.users u on u.id = l.lister_id
  left join public.creator_profiles cp on cp.user_id = public.current_user_id()
  where l.status = 'active'
    and (
      not p_eligible_only
      or (
        coalesce(l.min_followers_tiktok, 0) <= coalesce(cp.tiktok_follower_count, 0)
        and coalesce(l.min_followers_instagram, 0) <= coalesce(cp.instagram_follower_count, 0)
      )
    )
  order by l.created_at desc;
$$;

revoke all on function public.list_discover_feed(boolean) from public;
revoke all on function public.list_discover_feed(boolean) from anon;
grant execute on function public.list_discover_feed(boolean) to authenticated;

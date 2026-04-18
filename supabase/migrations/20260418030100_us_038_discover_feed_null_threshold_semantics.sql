-- US-038 follow-up — align the `list_discover_feed` eligibility predicate with
-- the canonical feed query in docs/tech-architecture.md §6.4 (lines 1872-1873).
--
-- Original us_038 migration used `coalesce(l.min_followers_tiktok, 0) <=
-- coalesce(cp.tiktok_follower_count, 0)` which conflates a "null threshold"
-- (no requirement) with a "zero threshold" (explicit 0-follower requirement).
-- The spec pattern is `(threshold is null or threshold <= creator_metric)`
-- which preserves the distinction — a null threshold short-circuits true,
-- an explicit-zero threshold still evaluates the right-hand comparison.
--
-- The btree partial indexes on these columns target the `<=` comparison
-- directly so this form is also what the query planner is optimised for.

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
        (l.min_followers_tiktok is null
         or l.min_followers_tiktok <= coalesce(cp.tiktok_follower_count, 0))
        and (l.min_followers_instagram is null
         or l.min_followers_instagram <= coalesce(cp.instagram_follower_count, 0))
      )
    )
  order by l.created_at desc;
$$;

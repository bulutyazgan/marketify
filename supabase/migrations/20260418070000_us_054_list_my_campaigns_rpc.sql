-- US-054 — "My Campaigns" screen RPC.
--
-- Contract: `public.list_my_campaigns()` returns the caller's listings
-- (filtered to `lister_id = public.current_user_id()`) plus per-listing
-- aggregate counts for applications and submissions. Called by
-- `app/(lister)/campaigns.tsx` which buckets rows into two segments:
-- Active (status='active') vs Inactive (draft/paused/closed/archived).
--
-- Why SECURITY DEFINER + explicit ownership check (not SECURITY INVOKER):
-- the aggregate sub-selects traverse `applications` + `submissions` tables
-- that the lister has RLS read access to (polcmd='r' on applications_lister_read
-- / submissions_lister_read join through listings.lister_id), so INVOKER
-- would technically work today. DEFINER is chosen to mirror the US-043
-- `list_my_applications` precedent (Codebase Pattern #118) and to make
-- the count semantics stable regardless of future RLS tightening — the
-- function's own `where lister_id = current_user_id()` remains the single
-- authoritative gate. Revoke from anon/public; grant execute to authenticated.
--
-- Columns returned:
--   id, status — listings primary key + status enum (UI splits on this)
--   title — current title (listings.title, not the version snapshot; both
--     stay in sync via the bump trigger)
--   price_cents, currency — for CampaignCard footer
--   min_followers_tiktok, min_followers_instagram — cache columns populated
--     by the §15b threshold-refresh trigger; null when no threshold is set
--   applications_count — total applications against this listing, ALL statuses
--   submissions_count — total submissions against this listing, ALL statuses
--   created_at, updated_at — used for ordering
--
-- Ordering: `updated_at desc, created_at desc` — most recently edited first,
-- consistent with "My Applications" recency-first ordering (US-043). Ties
-- broken by creation order.
--
-- Codebase Patterns referenced:
--   #118 SECURITY DEFINER + ownership-check list-my-rows skeleton
--   #119 `list_my_<things>` naming convention; argumentless; public schema
--   #42  `set search_path = ''` + schema-qualify every user-defined ref
--   #39  reuses `public.current_user_id()` helper

create or replace function public.list_my_campaigns()
returns table (
  id                        uuid,
  status                    public.listing_status,
  title                     text,
  price_cents               integer,
  currency                  text,
  min_followers_tiktok      integer,
  min_followers_instagram   integer,
  applications_count        integer,
  submissions_count         integer,
  created_at                timestamptz,
  updated_at                timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select l.id,
         l.status,
         l.title,
         l.price_cents,
         l.currency,
         l.min_followers_tiktok,
         l.min_followers_instagram,
         (
           select count(*)::integer
           from public.applications a
           where a.listing_id = l.id
         ) as applications_count,
         (
           select count(*)::integer
           from public.submissions s
           join public.applications a2 on a2.id = s.application_id
           where a2.listing_id = l.id
         ) as submissions_count,
         l.created_at,
         l.updated_at
  from public.listings l
  where l.lister_id = public.current_user_id()
  order by l.updated_at desc, l.created_at desc;
$$;

revoke all on function public.list_my_campaigns() from public;
revoke all on function public.list_my_campaigns() from anon;
grant execute on function public.list_my_campaigns() to authenticated;

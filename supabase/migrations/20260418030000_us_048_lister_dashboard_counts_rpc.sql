-- US-048 — Lister Home/dashboard screen counts RPC.
--
-- Contract: `public.lister_dashboard_counts()` returns a single row with
-- three integer columns: active_campaigns, pending_applications,
-- pending_submissions. Called by app/(lister)/dashboard.tsx to populate the
-- stat tiles per docs/design.md §2.3 (Dashboard = "Stat tiles + recent
-- activity", v1 scope = counts only per docs/product-plan.md line 124).
--
-- Why a SECURITY INVOKER RPC instead of three PostgREST count queries:
-- (1) single round-trip, atomic numbers rendered together — no race where
--     the two counts disagree because they were fetched 20ms apart; (2)
--     typed via generated Supabase types (Functions.lister_dashboard_counts)
--     so the caller gets column names, not row counts pulled out of a
--     Range header; (3) SECURITY INVOKER preserves RLS — the three policy
--     gates (`listings_lister_all`, `applications_lister_read`,
--     `submissions_lister_read`) still apply, AND we repeat the
--     `lister_id = public.current_user_id()` filter as a belt-and-suspenders
--     guarantee so a future RLS regression doesn't silently inflate the
--     counts with other listers' rows.
--
-- Relationship to Codebase Patterns:
-- - Pattern #119 naming convention: `lister_dashboard_counts` is a
--   caller-scoped read; argumentless (caller implicit via
--   current_user_id()); lives in `public` so PostgREST `supabase.rpc(...)`
--   can reach it.
-- - Pattern #42: `set search_path = ''` + schema-qualify everything, even
--   though SQL functions don't have the PL/pgSQL GREATEST gotcha; enum
--   casts are written `'active'::public.listing_status` so they resolve
--   correctly under the empty search_path.
-- - Pattern #39: reuses `public.current_user_id()` (reads the `sub` claim
--   off auth.jwt()) — same mechanism every caller-scoped query uses.

create or replace function public.lister_dashboard_counts()
returns table(
  active_campaigns integer,
  pending_applications integer,
  pending_submissions integer
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    (
      select count(*)::integer
      from public.listings l
      where l.lister_id = public.current_user_id()
        and l.status = 'active'::public.listing_status
    ) as active_campaigns,
    (
      select count(*)::integer
      from public.applications a
      join public.listings l on l.id = a.listing_id
      where l.lister_id = public.current_user_id()
        and a.status = 'pending'::public.application_status
    ) as pending_applications,
    (
      select count(*)::integer
      from public.submissions s
      join public.applications a on a.id = s.application_id
      join public.listings l on l.id = a.listing_id
      where l.lister_id = public.current_user_id()
        and s.status = 'pending'::public.submission_status
    ) as pending_submissions
$$;

revoke all on function public.lister_dashboard_counts() from public;
revoke all on function public.lister_dashboard_counts() from anon;
grant execute on function public.lister_dashboard_counts() to authenticated;

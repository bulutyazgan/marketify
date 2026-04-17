-- US-043 — SECURITY DEFINER function `list_my_applications()` that returns
-- the caller's applications joined to listings + users (lister handle) +
-- listing_versions (snapshot title). Created because the direct
-- PostgREST embed silently nulls `users.username` (users RLS is self-only)
-- and `listings`/`listing_versions` are both gated on listing.status =
-- 'active' — so cancelled / rejected-against-closed rows would render
-- without title or handle under a raw .select().
--
-- Ownership is enforced inside the function via public.current_user_id()
-- (JWT sub claim). Execute is granted to `authenticated` only; anon and
-- service_role are not granted (service_role already has BYPASSRLS and
-- wouldn't use this shape anyway).
--
-- Codebase pattern ref: progress.txt #40 (submission_reuse_count) and
-- #110 (apply_to_listing_rpc) — the SECURITY DEFINER-with-ownership-check
-- pattern for cross-tenant reads that cannot be expressed cleanly via
-- per-row RLS.

create or replace function public.list_my_applications()
returns table (
  id              uuid,
  status          public.application_status,
  created_at      timestamptz,
  listing_id      uuid,
  listing_title   text,
  lister_handle   text,
  version_title   text
)
language sql
security definer
stable
set search_path = ''
as $$
  select a.id,
         a.status,
         a.created_at,
         a.listing_id,
         l.title as listing_title,
         u.username::text as lister_handle,
         (lv.snapshot ->> 'title') as version_title
  from public.applications a
  left join public.listings l         on l.id = a.listing_id
  left join public.users u            on u.id = l.lister_id
  left join public.listing_versions lv on lv.id = a.listing_version_id
  where a.creator_id = public.current_user_id()
  order by a.created_at desc;
$$;

revoke all on function public.list_my_applications() from public;
revoke all on function public.list_my_applications() from anon;
grant execute on function public.list_my_applications() to authenticated;

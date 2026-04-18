-- US-046 — SECURITY DEFINER function `get_my_application_for_submit(p_application_id)`
-- that returns the single-application context the composer screen needs:
-- application row (status + listing_version_id), the listing title (current
-- + version-snapshot fallback), the lister handle, and the post-kind
-- listing_conditions pinned to the application's listing_version_id.
--
-- Cross-RLS rationale (mirrors US-043 list_my_applications): `users` is
-- self-only under users_select_self_only so a raw PostgREST embed silently
-- nulls the lister handle; `listing_conditions` is gated on
-- listing.status='active' (listing_conditions_read_if_version_readable)
-- so a creator whose listing has been paused/closed after approval can't
-- read the conditions directly — but the composer must still render the
-- post-condition checklist so the server-side submit-video RPC's
-- INCOMPLETE_AFFIRMATIONS gate has something to check against.
--
-- Ownership enforced inside the function via public.current_user_id()
-- (JWT sub claim). Execute is granted to `authenticated`; anon and
-- service_role are not granted (service_role already has BYPASSRLS).
--
-- Codebase pattern ref: progress.txt #40 (submission_reuse_count) and the
-- list_my_applications RPC (20260418010100) — SECURITY-DEFINER-with-ownership
-- for cross-tenant reads that per-row RLS can't express cleanly.

create or replace function public.get_my_application_for_submit(p_application_id uuid)
returns table (
  application_id       uuid,
  application_status   public.application_status,
  listing_id           uuid,
  listing_version_id   uuid,
  listing_title        text,
  version_title        text,
  lister_handle        text,
  post_conditions      jsonb
)
language sql
security definer
stable
set search_path = ''
as $$
  select a.id                                   as application_id,
         a.status                               as application_status,
         a.listing_id,
         a.listing_version_id,
         l.title                                as listing_title,
         (lv.snapshot ->> 'title')              as version_title,
         u.username::text                       as lister_handle,
         coalesce((
           select jsonb_agg(
             jsonb_build_object(
               'id',                c.id,
               'metric',             c.metric,
               'operator',           c.operator,
               'numeric_threshold',  c.numeric_threshold,
               'text_threshold',     c.text_threshold,
               'bool_threshold',     c.bool_threshold,
               'platform',           c.platform
             )
             order by c.created_at
           )
           from public.listing_conditions c
           where c.listing_version_id = a.listing_version_id
             and c.kind = 'post'::public.condition_kind
         ), '[]'::jsonb)                        as post_conditions
    from public.applications a
    left join public.listings l           on l.id  = a.listing_id
    left join public.users u              on u.id  = l.lister_id
    left join public.listing_versions lv  on lv.id = a.listing_version_id
   where a.id = p_application_id
     and a.creator_id = public.current_user_id();
$$;

revoke all on function public.get_my_application_for_submit(uuid) from public;
revoke all on function public.get_my_application_for_submit(uuid) from anon;
grant execute on function public.get_my_application_for_submit(uuid) to authenticated;

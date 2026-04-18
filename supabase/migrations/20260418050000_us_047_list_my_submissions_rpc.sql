-- US-047 — SECURITY DEFINER function `list_my_submissions()` that returns
-- the caller's submissions joined to applications + listings + users
-- (lister handle) + listing_versions (snapshot title) + submission_videos
-- (first video by sort_order). Mirrors the US-043 `list_my_applications`
-- pattern for the same reasons: a raw PostgREST embed would silently null
-- `users.username` (users RLS is self-only) and listing_versions rows for
-- closed/cancelled listings (listing_versions RLS is gated on listing
-- status). Ownership is enforced inside the function via
-- public.current_user_id() (JWT sub claim) traversed through
-- submissions → applications.creator_id.
--
-- Execute is granted to `authenticated` only; anon and service_role are
-- not granted.

create or replace function public.list_my_submissions()
returns table (
  id               uuid,
  status           public.submission_status,
  created_at       timestamptz,
  application_id   uuid,
  listing_id       uuid,
  listing_title    text,
  lister_handle    text,
  version_title    text,
  video_url        text,
  video_platform   public.platform
)
language sql
security definer
stable
set search_path = ''
as $$
  select s.id,
         s.status,
         s.created_at,
         s.application_id,
         l.id as listing_id,
         l.title as listing_title,
         u.username::text as lister_handle,
         (lv.snapshot ->> 'title') as version_title,
         sv.url as video_url,
         sv.platform as video_platform
  from public.submissions s
  join public.applications a             on a.id = s.application_id
  left join public.listings l            on l.id = a.listing_id
  left join public.users u               on u.id = l.lister_id
  left join public.listing_versions lv   on lv.id = a.listing_version_id
  left join lateral (
    select url, platform
    from public.submission_videos
    where submission_id = s.id
    order by sort_order asc, id asc
    limit 1
  ) sv on true
  where a.creator_id = public.current_user_id()
  order by s.created_at desc;
$$;

revoke all on function public.list_my_submissions() from public;
revoke all on function public.list_my_submissions() from anon;
grant execute on function public.list_my_submissions() to authenticated;

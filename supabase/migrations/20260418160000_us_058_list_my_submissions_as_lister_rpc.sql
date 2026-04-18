-- US-058 — Lister Inbox: Submissions tab RPC.
--
-- Contract: `public.list_my_submissions_as_lister()` returns every
-- submission (status in pending/approved/rejected) whose application
-- targets a listing owned by the caller
-- (`listings.lister_id = public.current_user_id()`), joined to the
-- creator's username + tiktok/instagram handles, the first submission
-- video (by sort_order), and the cross-tenant reuse count. One row per
-- submission.
--
-- Why SECURITY DEFINER + explicit ownership check: same rationale as the
-- US-056 sibling (`list_my_applications_as_lister`) — a plain PostgREST
-- embed would need to reach `users.username` (self-only RLS → silent
-- null) + `social_links.handle` + `listings.title`; DEFINER + an explicit
-- `lister_id = current_user_id()` gate collapses all three RLS checks
-- into one authoritative ownership filter. Codebase Pattern #118.
--
-- Reuse count: inlined as a `left join lateral` on submission_videos +
-- submissions so Postgres computes it in a single pass rather than N
-- correlated calls. The earlier draft delegated to
-- `public.submission_reuse_count(uuid)` (us_009) for single-source-of-
-- truth, but that helper is a plpgsql SECURITY DEFINER function whose
-- body is opaque to the planner — one execution per row gave O(N) plans
-- for a lister with dozens of submissions. The ownership + auth gate
-- the helper performs is redundant here because every row this RPC
-- returns is already fenced by `l.lister_id = current_user_id()`. The
-- count logic itself is trivial (same external_id + platform on a
-- different submission), so inlining is safe and keeps the helper
-- authoritative for single-row client callers.
--
-- Status filter: AC scopes the inbox to Pending / Approved / Rejected.
-- `submission_status` only has those three values today so the filter is
-- an explicit no-op in practice; we still list them to keep the RPC
-- stable if future enum values are added (they'd be excluded by default,
-- matching the applications sibling's conservative posture).
--
-- Video join: at most one row via `left join lateral ... limit 1`. The
-- submit-video flow inserts exactly one row per submission today, but
-- the table tolerates N — order by sort_order asc, id asc matches
-- US-047's creator-side shape so both sides agree on "first video".
--
-- Social-link join: filter by `status <> 'unlinked'` + the partial unique
-- index `social_links_active_uniq (user_id, platform) WHERE status <>
-- 'unlinked'` guarantees the left join cannot duplicate. NULL handle
-- surfaces as "no handle linked" in the UI.
--
-- Ordering: `created_at desc` — freshest submissions first. Intra-listing
-- grouping is the UI's responsibility (SectionHeader).
--
-- Codebase Patterns referenced:
--   #117 Audit PostgREST embeds against target-table RLS
--   #118 SECURITY DEFINER + ownership-check list-my-rows skeleton
--   #141 Lister-side RPC naming parallels creator-side
--   #42  `set search_path = ''` + schema-qualify every user-defined ref

create or replace function public.list_my_submissions_as_lister()
returns table (
  submission_id       uuid,
  status              public.submission_status,
  created_at          timestamptz,
  decided_at          timestamptz,
  application_id      uuid,
  listing_id          uuid,
  listing_title       text,
  creator_user_id     uuid,
  creator_username    text,
  tiktok_handle       text,
  instagram_handle    text,
  video_url           text,
  video_platform      public.platform,
  video_thumbnail_url text,
  reuse_count         integer
)
language sql
stable
security definer
set search_path = ''
as $$
  select s.id                                                   as submission_id,
         s.status,
         s.created_at,
         s.decided_at,
         s.application_id,
         l.id                                                   as listing_id,
         l.title                                                as listing_title,
         a.creator_id                                           as creator_user_id,
         u.username::text                                       as creator_username,
         tt.handle::text                                        as tiktok_handle,
         ig.handle::text                                        as instagram_handle,
         sv.url                                                 as video_url,
         sv.platform                                            as video_platform,
         nullif(sv.oembed_cached ->> 'thumbnail_url', '')       as video_thumbnail_url,
         coalesce(rc.cnt, 0)                                    as reuse_count
    from public.submissions s
    join public.applications a
      on a.id = s.application_id
    join public.listings l
      on l.id = a.listing_id
    left join public.users u
      on u.id = a.creator_id
    left join public.social_links tt
      on tt.user_id = a.creator_id
     and tt.platform = 'tiktok'::public.platform
     and tt.status   <> 'unlinked'::public.social_link_status
    left join public.social_links ig
      on ig.user_id = a.creator_id
     and ig.platform = 'instagram'::public.platform
     and ig.status   <> 'unlinked'::public.social_link_status
    left join lateral (
      select url, platform, oembed_cached
        from public.submission_videos
       where submission_id = s.id
       order by sort_order asc, id asc
       limit 1
    ) sv on true
    left join lateral (
      select count(*)::integer as cnt
        from public.submission_videos this_sv
        join public.submission_videos other_sv
          on other_sv.external_id = this_sv.external_id
         and other_sv.platform    = this_sv.platform
         and other_sv.external_id is not null
         and other_sv.submission_id <> this_sv.submission_id
       where this_sv.submission_id = s.id
    ) rc on true
   where l.lister_id = public.current_user_id()
     and s.status in (
       'pending'::public.submission_status,
       'approved'::public.submission_status,
       'rejected'::public.submission_status
     )
   order by s.created_at desc;
$$;

revoke all on function public.list_my_submissions_as_lister() from public;
revoke all on function public.list_my_submissions_as_lister() from anon;
grant execute on function public.list_my_submissions_as_lister() to authenticated;

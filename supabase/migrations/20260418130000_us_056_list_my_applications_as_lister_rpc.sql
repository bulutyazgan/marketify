-- US-056 — Lister Inbox: Applications tab RPC.
--
-- Contract: `public.list_my_applications_as_lister()` returns every
-- application (status in pending/approved/rejected) targeting a listing
-- owned by the caller (`listings.lister_id = public.current_user_id()`),
-- joined to the creator's username + tiktok/instagram handles +
-- denormalized follower/view metrics. One row per application.
--
-- Why SECURITY DEFINER + explicit ownership check (Codebase Pattern #118,
-- #117): a plain PostgREST embed on `applications` would need to reach
-- `users.username` (users_self_select RLS is self-only → silent null),
-- `social_links.handle` (social_links_lister_read RLS only shows rows
-- whose user has applied to the caller's listings — works for this
-- screen but is fragile to future tightening), and
-- `creator_profiles.*_follower_count` (creator_profiles_lister_read
-- analogous). DEFINER plus an explicit lister_id gate collapses all
-- four RLS checks into one authoritative ownership filter, and matches
-- the `list_my_applications` (US-043) / `list_my_campaigns` (US-054)
-- precedent shape.
--
-- Status filter: AC scopes the inbox to Pending / Approved / Rejected.
-- Three enum values — `withdrawn`, `cancelled_listing_edit`,
-- `cancelled_listing_closed` — are intentionally excluded from this
-- inbox because they represent creator-initiated or cascade-driven
-- cancellations that do not require lister review. They remain visible
-- on the campaign-scoped application detail screens (US-057+).
--
-- Social-link join semantics: filter by `status <> 'unlinked'` so rows
-- with a subsequently removed handle (history-preserved per US-012
-- design) are omitted. The partial unique index
-- `social_links_active_uniq (user_id, platform) WHERE status <> 'unlinked'`
-- guarantees at most one active link per (user, platform), so the
-- left-join cannot duplicate the applications row. When a creator has
-- not linked a platform at all, the handle/metrics columns come back
-- NULL and the UI surfaces the "no handle" state inline.
--
-- Ordering: `created_at desc` — freshest applications first. This
-- matches `list_my_applications` (US-043) and the inbox UX spec
-- (docs/design.md §3.2: "grouped by campaign" — the UI is responsible
-- for SectionHeader grouping; the RPC provides the data in recency
-- order so the intra-campaign cells remain recency-ordered).
--
-- Codebase Patterns referenced:
--   #117 Audit PostgREST embeds against target-table RLS
--   #118 SECURITY DEFINER + ownership-check list-my-rows skeleton
--   #119 `list_my_<things>` naming convention; argumentless; public schema
--   #42  `set search_path = ''` + schema-qualify every user-defined ref

create or replace function public.list_my_applications_as_lister()
returns table (
  application_id              uuid,
  status                      public.application_status,
  created_at                  timestamptz,
  cover_note                  text,
  listing_id                  uuid,
  listing_title               text,
  creator_user_id             uuid,
  creator_username            text,
  tiktok_handle               text,
  tiktok_follower_count       integer,
  instagram_handle            text,
  instagram_follower_count    integer,
  instagram_avg_views_last_10 integer
)
language sql
stable
security definer
set search_path = ''
as $$
  select a.id                              as application_id,
         a.status,
         a.created_at,
         a.cover_note,
         a.listing_id,
         l.title                           as listing_title,
         a.creator_id                      as creator_user_id,
         u.username::text                  as creator_username,
         tt.handle::text                   as tiktok_handle,
         cp.tiktok_follower_count,
         ig.handle::text                   as instagram_handle,
         cp.instagram_follower_count,
         cp.instagram_avg_views_last_10
    from public.applications a
    join public.listings l
      on l.id = a.listing_id
    left join public.users u
      on u.id = a.creator_id
    left join public.creator_profiles cp
      on cp.user_id = a.creator_id
    left join public.social_links tt
      on tt.user_id = a.creator_id
     and tt.platform = 'tiktok'::public.platform
     and tt.status   <> 'unlinked'::public.social_link_status
    left join public.social_links ig
      on ig.user_id = a.creator_id
     and ig.platform = 'instagram'::public.platform
     and ig.status   <> 'unlinked'::public.social_link_status
   where l.lister_id = public.current_user_id()
     and a.status in (
       'pending'::public.application_status,
       'approved'::public.application_status,
       'rejected'::public.application_status
     )
   order by a.created_at desc;
$$;

revoke all on function public.list_my_applications_as_lister() from public;
revoke all on function public.list_my_applications_as_lister() from anon;
grant execute on function public.list_my_applications_as_lister() to authenticated;

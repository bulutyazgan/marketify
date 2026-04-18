-- US-059 — Detail-fetch RPC for the submission review screen.
--
-- Contract: public.get_submission_for_lister_review(p_submission_id uuid)
--   returns one row with the submission base fields + the parent
--   application + the listing (id/title) + the creator's username and
--   active platform handles + the first submission_video (URL/platform)
--   + the listing's CURRENT version's post-condition rows packed into a
--   jsonb array. Returns zero rows if the caller doesn't own the
--   listing the submission targets.
--
-- Why a SECURITY DEFINER RPC instead of PostgREST embeds: the screen
-- needs (a) creator username (users RLS is self-only — would silent-null
-- per Pattern #117), (b) listing title from the CURRENT version (which
-- may differ from the application's pinned version), and (c) a JSON-
-- aggregated post_conditions array — all in one round trip. A single
-- DEFINER function with an explicit `lister_id = p_caller_id` ownership
-- gate collapses every RLS check into one authoritative filter.
--
-- Post-conditions are read from the listing's CURRENT version
-- (`listings.current_version_id`), not the application's pinned version.
-- Spec gap: docs/tech-architecture.md §4.7 doesn't explicitly say which
-- version's conditions the lister reviews. The simplest defensible
-- interpretation: the lister reviews the current rules (what the listing
-- currently asks for); the application's pinned version is a creator-
-- side eligibility snapshot, not a lister review snapshot. If the
-- listing has been bumped between application + submission, the lister
-- sees the latest rules.
--
-- This RPC is SECURITY DEFINER + p_caller_id passed in (not
-- current_user_id()) because the calling edge function already verified
-- the JWT and we want to keep this RPC service-role-friendly. The screen
-- itself calls it through PostgREST as `authenticated`, so we ALSO grant
-- execute to authenticated AND derive the caller from current_user_id()
-- when called from PostgREST. To support both call paths cleanly, the
-- function takes the caller as a parameter that defaults to NULL and
-- falls back to current_user_id() when NULL — the edge-function path
-- passes the verified lister_id explicitly, the screen passes nothing.
--
-- Codebase Patterns referenced:
--   #117 Audit PostgREST embeds against target-table RLS
--   #118 SECURITY DEFINER + ownership-check skeleton
--   #42  set search_path = '' + schema-qualify every user-defined ref
--   #119 Screen-RPC naming convention

create or replace function public.get_submission_for_lister_review(
  p_submission_id uuid,
  p_caller_id     uuid default null
) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_caller             uuid;
  v_submission_id      uuid;
  v_status             public.submission_status;
  v_created_at         timestamptz;
  v_decided_at         timestamptz;
  v_decision_note      text;
  v_cover_note         text;
  v_application_id     uuid;
  v_creator_id         uuid;
  v_creator_username   text;
  v_tiktok_handle      text;
  v_instagram_handle   text;
  v_listing_id         uuid;
  v_listing_title      text;
  v_listing_lister_id  uuid;
  v_current_version_id uuid;
  v_video_url          text;
  v_video_platform     public.platform;
  v_video_external_id  text;
  v_post_conditions    jsonb;
begin
  -- When called from PostgREST (authenticated), `current_user_id()` is the
  -- caller's JWT sub and is the SOURCE OF TRUTH — `p_caller_id` is ignored
  -- so an authenticated user can't probe for arbitrary listers' submissions
  -- by passing a guessed UUID. When called from an edge function under
  -- service_role, the session has no JWT so `current_user_id()` is null and
  -- we fall back to the explicit `p_caller_id` the edge function verified
  -- against the Marketify HS256 JWT.
  v_caller := case
    when public.current_user_id() is not null then public.current_user_id()
    else p_caller_id
  end;
  if v_caller is null then
    return null;
  end if;

  -- Listing title lives on `public.listings.title` (the CURRENT title).
  -- `listing_versions` has no title column — version snapshots store
  -- prior values inside the `snapshot` jsonb. The lister review screen
  -- shows what the listing is called today, which is `l.title`.
  select s.id, s.status, s.created_at, s.decided_at, s.decision_note,
         s.cover_note, s.application_id,
         a.creator_id, l.id, l.title, l.lister_id, l.current_version_id
    into v_submission_id, v_status, v_created_at, v_decided_at, v_decision_note,
         v_cover_note, v_application_id,
         v_creator_id, v_listing_id, v_listing_title, v_listing_lister_id,
         v_current_version_id
    from public.submissions s
    join public.applications a on a.id = s.application_id
    join public.listings l     on l.id = a.listing_id
   where s.id = p_submission_id;

  if v_submission_id is null then
    return null;
  end if;

  if v_listing_lister_id is distinct from v_caller then
    return null;
  end if;

  -- Creator username + active platform handles. Left joins so missing
  -- rows (creator never linked Instagram, etc.) surface as NULL rather
  -- than dropping the whole row.
  select u.username::text
    into v_creator_username
    from public.users u
   where u.id = v_creator_id;

  select tt.handle::text
    into v_tiktok_handle
    from public.social_links tt
   where tt.user_id = v_creator_id
     and tt.platform = 'tiktok'::public.platform
     and tt.status   <> 'unlinked'::public.social_link_status
   limit 1;

  select ig.handle::text
    into v_instagram_handle
    from public.social_links ig
   where ig.user_id = v_creator_id
     and ig.platform = 'instagram'::public.platform
     and ig.status   <> 'unlinked'::public.social_link_status
   limit 1;

  -- First submission_video (matches list RPC's lateral-join shape).
  select sv.url, sv.platform, sv.external_id
    into v_video_url, v_video_platform, v_video_external_id
    from public.submission_videos sv
   where sv.submission_id = v_submission_id
   order by sv.sort_order asc, sv.id asc
   limit 1;

  -- Post-conditions for the listing's CURRENT version, packed as a jsonb
  -- array. coalesce keeps the empty case `[]` rather than NULL.
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id',                lc.id,
        'metric',            lc.metric,
        'platform',          lc.platform,
        'operator',          lc.operator,
        'numeric_threshold', lc.numeric_threshold,
        'text_threshold',    lc.text_threshold,
        'bool_threshold',    lc.bool_threshold
      )
      order by lc.id asc
    ),
    '[]'::jsonb
  )
    into v_post_conditions
    from public.listing_conditions lc
   where lc.listing_version_id = v_current_version_id
     and lc.kind = 'post'::public.condition_kind;

  return jsonb_build_object(
    'submission_id',     v_submission_id,
    'status',            v_status,
    'created_at',        v_created_at,
    'decided_at',        v_decided_at,
    'decision_note',     v_decision_note,
    'cover_note',        v_cover_note,
    'application_id',    v_application_id,
    'listing_id',        v_listing_id,
    'listing_title',     v_listing_title,
    'creator_user_id',   v_creator_id,
    'creator_username',  v_creator_username,
    'tiktok_handle',     v_tiktok_handle,
    'instagram_handle',  v_instagram_handle,
    'video_url',         v_video_url,
    'video_platform',    v_video_platform,
    'video_external_id', v_video_external_id,
    'post_conditions',   v_post_conditions
  );
end;
$$;

revoke all on function public.get_submission_for_lister_review(uuid, uuid) from public;
revoke all on function public.get_submission_for_lister_review(uuid, uuid) from anon;
grant execute on function public.get_submission_for_lister_review(uuid, uuid) to authenticated;
grant execute on function public.get_submission_for_lister_review(uuid, uuid) to service_role;

comment on function public.get_submission_for_lister_review(uuid, uuid) is
  'US-059 detail-fetch RPC for the lister submission review screen. Returns null when the caller does not own the listing the submission targets. Reads post-conditions from the listing CURRENT version. Callable from PostgREST (authenticated) and from edge functions (service_role).';

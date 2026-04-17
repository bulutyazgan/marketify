-- =========================================================
-- US-009: RLS policies on every user-data table
-- Source of truth: docs/tech-architecture.md §4.4 + §4.7 block 14.
--
-- Behavior:
--   * Per-tenant scoping via public.current_user_id() → auth.jwt() ->> 'sub'.
--   * RLS is (re)enabled on all 15 tables enumerated in §4.7 block 14.
--   * public.events has no policy (RLS + zero policies + revoke = deny);
--     service-role writes bypass via security-definer functions.
--   * Story AC named `listing_pre_conditions` + `listing_post_conditions`, but
--     the spec uses a single `listing_conditions` table discriminated by kind
--     (§4.7 block 8). Policies attach to `listing_conditions` per spec.
--
-- submission_reuse_view handoff (Codebase Patterns):
--   The view at public.submission_reuse_view (us_006) runs with
--   security_invoker = on to clear the `security_definer_view` advisor, but
--   under that mode a lister's RLS on submissions would mask cross-lister
--   reuse counts — defeating the ReuseBadge. We drop the view and replace it
--   with public.submission_reuse_count(uuid), a SECURITY DEFINER function that
--   performs its own caller-authorization check (must own the listing behind
--   the submission) and then counts across all submissions, bypassing RLS.
--   The UI stories (US-058, US-065) call this via PostgREST RPC.
-- =========================================================

-- ---------------- Helpers (JWT → current user / role) ----------------
create or replace function public.current_user_id()
returns uuid
language sql
stable
set search_path = ''
as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;

create or replace function public.current_user_role()
returns public.user_role
language sql
stable
set search_path = ''
as $$
  select nullif(auth.jwt() ->> 'role', '')::public.user_role
$$;

revoke all on function public.current_user_id() from public;
revoke all on function public.current_user_role() from public;
grant execute on function public.current_user_id() to anon, authenticated, service_role;
grant execute on function public.current_user_role() to anon, authenticated, service_role;

-- ---------------- Enable RLS (idempotent; Supabase already auto-enabled) ----------------
alter table public.users              enable row level security;
alter table public.creator_profiles   enable row level security;
alter table public.lister_profiles    enable row level security;
alter table public.social_links       enable row level security;
alter table public.metric_snapshots   enable row level security;
alter table public.listings           enable row level security;
alter table public.listing_versions   enable row level security;
alter table public.listing_conditions enable row level security;
alter table public.sample_videos      enable row level security;
alter table public.applications       enable row level security;
alter table public.submissions        enable row level security;
alter table public.submission_videos  enable row level security;
alter table public.notifications      enable row level security;
alter table public.push_tokens        enable row level security;
alter table public.events             enable row level security;

-- ---------------- users ----------------
drop policy if exists users_self_select on public.users;
create policy users_self_select on public.users for select
  using (id = public.current_user_id());

drop policy if exists users_self_update on public.users;
create policy users_self_update on public.users for update
  using (id = public.current_user_id())
  with check (id = public.current_user_id());

-- ---------------- creator_profiles ----------------
drop policy if exists creator_profiles_self_rw on public.creator_profiles;
create policy creator_profiles_self_rw on public.creator_profiles
  for all
  using (user_id = public.current_user_id())
  with check (user_id = public.current_user_id());

drop policy if exists creator_profiles_lister_read on public.creator_profiles;
create policy creator_profiles_lister_read on public.creator_profiles
  for select using (
    exists (
      select 1
      from public.applications a
      join public.listings l on l.id = a.listing_id
      where a.creator_id = public.creator_profiles.user_id
        and l.lister_id = public.current_user_id()
    )
  );

-- ---------------- lister_profiles ----------------
drop policy if exists lister_profiles_self_rw on public.lister_profiles;
create policy lister_profiles_self_rw on public.lister_profiles
  for all
  using (user_id = public.current_user_id())
  with check (user_id = public.current_user_id());

-- ---------------- social_links ----------------
drop policy if exists social_links_self_rw on public.social_links;
create policy social_links_self_rw on public.social_links
  for all
  using (user_id = public.current_user_id())
  with check (user_id = public.current_user_id());

drop policy if exists social_links_lister_read on public.social_links;
create policy social_links_lister_read on public.social_links
  for select using (
    exists (
      select 1
      from public.applications a
      join public.listings l on l.id = a.listing_id
      where a.creator_id = public.social_links.user_id
        and l.lister_id = public.current_user_id()
    )
  );

-- ---------------- metric_snapshots ----------------
-- Only is_latest + status='fresh' rows are readable; history is service-role only.
drop policy if exists metric_snapshots_self_read on public.metric_snapshots;
create policy metric_snapshots_self_read on public.metric_snapshots for select
  using (
    is_latest and status = 'fresh'
    and exists (
      select 1 from public.social_links sl
      where sl.id = public.metric_snapshots.social_link_id
        and sl.user_id = public.current_user_id()
    )
  );

drop policy if exists metric_snapshots_lister_read on public.metric_snapshots;
create policy metric_snapshots_lister_read on public.metric_snapshots for select
  using (
    is_latest and status = 'fresh'
    and exists (
      select 1
      from public.social_links sl
      join public.applications a on a.creator_id = sl.user_id
      join public.listings l on l.id = a.listing_id
      where sl.id = public.metric_snapshots.social_link_id
        and l.lister_id = public.current_user_id()
    )
  );

-- ---------------- listings ----------------
drop policy if exists listings_public_read on public.listings;
create policy listings_public_read on public.listings for select
  using (status = 'active');

drop policy if exists listings_owner_all on public.listings;
create policy listings_owner_all on public.listings
  for all
  using (lister_id = public.current_user_id())
  with check (lister_id = public.current_user_id());

-- ---------------- listing_versions ----------------
drop policy if exists listing_versions_read_if_listing_readable on public.listing_versions;
create policy listing_versions_read_if_listing_readable on public.listing_versions
  for select using (
    exists (
      select 1 from public.listings l
      where l.id = public.listing_versions.listing_id
        and (l.status = 'active' or l.lister_id = public.current_user_id())
    )
  );

-- ---------------- listing_conditions ----------------
drop policy if exists listing_conditions_read_if_version_readable on public.listing_conditions;
create policy listing_conditions_read_if_version_readable on public.listing_conditions
  for select using (
    exists (
      select 1
      from public.listing_versions v
      join public.listings l on l.id = v.listing_id
      where v.id = public.listing_conditions.listing_version_id
        and (l.status = 'active' or l.lister_id = public.current_user_id())
    )
  );

-- ---------------- sample_videos ----------------
drop policy if exists sample_videos_read_if_version_readable on public.sample_videos;
create policy sample_videos_read_if_version_readable on public.sample_videos
  for select using (
    exists (
      select 1
      from public.listing_versions v
      join public.listings l on l.id = v.listing_id
      where v.id = public.sample_videos.listing_version_id
        and (l.status = 'active' or l.lister_id = public.current_user_id())
    )
  );

-- ---------------- applications ----------------
drop policy if exists applications_creator_rw on public.applications;
create policy applications_creator_rw on public.applications
  for all
  using (creator_id = public.current_user_id())
  with check (creator_id = public.current_user_id());

drop policy if exists applications_lister_read on public.applications;
create policy applications_lister_read on public.applications for select
  using (
    exists (
      select 1 from public.listings l
      where l.id = public.applications.listing_id
        and l.lister_id = public.current_user_id()
    )
  );

drop policy if exists applications_lister_decide on public.applications;
create policy applications_lister_decide on public.applications for update
  using (
    exists (
      select 1 from public.listings l
      where l.id = public.applications.listing_id
        and l.lister_id = public.current_user_id()
    )
  )
  with check (
    exists (
      select 1 from public.listings l
      where l.id = public.applications.listing_id
        and l.lister_id = public.current_user_id()
    )
  );

-- ---------------- submissions ----------------
drop policy if exists submissions_creator_rw on public.submissions;
create policy submissions_creator_rw on public.submissions
  for all
  using (
    exists (
      select 1 from public.applications a
      where a.id = public.submissions.application_id
        and a.creator_id = public.current_user_id()
    )
  )
  with check (
    exists (
      select 1 from public.applications a
      where a.id = public.submissions.application_id
        and a.creator_id = public.current_user_id()
    )
  );

drop policy if exists submissions_lister_read on public.submissions;
create policy submissions_lister_read on public.submissions for select
  using (
    exists (
      select 1
      from public.applications a
      join public.listings l on l.id = a.listing_id
      where a.id = public.submissions.application_id
        and l.lister_id = public.current_user_id()
    )
  );

drop policy if exists submissions_lister_decide on public.submissions;
create policy submissions_lister_decide on public.submissions for update
  using (
    exists (
      select 1
      from public.applications a
      join public.listings l on l.id = a.listing_id
      where a.id = public.submissions.application_id
        and l.lister_id = public.current_user_id()
    )
  )
  with check (
    exists (
      select 1
      from public.applications a
      join public.listings l on l.id = a.listing_id
      where a.id = public.submissions.application_id
        and l.lister_id = public.current_user_id()
    )
  );

-- ---------------- submission_videos ----------------
drop policy if exists submission_videos_read on public.submission_videos;
create policy submission_videos_read on public.submission_videos for select
  using (
    exists (
      select 1
      from public.submissions s
      join public.applications a on a.id = s.application_id
      where s.id = public.submission_videos.submission_id
        and (
          a.creator_id = public.current_user_id()
          or exists (
            select 1 from public.listings l
            where l.id = a.listing_id
              and l.lister_id = public.current_user_id()
          )
        )
    )
  );

drop policy if exists submission_videos_creator_write on public.submission_videos;
create policy submission_videos_creator_write on public.submission_videos
  for all
  using (
    exists (
      select 1
      from public.submissions s
      join public.applications a on a.id = s.application_id
      where s.id = public.submission_videos.submission_id
        and a.creator_id = public.current_user_id()
    )
  )
  with check (
    exists (
      select 1
      from public.submissions s
      join public.applications a on a.id = s.application_id
      where s.id = public.submission_videos.submission_id
        and a.creator_id = public.current_user_id()
    )
  );

-- ---------------- notifications + push_tokens ----------------
drop policy if exists notifications_self_rw on public.notifications;
create policy notifications_self_rw on public.notifications
  for all
  using (user_id = public.current_user_id())
  with check (user_id = public.current_user_id());

drop policy if exists push_tokens_self_rw on public.push_tokens;
create policy push_tokens_self_rw on public.push_tokens
  for all
  using (user_id = public.current_user_id())
  with check (user_id = public.current_user_id());

-- ---------------- events ----------------
-- Service role only. No application read/write policy — the absence of any
-- policy + RLS enabled = deny for all non-superuser roles (spec §4.7 block 14).
revoke all on public.events from anon, authenticated;

-- =========================================================
-- submission_reuse: view → function swap (see header)
-- =========================================================
drop view if exists public.submission_reuse_view;

create or replace function public.submission_reuse_count(p_submission_id uuid)
returns integer
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_caller   uuid;
  v_allowed  boolean;
  v_count    integer;
begin
  v_caller := public.current_user_id();
  if v_caller is null then
    return null;
  end if;

  -- Only the lister whose listing hosts this submission can read the count.
  select exists (
    select 1
    from public.submissions s
    join public.applications a on a.id = s.application_id
    join public.listings l on l.id = a.listing_id
    where s.id = p_submission_id
      and l.lister_id = v_caller
  ) into v_allowed;

  if not v_allowed then
    return null;
  end if;

  select count(other.id)::integer
  into v_count
  from public.submission_videos sv
  join public.submission_videos other_sv
    on other_sv.external_id = sv.external_id
   and other_sv.platform    = sv.platform
   and other_sv.external_id is not null
  join public.submissions other
    on other.id = other_sv.submission_id
   and other.id <> sv.submission_id
  where sv.submission_id = p_submission_id;

  return coalesce(v_count, 0);
end;
$$;

comment on function public.submission_reuse_count(uuid) is
  'ReuseBadge source (design §4.6). Returns the number of *other* submissions '
  'sharing this submission''s video (external_id + platform), across all listers. '
  'Security-definer: own auth check — only the owning lister sees a value; '
  'non-owners get NULL.';

revoke all on function public.submission_reuse_count(uuid) from public;
grant execute on function public.submission_reuse_count(uuid) to authenticated, service_role;

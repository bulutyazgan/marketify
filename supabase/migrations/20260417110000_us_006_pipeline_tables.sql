-- US-006: applications + submissions pipeline tables
-- Per docs/tech-architecture.md §4.7 blocks 10 and 11.
--
-- Spec gap: Story AC mentions "the reserved revision-request column on submissions",
-- but the spec explicitly states "No `revision_requested` in v1" (§2.2 line 121,
-- §14.2 line 2014 — binary approve/reject only). The reserved columns on
-- submissions per spec are the override audit trail (override_by_user_id +
-- override_reason) guarded by the submissions_override_requires_approved check.
-- Following the spec.

-- =========================================================
-- 10. applications
-- =========================================================
create table public.applications (
  id                 uuid primary key default gen_random_uuid(),
  listing_id         uuid not null references public.listings(id) on delete restrict,
  listing_version_id uuid not null references public.listing_versions(id) on delete restrict,
  creator_id         uuid not null references public.users(id) on delete restrict,
  status             application_status not null default 'pending',
  cover_note         text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  decided_at         timestamptz,
  decision_note      text
);
create index on public.applications (listing_id, status);
create index on public.applications (creator_id, status, created_at desc);
create unique index applications_open_uniq
  on public.applications (listing_id, creator_id)
  where status in ('pending','approved');

-- =========================================================
-- 11. submissions + videos
-- =========================================================
create table public.submissions (
  id                   uuid primary key default gen_random_uuid(),
  application_id       uuid not null references public.applications(id) on delete restrict,
  status               submission_status not null default 'pending',
  cover_note           text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  decided_at           timestamptz,
  decision_note        text,
  -- Override audit trail. Populated only when a lister approves a submission
  -- that has at least one failed post-condition (design §4.6 OverrideEligibilityDialog).
  -- override_by_user_id is the lister's user_id (redundant with applications→listings.lister_id
  -- in the common case but explicit here so a later "team accounts" v2 that permits
  -- delegated review doesn't need a schema change).
  -- override_reason is a free-text field typed by the lister; null for normal approvals.
  override_by_user_id  uuid references public.users(id) on delete set null,
  override_reason      text,
  constraint submissions_override_requires_approved
    check ((override_by_user_id is null and override_reason is null)
           or status = 'approved')
);
create unique index submissions_open_uniq
  on public.submissions (application_id)
  where status in ('pending','approved');
create index on public.submissions (status, created_at desc);

create table public.submission_videos (
  id                uuid primary key default gen_random_uuid(),
  submission_id     uuid not null references public.submissions(id) on delete cascade,
  platform          platform not null,
  url               text not null,
  external_id       text,
  oembed_cached     jsonb,
  last_validated_at timestamptz,
  sort_order        smallint not null default 0
);
create index on public.submission_videos (submission_id);

-- "Also submitted to N other campaigns" chip (the ReuseBadge in design §4.6).
-- Aggregates how many other submissions by the same creator use the same video URL
-- (normalized by external_id, not raw URL, so `?t=30s` variants collapse). The chip
-- is only shown to listers with RLS on submissions so they see their own
-- submission_id + a count — they never see WHICH other campaigns, only HOW MANY.
create or replace view public.submission_reuse_view as
  select
    s.id as submission_id,
    count(other.id) filter (where other.id <> s.id) as reuse_count
  from public.submissions s
  join public.submission_videos sv
    on sv.submission_id = s.id
  left join public.submission_videos other_sv
    on other_sv.external_id = sv.external_id
   and other_sv.platform = sv.platform
   and other_sv.external_id is not null
  left join public.submissions other
    on other.id = other_sv.submission_id
   and other.id <> s.id
  group by s.id;

comment on view public.submission_reuse_view is
  'Exposes per-submission count of other submissions reusing the same video external_id. '
  'Read via RLS on submissions — a lister sees reuse_count only for their own listings'' submissions.';

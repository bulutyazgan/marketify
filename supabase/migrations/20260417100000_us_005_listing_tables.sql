-- US-005: listings + versioning + conditions + sample videos
-- Per docs/tech-architecture.md §4.7 blocks 7, 8, 9.
-- Story US-005 originally called for `listing_pre_conditions` + `listing_post_conditions`
-- but the canonical spec defines a single `listing_conditions` table discriminated by
-- the `condition_kind` enum ('pre' | 'post'). The spec wins (see progress.txt Spec gap).

-- =========================================================
-- 7. listings
-- =========================================================
create table public.listings (
  id                                uuid primary key default gen_random_uuid(),
  lister_id                         uuid not null references public.users(id) on delete restrict,
  status                            listing_status not null default 'draft',
  title                             text not null,
  description                       text,
  category                          text not null default 'other',
  price_cents                       integer not null check (price_cents >= 0),
  currency                          text not null default 'USD',
  max_submissions                   integer,
  approved_submissions_count        integer not null default 0,
  active_pending_applications_count integer not null default 0,
  end_date                          timestamptz,
  current_version_id                uuid,
  version_number                    integer not null default 1,
  min_followers_tiktok              integer,
  min_followers_instagram           integer,
  version_bump_reason               text,
  created_at                        timestamptz not null default now(),
  updated_at                        timestamptz not null default now(),
  published_at                      timestamptz,
  closed_at                         timestamptz
);

create index listings_feed_idx
  on public.listings (status, created_at desc) where status = 'active';
create index listings_lister_idx on public.listings (lister_id, status);
create index listings_tt_threshold_idx
  on public.listings (min_followers_tiktok) where status = 'active';
create index listings_ig_threshold_idx
  on public.listings (min_followers_instagram) where status = 'active';
create index listings_category_price_idx
  on public.listings (category, price_cents) where status = 'active';

-- =========================================================
-- 7b. listing_versions
-- =========================================================
create table public.listing_versions (
  id                  uuid primary key default gen_random_uuid(),
  listing_id          uuid not null references public.listings(id) on delete cascade,
  version_number      integer not null,
  price_cents         integer not null,
  currency            text not null,
  max_submissions     integer,
  snapshot            jsonb not null,
  previous_version_id uuid references public.listing_versions(id),
  changed_fields      text[] not null default '{}',
  created_at          timestamptz not null default now(),
  unique (listing_id, version_number)
);
create index listing_versions_listing_ver_desc_idx
  on public.listing_versions (listing_id, version_number desc);

-- Close the circular FK: listings.current_version_id -> listing_versions.id
alter table public.listings
  add constraint listings_current_version_fk
  foreign key (current_version_id) references public.listing_versions(id);

-- =========================================================
-- 8. listing_conditions (data-driven pre + post conditions)
-- =========================================================
create table public.listing_conditions (
  id                 uuid primary key default gen_random_uuid(),
  listing_version_id uuid not null references public.listing_versions(id) on delete cascade,
  kind               condition_kind not null,
  metric             condition_metric not null,
  platform           platform,
  operator           text not null default 'gte'
    check (operator in ('gte','lte','eq','contains','bool')),
  numeric_threshold  numeric,
  text_threshold     text,
  bool_threshold     boolean,
  created_at         timestamptz not null default now()
);
create index listing_conditions_version_kind_idx
  on public.listing_conditions (listing_version_id, kind);

-- =========================================================
-- 9. sample_videos
-- =========================================================
create table public.sample_videos (
  id                 uuid primary key default gen_random_uuid(),
  listing_version_id uuid not null references public.listing_versions(id) on delete cascade,
  platform           platform not null,
  url                text not null,
  caption            text,
  sort_order         smallint not null default 0
);
create index sample_videos_version_idx
  on public.sample_videos (listing_version_id);

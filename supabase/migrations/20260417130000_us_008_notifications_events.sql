-- US-008: notifications + push_tokens + events audit log
-- Per docs/tech-architecture.md §4.7 blocks 12 (notifications + push_tokens)
-- and 13 (events). RLS is enabled on all three; policies arrive in US-009.
--
-- Spec gap: Story AC names only "notifications and events tables"; the spec
-- bundles push_tokens with notifications under block 12. Push notifications
-- themselves are out of scope in v1 (product-plan §3.1 line 120) but the spec
-- defines the idle table now. Creating the empty table is harmless and keeps
-- us faithful to §4.7 — following the prior US-005 precedent of spec-over-story
-- when the two disagree on DDL.

-- =========================================================
-- 12. notifications + push_tokens
-- =========================================================
create table public.notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.users(id) on delete cascade,
  kind       public.notification_kind not null,
  payload    jsonb not null,
  read_at    timestamptz,
  created_at timestamptz not null default now()
);
create index notifications_inbox_idx  on public.notifications (user_id, created_at desc);
create index notifications_unread_idx on public.notifications (user_id) where read_at is null;

create table public.push_tokens (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.users(id) on delete cascade,
  expo_token   text not null unique,
  platform     text not null check (platform in ('ios','android')),
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

-- =========================================================
-- 13. events (append-only audit log)
-- =========================================================
create table public.events (
  id         bigserial primary key,
  actor_id   uuid,
  entity     text not null,
  entity_id  uuid not null,
  action     text not null,
  old_state  jsonb,
  new_state  jsonb,
  created_at timestamptz not null default now()
);
create index on public.events (entity, entity_id, created_at desc);

-- =========================================================
-- RLS (policies land in US-009; enabling now satisfies §4.7 block 14)
-- =========================================================
alter table public.notifications enable row level security;
alter table public.push_tokens   enable row level security;
alter table public.events        enable row level security;

-- events is append-only: revoke every grant from app roles. Combined with RLS
-- enabled + zero policies, anon/authenticated cannot read or write the table
-- at all. Server-side writes flow through SECURITY DEFINER functions (owner:
-- postgres), so the lack of authenticated UPDATE/DELETE grants enforces the
-- append-only contract without requiring application-layer trust.
revoke all on public.events from anon, authenticated;

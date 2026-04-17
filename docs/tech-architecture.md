# Marketify — Technical Architecture Document

**Scope:** Backend, data, APIs, workflows. UI/UX is separate (see `design.md`).
**Stack:** Expo + React Native + Reanimated + Supabase (Postgres, Storage, Edge Functions, Realtime) + **Apify** (two actors: `clockworks/tiktok-scraper`, `apify/instagram-scraper`).
**Posture:** Opinionated. Where the PRD is silent, a default is chosen with justification.

---

## 1. Design Decisions

The table below captures every non-obvious architectural choice. Each row is a committed default that the rest of the document relies on — if you need to revisit one, expect ripple effects in §4 (schema), §5 (edge functions), and `design.md` (UX).

### 1.1 Identity & Auth

| Area | Decision |
|---|---|
| Metric collection | **Apify scrapers, no OAuth.** Creator signs up with role + username + TikTok handle and/or IG handle. Server kicks an Apify actor to fetch metrics asynchronously. Handle ownership is unverified in MVP. |
| Username uniqueness | `username` is the unique display identifier (citext). `(platform, handle)` is also unique across `social_links` — first creator to register a handle owns it. Collisions surface with a "handle already registered" error; we do not verify ownership. |
| Creator + lister on same account | One role per account. Dual-role users make two accounts. |
| Lister identity | Self-declared: username + email + org name. KYC is post-MVP. |
| Handle impersonation | No ownership verification in MVP — first registrant wins. Impersonation is a manual-report problem; accept until it becomes real abuse. |

### 1.2 Listing Lifecycle

| Area | Decision |
|---|---|
| States | `draft → active → (paused \| closed) → archived`. No `expired` state. |
| Auto-expiration | None. `end_date` column retained for v1.1; listers close listings manually. |
| Submission cap | `max_submissions` nullable. Listers close manually when they're done — no auto-close trigger in v1. |
| Application uniqueness | One active application per `(creator, listing)`. Partial unique index. |
| Cascade-on-edit | Editing any versioned field — price, pre-conditions, post-conditions, sample videos, max_submissions — bumps a version and cascade-cancels pending applications with `cancelled_listing_edit`. Title/description edits do NOT cascade. |

### 1.3 Applications & Submissions

| Area | Decision |
|---|---|
| Withdraw | Creator can withdraw from `pending` → `withdrawn`. |
| Eligibility drift between apply and approve | Re-check at approve-time. If now-ineligible, lister receives `409 INELIGIBLE_NOW` with `override_allowed=true`. No re-check at submit-time. |
| Videos per submission | 1..N video URLs per submission. `min_videos` post-condition (default 1). |
| Revision request | Binary approve/reject only. Column reserved for v1.1. |
| Reapplication | After `rejected` / `cancelled_listing_edit`: allowed if listing still active. After `withdrawn`: allowed immediately. |
| Submission reuse | A single video URL may be submitted to multiple campaigns. Surfaced to the lister via `ReuseBadge` (design §4.6) but not blocked. |
| Disputes | Append-only `events` table; support email only in MVP. |
| Pending apps/submissions expiry | No auto-expire. Rows stay in-inbox until explicitly acted on. |

### 1.4 Money

| Area | Decision |
|---|---|
| Payments | No real money in MVP. `price` is display-only. Off-platform handshake. `payment_status` column stubbed for v2. |

### 1.5 Notifications

| Area | Decision |
|---|---|
| Events | Application approved/rejected/cancelled; submission approved/rejected; listing version changed; metrics refresh failed. |
| Channels | In-app inbox + Supabase Realtime. Push deferred to v1.1. |
| Transport | Realtime on `applications`, `submissions`, `notifications`. Poll fallback on app resume. |

### 1.6 Metrics / Apify

| Area | Decision |
|---|---|
| Rate limits | Apify costs real money per scrape. Server-side throttle: manual refresh once per 6h per `(user, platform)`. Background refresh daily via `pg_cron` for all linked handles with `fetched_at < now() - 24h`. |
| Scrape failures | `metric_snapshots.status = fresh \| stale \| refreshing \| failed`. "Outdated" badge if `fetched_at > 7d`. After 3 consecutive failed scrapes, `social_link.status = failed_fetch`, prompt creator to re-enter handle. |
| Video integrity | Validate via TikTok/IG oEmbed at submission time (`422` if 404). Nightly sweep re-validates `approved` submissions — flags but doesn't change state. |
| Post-submission performance | Out of MVP. Later: an Apify actor per submitted video to pull current view count. |

### 1.7 Security / Abuse

| Area | Decision |
|---|---|
| Spam/illegal listings | `report_listing` button → admin table. Admin reviews via Supabase Studio. |
| Submission cross-posting | Flag via `ReuseBadge`, don't hard-block. |

---

## 2. State Machines

Notation: `transition [actor: user|lister|system|time]`.

### 2.1 Listing

```
(init) ──create[lister]──> draft
draft ──publish[lister]──> active
active ──pause[lister]──> paused
paused ──resume[lister]──> active
active ──close[lister]──> closed
closed ──archive[lister]──> archived
paused ──archive[lister]──> archived

Side-effect on edit mutating price/pre-cond/post-cond/samples/max_submissions while active:
  version++ AND cascade-cancel pending applications (see §2.3)
```

Terminal: `archived`.

### 2.2 Application

```
(init) ──submit[creator, gated by eligibility]──> pending
pending ──approve[lister]──> approved
pending ──reject[lister]──> rejected
pending ──withdraw[creator]──> withdrawn
pending ──listing_version_bump[system]──> cancelled_listing_edit
pending ──listing_archived[system]──> cancelled_listing_closed
approved ──listing_archived[system]──> cancelled_listing_closed
```

No time-based expiration in v1.

### 2.3 Submission

```
(init, requires application.status=approved) ──create[creator]──> pending
pending ──approve[lister]──> approved
pending ──reject[lister]──> rejected
```

No `revision_requested` in v1. No time-based expiration.

### 2.4 Social Link

```
(init) ──handle_added[creator]──> linked       (triggers initial Apify scrape)
linked ──scrape_success[system]──> linked
linked ──scrape_fail x3[system]──> failed_fetch
failed_fetch ──handle_reentered[creator]──> linked
linked ──unlink[creator]──> unlinked
```

### 2.5 Metric Snapshot

```
(init, on link or refresh) ──apify_run_started[system]──> refreshing
refreshing ──success[system|apify_webhook]──> fresh
refreshing ──fail[system]──> failed
fresh ──age > 24h[time]──> stale
stale ──run_started[creator_manual | system_daily]──> refreshing
failed ──retry[system|creator]──> refreshing
```

Rule: eligibility filter uses `fresh` OR `stale`, never `failed`. UI warns if `stale`.

---

## 3. Apify Integration

**Sources:**
- `apify-client` NPM package — [github.com/apify/apify-client-js](https://github.com/apify/apify-client-js)
- TikTok Scraper actor page — [apify.com/clockworks/tiktok-scraper](https://apify.com/clockworks/tiktok-scraper)
- Instagram Scraper actor page — [apify.com/apify/instagram-scraper](https://apify.com/apify/instagram-scraper)

### 3a. Actor Catalog (v1)

We use **two actors only**, consolidating all metric fetches:

| Platform | Actor Slug | REST slug (with `~`) | Purpose |
|---|---|---|---|
| TikTok | `clockworks/tiktok-scraper` | `clockworks~tiktok-scraper` | Profile + last N videos in a single run |
| Instagram | `apify/instagram-scraper` | `apify~instagram-scraper` | Profile details **and** posts/reels — two runs per refresh (different `resultsType`) |

**Actor endpoints** (both actors expose the same surface):

- Sync (blocking, returns dataset items): `POST https://api.apify.com/v2/acts/<slug>/run-sync-get-dataset-items?token=<APIFY_TOKEN>`
- Async (returns run, webhook-completed): `POST https://api.apify.com/v2/acts/<slug>/runs?token=<APIFY_TOKEN>`

In practice we use the `apify-client` JS SDK (`.actor(slug).call()` for sync, `.actor(slug).start()` for async) — it wraps both endpoints.

### 3b. TikTok — `clockworks/tiktok-scraper`

**Input (profile scrape):**
```json
{
  "profiles": ["<handle>"],
  "resultsPerPage": 10,
  "profileScrapeSections": ["videos"],
  "profileSorting": "latest",
  "excludePinnedPosts": true,
  "shouldDownloadVideos": false,
  "shouldDownloadCovers": false,
  "shouldDownloadSubtitles": false
}
```

Notes:
- `profileSorting: "latest"` returns newest videos first — required so `avg_views_last_10` is the **recent** trailing window, not all-time popular.
- `excludePinnedPosts: true` avoids skewing the average with a single mega-viral pinned post.
- Download flags default to `true` on Apify; we override to `false` to cut run cost (we never need the media bytes).

**Output** — one row per video, with the author profile **denormalized onto every row**. Relevant fields:

| Path | Meaning | Maps to |
|---|---|---|
| `authorMeta.name` | handle | verification vs. input |
| `authorMeta.fans` | follower count | `follower_count` |
| `authorMeta.following` | following count | (stored for profile, not eligibility) |
| `authorMeta.heart` | total lifetime likes across videos | (stored) |
| `authorMeta.video` | total post count | `video_count` |
| `authorMeta.verified` | blue check | `is_verified` |
| `playCount` | **view count for this video** | contributes to `avg_views_last_10` |
| `diggCount` | like count for this video | (stored) |
| `shareCount`, `commentCount`, `collectCount` | engagement | (stored) |
| `videoMeta.duration` | seconds | (stored) |
| `createTimeISO`, `webVideoUrl` | timestamps / permalink | (stored) |

**Metric derivation (TikTok):**
- `follower_count = items[0].authorMeta.fans`
- `avg_views_last_10 = mean(items[i].playCount for i in 0..min(10, len(items)))`
- `video_count = items[0].authorMeta.video`

**One run per refresh.**

### 3c. Instagram — `apify/instagram-scraper`

The Instagram actor is a **multi-mode scraper**; what it returns depends on `resultsType`. For our use case we need two modes per refresh:

**Run 1 — profile details (follower count):**
```json
{
  "directUrls": ["https://www.instagram.com/<handle>/"],
  "resultsType": "details",
  "resultsLimit": 1,
  "addParentData": false
}
```

Output (one row, keyed on username):

| Field | Meaning | Maps to |
|---|---|---|
| `username` | handle | verification |
| `followersCount` | follower count | `follower_count` |
| `followsCount` | following count | (stored) |
| `postsCount` | total posts | `media_count` |
| `fullName`, `biography`, `profilePicUrl` | profile chrome | (stored) |
| `isBusinessAccount` | is Business/Creator | (stored; informational only — **not required**) |
| `verified` | blue check | `is_verified` |

**Run 2 — recent reels (view counts):**
```json
{
  "directUrls": ["https://www.instagram.com/<handle>/"],
  "resultsType": "posts",
  "resultsLimit": 10,
  "addParentData": false
}
```

`resultsType: "posts"` returns the profile's recent feed (posts + reels interleaved). We filter client-side to `type === "Video"` entries and use their view counts.

Output (one row per post) — relevant fields:

| Field | Meaning | Notes |
|---|---|---|
| `type` | `"Image"` \| `"Video"` \| `"Sidecar"` | filter to `"Video"` |
| `videoPlayCount` | Instagram's "plays" metric | primary signal |
| `videoViewCount` | view metric (sometimes null on older posts) | fallback |
| `likesCount`, `commentsCount` | engagement | (stored) |
| `videoDuration` | seconds | (stored) |
| `caption`, `hashtags`, `mentions`, `timestamp`, `url`, `shortCode` | post meta | (stored) |

**Metric derivation (Instagram):**
- `follower_count = details[0].followersCount`
- `media_count = details[0].postsCount`
- `avg_views_last_10 = mean(p.videoPlayCount ?? p.videoViewCount for p in posts where p.type === "Video")` — skip the profile entirely if there are fewer than 1 video posts (set `avg_views_last_10 = null`, surface in UI as "Not enough video posts to compute").

**Photo-only creators:** if `posts` returns 0 `type === "Video"` entries across 10 results, we write `instagram_avg_views_last_10 = null` and surface it in the UI as "Not enough video posts to compute." **No fallback run to `resultsType: "reels"`** — the cost doubling (extra ~$0.007/refresh × every photo-only creator × daily cron) wasn't justified in back-of-envelope math vs. just telling the creator to post more reels. Listings that require `min_avg_views_last_n` on Instagram treat `null` as ineligible (fail-closed).

**Two runs per IG refresh.** Budget: 1 run = TikTok refresh, 2 runs = IG refresh. No conditional third run.

### 3d. Client Pattern

```ts
import { ApifyClient } from 'apify-client';
const apify = new ApifyClient({ token: Deno.env.get('APIFY_TOKEN')! });

// --- synchronous short-run (used on first signup — user is waiting) ---
const tiktok = await apify
  .actor('clockworks/tiktok-scraper')
  .call(
    {
      profiles: [handle],
      resultsPerPage: 10,
      profileScrapeSections: ['videos'],
      profileSorting: 'latest',
      excludePinnedPosts: true,
      shouldDownloadVideos: false,
      shouldDownloadCovers: false,
    },
    { waitSecs: 60 },
  );
const { items: tiktokItems } = await apify.dataset(tiktok.defaultDatasetId).listItems();

// --- async run with webhook (used for cron refresh and initial IG scrapes) ---
const run = await apify
  .actor('apify/instagram-scraper')
  .start(
    {
      directUrls: [`https://www.instagram.com/${handle}/`],
      resultsType: 'details',
      resultsLimit: 1,
    },
    {
      webhooks: [{
        eventTypes: ['ACTOR.RUN.SUCCEEDED', 'ACTOR.RUN.FAILED', 'ACTOR.RUN.TIMED_OUT', 'ACTOR.RUN.ABORTED'],
        requestUrl: `${SUPABASE_URL}/functions/v1/webhooks-apify`,
        payloadTemplate: JSON.stringify({
          social_link_id: '<id>',
          scrape_mode: 'ig_details',       // or 'ig_posts' | 'tiktok_profile'
          run_id: '{{resource.id}}',
          status: '{{resource.status}}',
          dataset_id: '{{resource.defaultDatasetId}}',
        }),
        headersTemplate: JSON.stringify({
          'X-Apify-Webhook-Secret': Deno.env.get('APIFY_WEBHOOK_SECRET')!,
        }),
      }],
    },
  );
```

**Signup flow (user waiting):** Use sync `.call(input, { waitSecs: 60 })` for the *first* scrape per handle. If the actor finishes inside 60s, populate the snapshot inline; if it doesn't, the `waitSecs` limit returns a `RUNNING` run and the webhook completes it later. UI shows "Fetching your metrics..." until either returns.

**Cron refresh / manual refresh:** Always async (`.start()` with webhook). The refresh endpoint queues work and returns `202 Accepted` immediately.

### 3e. Metric Derivation — Summary

| Denormalized field on `creator_profiles` | TikTok source | Instagram source |
|---|---|---|
| `tiktok_follower_count` | `authorMeta.fans` | — |
| `tiktok_avg_views_last_10` | `mean(playCount[:10])` | — |
| `tiktok_video_count` | `authorMeta.video` | — |
| `tiktok_is_verified` | `authorMeta.verified` | — |
| `instagram_follower_count` | — | `details[0].followersCount` |
| `instagram_avg_views_last_10` | — | `mean(videoPlayCount ?? videoViewCount)` across `type === "Video"` posts |
| `instagram_media_count` | — | `details[0].postsCount` |
| `instagram_is_verified` | — | `details[0].verified` *(reserved; column add in v1.1)* |

Stored fully in `metric_snapshots.raw_payload` (jsonb) for forensics and future backfills — if we later need `diggCount` trends we don't need to re-scrape.

### 3f. Cost & Rate Management

- Every actor run costs Apify credits. Published pricing at time of writing: TikTok Scraper ≈ $0.40 / 1k videos (so ~$0.004 per 10-video run), Instagram Scraper ≈ $2.30 / 1k results. Budget conservatively at ~$0.01 per TikTok refresh and ~$0.02 per IG refresh (details + 10 posts = 11 results).
- **Scale math (back-of-envelope):** 10k creators × daily cron refresh ≈ $40/day TikTok-only, $200/day IG-only, $240/day fully-linked. That's ~$7.2k/month worst case. Sensitivity: cutting daily cron to every 48h halves that; capping free-tier creators to weekly refresh quarters it.
- **Hard throttle:** `metrics/refresh` server-side limit 1 per 6h per `(user, platform)`. `429` returned before any Apify call.
- **Daily cron enforcement:** `cron-refresh-metrics` edge function pulls `social_links` ordered by `metrics_fetched_at ASC NULLS FIRST` and keeps a running tally of `estimated_cost_usd`; it stops dispatching new runs once `estimated_cost_usd >= APIFY_DAILY_BUDGET_USD`. Skipped links get picked up first the next day because of the `NULLS FIRST` ordering and oldest-first tie-break. Estimate is static per `scrape_mode` (`tiktok_profile`: $0.005, `ig_details`: $0.005, `ig_posts`: $0.015) — no dynamic pricing lookup needed.
- Set Apify run timeout (via `timeoutSecs` input to `.start()`) to 120s; if actor hangs, we fail-close the snapshot (`status=failed`) and retry on next cron window.
- Memory: default `memoryMbytes` is fine for both actors (1024 MB); don't override.

### 3g. Webhook Security

- We attach `X-Apify-Webhook-Secret: <token>` via `headersTemplate` on every webhook registration. Edge Function rejects requests without a matching secret; compare via `crypto.subtle.timingSafeEqual`-equivalent (constant-time).
- Webhook endpoint is idempotent: `metric_snapshots.apify_run_id` has a partial unique index, so redelivery of the same `run_id` no-ops on the second write.
- Webhook event types registered: `ACTOR.RUN.SUCCEEDED`, `ACTOR.RUN.FAILED`, `ACTOR.RUN.TIMED_OUT`, `ACTOR.RUN.ABORTED`. All four resolve the snapshot (either `fresh` or `failed`).

**Secret rotation procedure (dual-secret window):**
1. Edge function accepts EITHER `APIFY_WEBHOOK_SECRET` (current) OR `APIFY_WEBHOOK_SECRET_PREVIOUS` (grace). Both env vars are read and compared in constant time; either match succeeds.
2. Set `APIFY_WEBHOOK_SECRET_PREVIOUS = <current>`, then generate a new random 32-byte token and set `APIFY_WEBHOOK_SECRET = <new>`.
3. New Apify runs registered after this change carry the new secret in their `headersTemplate`. In-flight runs (registered with the previous secret) continue to deliver successfully because the edge function still accepts the previous secret.
4. After the longest possible run duration (we set `timeoutSecs: 120` + Apify processing ≤ 10 min buffer = **15 minutes**), the janitor cron `fail-stuck-refreshing` will have fail-closed any surviving snapshots. Unset `APIFY_WEBHOOK_SECRET_PREVIOUS` to complete rotation.

### 3h. Rendering Submitted Videos

oEmbed for both:
- TikTok: `GET https://www.tiktok.com/oembed?url=<share_url>` → `html`, `thumbnail_url`.
- Instagram: `GET https://graph.facebook.com/v<version>/instagram_oembed?url=<reel_url>&access_token=<app_token>` → thumbnail + attribution. (Note: this needs an app-level Meta token, NOT a creator token; that's still required for oEmbed but is a one-time app setup, not per-user OAuth.)
- Alternative: construct TikTok embed URL `https://www.tiktok.com/embed/v2/<video_id>` directly.

---

## 4. Supabase Database Schema

Applied from `supabase-postgres-best-practices`: RLS enabled on all public tables; FKs indexed; partial indexes for hot filters; `security_invoker` on views; `security definer` functions in private schema.

### 4.1 Tables Overview

| Table | Purpose |
|---|---|
| `users` | Unified account row; role-gated. |
| `creator_profiles` | 1:1 extension; denormalized metrics for fast filtering. |
| `lister_profiles` | 1:1 extension for lister fields. |
| `social_links` | Creator's linked handles (TikTok and/or IG). No tokens — we don't OAuth. |
| `metric_snapshots` | Historized metric data per social_link, one Apify run per row. |
| `listings` | Core campaign row; mutable fields. |
| `listing_versions` | Immutable versioned snapshots. |
| `listing_conditions` | Pre + post conditions, structured rows. |
| `sample_videos` | Sample video URLs per version. |
| `applications` | Creator → listing_version. |
| `submissions` | Deliverables on an approved application. |
| `submission_videos` | N video URLs per submission. |
| `notifications` | In-app inbox. |
| `push_tokens` | Expo push (v1.1). |
| `events` | Append-only audit log. |

*(`oauth_states` is gone — no OAuth.)*

### 4.2 Enums

```sql
create type user_role as enum ('creator', 'lister');
create type platform as enum ('tiktok', 'instagram');
create type listing_status as enum ('draft', 'active', 'paused', 'closed', 'archived');
create type application_status as enum (
  'pending', 'approved', 'rejected', 'withdrawn',
  'cancelled_listing_edit', 'cancelled_listing_closed'
);
create type submission_status as enum ('pending', 'approved', 'rejected');
create type social_link_status as enum ('linked', 'unlinked', 'failed_fetch');
create type metric_status as enum ('fresh', 'stale', 'refreshing', 'failed');
-- Which Apify actor run produced this snapshot. TikTok has one mode; IG has two (details + posts).
create type scrape_mode as enum ('tiktok_profile', 'ig_details', 'ig_posts');
create type condition_kind as enum ('pre', 'post');
create type condition_metric as enum (
  'min_followers', 'min_avg_views_last_n', 'min_total_likes',
  'min_videos_posted', 'verified_only',
  'post_min_video_duration_sec', 'post_max_video_duration_sec',
  'post_min_video_count', 'post_must_mention', 'post_family_friendly',
  'post_must_tag_account'
);
create type notification_kind as enum (
  'application_approved', 'application_rejected', 'application_cancelled',
  'submission_received', 'submission_approved', 'submission_rejected',
  'listing_version_changed', 'metrics_refresh_failed'
);
```

### 4.3 Denormalization

- `creator_profiles.tiktok_follower_count`, `instagram_follower_count`, `_avg_views_last_10`, `metrics_fetched_at` — denormalized from latest `metric_snapshots` via trigger. Enables O(log n) feed filtering.
- `listings.current_version_id` — FK to `listing_versions`, avoids feed join.
- `listings.approved_submissions_count`, `active_pending_applications_count` — trigger-maintained counters.
- `applications.listing_version_id` — makes cascade a single UPDATE.
- `listings.min_followers_tiktok`, `min_followers_ig` — generated columns (MAX across pre-conditions per platform), btree-indexed for feed filter.

### 4.4 RLS Model

Custom JWT issued by our `/auth/*` edge functions (signed with project JWT secret). Payload:
```json
{ "sub": "<user_id>", "role": "creator|lister", "session_id": "<uuid>" }
```
RLS policies read `auth.jwt() ->> 'sub'`. JWT is signed by us, not user-editable. Safe for authz.

### 4.5 Indexes

- Feed: partial index `(status, created_at DESC) WHERE status='active'`.
- Eligibility pre-filter: generated columns `listings.min_followers_tiktok`, `min_followers_ig` btree-indexed.
- Application uniqueness: partial unique `(listing_id, creator_id) WHERE status in ('pending','approved')`.
- Notifications: `(user_id, read_at NULLS FIRST, created_at DESC)`.

### 4.6 Triggers / Functions

All in `app_private` schema (security definer).

| Function | Trigger |
|---|---|
| `bump_listing_version()` | BEFORE UPDATE on `listings` — if versioned field changed, INSERT new version, cascade-cancel pending apps, emit notifications. |
| `denorm_metrics()` | AFTER INSERT on `metric_snapshots` where `is_latest=true` — updates `creator_profiles`. |
| `submission_side_effects()` | AFTER UPDATE on `submissions` when status → `approved` — increments count. (Auto-close-on-max deferred to v1.1.) |
| `emit_event()` | Helper called by state-changing functions. |

### 4.7 Full Migration SQL

```sql
-- =========================================================
-- 0. Extensions
-- =========================================================
create extension if not exists "pgcrypto";
create extension if not exists "pg_cron";
create extension if not exists "citext";

create schema if not exists app_private;
revoke all on schema app_private from anon, authenticated;

-- =========================================================
-- 1. Enums  (see §4.2)
-- =========================================================
-- ... (as above)

-- =========================================================
-- 2. users
-- =========================================================
create table public.users (
  id         uuid primary key default gen_random_uuid(),
  role       user_role not null,
  username   citext not null unique,
  email      citext unique,              -- nullable for creators
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index on public.users (role) where deleted_at is null;

-- =========================================================
-- 3. creator_profiles (denormalized)
-- =========================================================
create table public.creator_profiles (
  user_id                     uuid primary key references public.users(id) on delete cascade,
  display_name                text,
  bio                         text,
  country                     text,
  tiktok_follower_count       integer,
  tiktok_avg_views_last_10    integer,
  tiktok_total_likes          bigint,
  tiktok_video_count          integer,
  tiktok_is_verified          boolean,
  instagram_follower_count    integer,
  instagram_avg_views_last_10 integer,
  instagram_media_count       integer,
  metrics_fetched_at          timestamptz,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);
create index on public.creator_profiles (tiktok_follower_count);
create index on public.creator_profiles (instagram_follower_count);

-- =========================================================
-- 4. lister_profiles
-- =========================================================
create table public.lister_profiles (
  user_id     uuid primary key references public.users(id) on delete cascade,
  org_name    text not null,
  website_url text,
  logo_path   text,
  description text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- =========================================================
-- 5. social_links   (no OAuth fields — Apify-based)
-- =========================================================
create table public.social_links (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid not null references public.users(id) on delete cascade,
  platform                platform not null,
  handle                  citext not null,
  status                  social_link_status not null default 'linked',
  last_scrape_run_id      text,                      -- Apify run id
  last_scrape_attempt_at  timestamptz,
  last_scrape_error       text,
  fail_count              smallint not null default 0,
  -- Soft self-confirmation: set when the creator taps "Yes, that's me" on the
  -- first-scrape confirmation card (design §5.6). Used to gate the card's
  -- visibility. Reset to null on (un)link cycles so the card re-appears for
  -- the re-linked handle. fail_count is also reset to 0 on any fresh snapshot.
  handle_confirmed_at     timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
  -- Active-only uniqueness: unlinked rows release both their `(platform, handle)`
  -- reservation AND the `(user_id, platform)` slot so the same user can relink
  -- (same or different handle) without tripping UNIQUE.
);
create unique index social_links_user_platform_uniq
  on public.social_links (user_id, platform) where status <> 'unlinked';
create unique index social_links_platform_handle_uniq
  on public.social_links (platform, handle) where status <> 'unlinked';

-- History of unlinked rows is retained for audit; an admin override can claim a
-- handle currently held by an unlinked row (no extra logic required — the partial
-- index permits it).

-- =========================================================
-- 6. metric_snapshots (historized, one per Apify run)
-- =========================================================
-- TikTok: 1 row per refresh (scrape_mode='tiktok_profile' — contains followers + avg views).
-- Instagram: 2 rows per refresh (scrape_mode='ig_details' for followers, scrape_mode='ig_posts' for avg views).
-- The denorm trigger updates only the columns owned by each scrape_mode.
create table public.metric_snapshots (
  id                uuid primary key default gen_random_uuid(),
  social_link_id    uuid not null references public.social_links(id) on delete cascade,
  scrape_mode       scrape_mode not null,
  apify_run_id      text,                  -- dedup across webhook retries
  status            metric_status not null,
  follower_count    integer,               -- populated on tiktok_profile + ig_details
  following_count   integer,               -- populated on tiktok_profile + ig_details
  total_likes       bigint,                -- tiktok_profile only
  video_count       integer,               -- tiktok_profile (authorMeta.video) / ig_details (postsCount)
  avg_views_last_10 integer,               -- tiktok_profile + ig_posts
  is_verified       boolean,               -- tiktok_profile + ig_details
  raw_payload       jsonb,                 -- full Apify dataset item(s) for forensics
  fetched_at        timestamptz not null default now(),
  is_latest         boolean not null default false,   -- promoted by trigger under lock
  error_message     text
  -- scrape_mode ↔ social_link.platform coherence enforced by trg_metric_snapshots_coherence below.
);
create index on public.metric_snapshots (social_link_id, fetched_at desc);
-- Only one "latest" snapshot per (social_link, scrape_mode). So IG has at most two latest rows.
create unique index metric_snapshots_latest
  on public.metric_snapshots (social_link_id, scrape_mode) where is_latest;
create unique index metric_snapshots_run_uniq
  on public.metric_snapshots (apify_run_id) where apify_run_id is not null;
-- Janitor cron `fail-stuck-refreshing` scans for rows stuck in 'refreshing' past the
-- 10-min timeout. Partial index keeps this sub-millisecond even with millions of rows.
create index metric_snapshots_stuck_idx
  on public.metric_snapshots (fetched_at) where status = 'refreshing';

-- =========================================================
-- 7. listings + versioning
-- =========================================================
create table public.listings (
  id                                uuid primary key default gen_random_uuid(),
  lister_id                         uuid not null references public.users(id) on delete restrict,
  status                            listing_status not null default 'draft',
  title                             text not null,
  description                       text,
  -- Feed taxonomy. Enum-ish but stored as text for MVP flexibility; canonical list
  -- enforced at edge-function layer against `app_private.listing_categories` view.
  -- Used by the feed filter, by design §5.3's "Find a similar bounty" CTA, and by
  -- the creator notify-me-when-live toggle (§5.5). v1: 'beauty','fashion','fitness',
  -- 'food','tech','gaming','lifestyle','travel','finance','education','music','other'.
  category                          text not null default 'other',
  price_cents                       integer not null check (price_cents >= 0),
  currency                          text not null default 'USD',
  max_submissions                   integer,
  approved_submissions_count        integer not null default 0,
  active_pending_applications_count integer not null default 0,
  end_date                          timestamptz,
  current_version_id                uuid,
  version_number                    integer not null default 1,
  -- Cached thresholds for O(log n) feed filtering. Trigger-maintained by
  -- app_private.refresh_listing_thresholds(listing_id) whenever the current
  -- listing_version's pre-condition rows change.
  min_followers_tiktok              integer,
  min_followers_instagram           integer,
  -- Ephemeral cue consumed by trg_bump_listing_version; NULL in steady state.
  -- Values: 'conditions' | 'sample_videos'. Scalar edits (price/max_submissions/currency)
  -- are detected directly in the trigger from old.* vs new.*.
  version_bump_reason               text,
  created_at                        timestamptz not null default now(),
  updated_at                        timestamptz not null default now(),
  published_at                      timestamptz,
  closed_at                         timestamptz
);
create index listings_feed_idx
  on public.listings (status, created_at desc) where status = 'active';
create index listings_lister_idx on public.listings (lister_id, status);
create index listings_tt_threshold_idx on public.listings (min_followers_tiktok) where status = 'active';
create index listings_ig_threshold_idx on public.listings (min_followers_instagram) where status = 'active';
-- Feed "find a similar bounty" filter (design §5.3): category + price band.
create index listings_category_price_idx
  on public.listings (category, price_cents) where status = 'active';

create table public.listing_versions (
  id                  uuid primary key default gen_random_uuid(),
  listing_id          uuid not null references public.listings(id) on delete cascade,
  version_number      integer not null,
  price_cents         integer not null,
  currency            text not null,
  max_submissions     integer,
  snapshot            jsonb not null,
  previous_version_id uuid references public.listing_versions(id),  -- for diff rendering
  changed_fields      text[] not null default '{}',                 -- e.g. {price_cents, conditions}
  created_at          timestamptz not null default now(),
  unique (listing_id, version_number)
);
create index on public.listing_versions (listing_id, version_number desc);
alter table public.listings
  add constraint listings_current_version_fk
  foreign key (current_version_id) references public.listing_versions(id);

-- =========================================================
-- 8. listing_conditions (data-driven)
-- =========================================================
create table public.listing_conditions (
  id                 uuid primary key default gen_random_uuid(),
  listing_version_id uuid not null references public.listing_versions(id) on delete cascade,
  kind               condition_kind not null,
  metric             condition_metric not null,
  platform           platform,
  operator           text not null default 'gte' check (operator in ('gte','lte','eq','contains','bool')),
  numeric_threshold  numeric,
  text_threshold     text,
  bool_threshold     boolean,
  created_at         timestamptz not null default now()
);
create index on public.listing_conditions (listing_version_id, kind);

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
create index on public.sample_videos (listing_version_id);

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

-- "Also submitted to N other campaigns" chip (the ReuseBadge in design §4.6).
-- Aggregates how many other
-- submissions by the same creator use the same video URL (normalized by
-- external_id, not raw URL, so `?t=30s` variants collapse). The chip is only
-- shown to listers with RLS on submissions so they see their own submission_id
-- + a count — they never see WHICH other campaigns, only HOW MANY.
-- Security-def view so RLS on base tables doesn't mask the count:
-- the view returns aggregates, and we bake in the current lister filter.
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
create index on public.submission_videos (submission_id);

-- =========================================================
-- 12. notifications + push_tokens
-- =========================================================
create table public.notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.users(id) on delete cascade,
  kind       notification_kind not null,
  payload    jsonb not null,
  read_at    timestamptz,
  created_at timestamptz not null default now()
);
create index notifications_inbox_idx on public.notifications (user_id, created_at desc);
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
-- 14. RLS (see §4.4)
-- =========================================================
alter table public.users enable row level security;
alter table public.creator_profiles enable row level security;
alter table public.lister_profiles enable row level security;
alter table public.social_links enable row level security;
alter table public.metric_snapshots enable row level security;
alter table public.listings enable row level security;
alter table public.listing_versions enable row level security;
alter table public.listing_conditions enable row level security;
alter table public.sample_videos enable row level security;
alter table public.applications enable row level security;
alter table public.submissions enable row level security;
alter table public.submission_videos enable row level security;
alter table public.notifications enable row level security;
alter table public.push_tokens enable row level security;
alter table public.events enable row level security;

create or replace function public.current_user_id() returns uuid
language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;
create or replace function public.current_user_role() returns user_role
language sql stable as $$
  select (auth.jwt() ->> 'role')::user_role
$$;

-- Design principles:
--   1. Every policy filters by `current_user_id()` — JWT-derived, never query param.
--   2. Service-role writes (edge functions, triggers) bypass RLS via `security definer`
--      functions; no `bypassrls` role is used for application code.
--   3. Listers see applicants' *public* metrics (via `creator_profiles.public_fields`)
--      only when the creator has an application into one of the lister's own listings.
--   4. Creators never see other creators' submissions, even for the same listing.
--   5. `events` is append-only and service-role only — no application reads.

-- ---------------- users ----------------
create policy users_self_select on public.users for select
  using (id = public.current_user_id());
create policy users_self_update on public.users for update
  using (id = public.current_user_id())
  with check (id = public.current_user_id());
-- Listers see bare minimum (id, username, avatar_url) of any creator who has
-- applied to one of their listings. Enforced via a SECURITY DEFINER view
-- `public.applicant_public_profiles` rather than a SELECT policy on users —
-- keeps the policy simple and prevents accidental column leakage.

-- ---------------- creator_profiles ----------------
create policy creator_profiles_self_rw on public.creator_profiles
  for all using (user_id = public.current_user_id())
  with check (user_id = public.current_user_id());
create policy creator_profiles_lister_read on public.creator_profiles
  for select using (
    exists (
      select 1 from public.applications a
      join public.listings l on l.id = a.listing_id
      where a.creator_id = creator_profiles.user_id
        and l.lister_id = public.current_user_id()
    )
  );

-- ---------------- lister_profiles ----------------
create policy lister_profiles_self_rw on public.lister_profiles
  for all using (user_id = public.current_user_id())
  with check (user_id = public.current_user_id());
-- Public read of lister_profiles.public_fields via a view, not a policy.

-- ---------------- social_links ----------------
create policy social_links_self_rw on public.social_links
  for all using (user_id = public.current_user_id())
  with check (user_id = public.current_user_id());
create policy social_links_lister_read on public.social_links
  for select using (
    exists (
      select 1 from public.applications a
      join public.listings l on l.id = a.listing_id
      where a.creator_id = social_links.user_id
        and l.lister_id = public.current_user_id()
    )
  );

-- ---------------- metric_snapshots ----------------
-- Only is_latest + status='fresh' rows are readable; history is service-role only.
create policy metric_snapshots_self_read on public.metric_snapshots for select
  using (
    is_latest and status = 'fresh'
    and exists (
      select 1 from public.social_links sl
      where sl.id = metric_snapshots.social_link_id
        and sl.user_id = public.current_user_id()
    )
  );
create policy metric_snapshots_lister_read on public.metric_snapshots for select
  using (
    is_latest and status = 'fresh'
    and exists (
      select 1 from public.social_links sl
      join public.applications a on a.creator_id = sl.user_id
      join public.listings l on l.id = a.listing_id
      where sl.id = metric_snapshots.social_link_id
        and l.lister_id = public.current_user_id()
    )
  );
-- Writes: service-role only (webhook receiver, denorm trigger).

-- ---------------- listings ----------------
create policy listings_public_read on public.listings for select
  using (status = 'active');
create policy listings_owner_all on public.listings for all
  using (lister_id = public.current_user_id())
  with check (lister_id = public.current_user_id());

-- ---------------- listing_versions ----------------
create policy listing_versions_read_if_listing_readable on public.listing_versions
  for select using (
    exists (
      select 1 from public.listings l
      where l.id = listing_versions.listing_id
        and (l.status = 'active' or l.lister_id = public.current_user_id())
    )
  );
-- Writes: service-role only (via request_listing_version_bump).

-- ---------------- listing_conditions ----------------
create policy listing_conditions_read_if_version_readable on public.listing_conditions
  for select using (
    exists (
      select 1 from public.listing_versions v
      join public.listings l on l.id = v.listing_id
      where v.id = listing_conditions.listing_version_id
        and (l.status = 'active' or l.lister_id = public.current_user_id())
    )
  );
-- Writes: edge function uses service role after validating lister ownership.

-- ---------------- sample_videos ----------------
create policy sample_videos_read_if_version_readable on public.sample_videos
  for select using (
    exists (
      select 1 from public.listing_versions v
      join public.listings l on l.id = v.listing_id
      where v.id = sample_videos.listing_version_id
        and (l.status = 'active' or l.lister_id = public.current_user_id())
    )
  );

-- ---------------- applications ----------------
create policy applications_creator_rw on public.applications
  for all using (creator_id = public.current_user_id())
  with check (creator_id = public.current_user_id());
create policy applications_lister_read on public.applications for select
  using (
    exists (
      select 1 from public.listings l
      where l.id = applications.listing_id
        and l.lister_id = public.current_user_id()
    )
  );
create policy applications_lister_decide on public.applications for update
  using (
    exists (
      select 1 from public.listings l
      where l.id = applications.listing_id
        and l.lister_id = public.current_user_id()
    )
  )
  with check (
    exists (
      select 1 from public.listings l
      where l.id = applications.listing_id
        and l.lister_id = public.current_user_id()
    )
  );

-- ---------------- submissions ----------------
create policy submissions_creator_rw on public.submissions
  for all using (
    exists (
      select 1 from public.applications a
      where a.id = submissions.application_id
        and a.creator_id = public.current_user_id()
    )
  )
  with check (
    exists (
      select 1 from public.applications a
      where a.id = submissions.application_id
        and a.creator_id = public.current_user_id()
    )
  );
create policy submissions_lister_read on public.submissions for select
  using (
    exists (
      select 1 from public.applications a
      join public.listings l on l.id = a.listing_id
      where a.id = submissions.application_id
        and l.lister_id = public.current_user_id()
    )
  );
create policy submissions_lister_decide on public.submissions for update
  using (
    exists (
      select 1 from public.applications a
      join public.listings l on l.id = a.listing_id
      where a.id = submissions.application_id
        and l.lister_id = public.current_user_id()
    )
  )
  with check (
    exists (
      select 1 from public.applications a
      join public.listings l on l.id = a.listing_id
      where a.id = submissions.application_id
        and l.lister_id = public.current_user_id()
    )
  );

-- ---------------- submission_videos ----------------
-- Join through submissions → applications → listings. Symmetric with submissions.
create policy submission_videos_read on public.submission_videos for select
  using (
    exists (
      select 1 from public.submissions s
      join public.applications a on a.id = s.application_id
      where s.id = submission_videos.submission_id
        and (
          a.creator_id = public.current_user_id()
          or exists (
            select 1 from public.listings l
            where l.id = a.listing_id and l.lister_id = public.current_user_id()
          )
        )
    )
  );
create policy submission_videos_creator_write on public.submission_videos for all
  using (
    exists (
      select 1 from public.submissions s
      join public.applications a on a.id = s.application_id
      where s.id = submission_videos.submission_id
        and a.creator_id = public.current_user_id()
    )
  )
  with check (
    exists (
      select 1 from public.submissions s
      join public.applications a on a.id = s.application_id
      where s.id = submission_videos.submission_id
        and a.creator_id = public.current_user_id()
    )
  );

-- ---------------- notifications + push_tokens ----------------
create policy notifications_self_rw on public.notifications for all
  using (user_id = public.current_user_id())
  with check (user_id = public.current_user_id());
create policy push_tokens_self_rw on public.push_tokens for all
  using (user_id = public.current_user_id())
  with check (user_id = public.current_user_id());

-- ---------------- events ----------------
-- Service role only. No application read/write policy — the absence of any
-- policy + RLS enabled = deny for all non-superuser roles.
-- (Supabase's anon/authenticated roles have no grants to this table either.)
revoke all on public.events from anon, authenticated;

-- ---------------- Cross-tenant integration test plan ----------------
-- (enforced by `tests/rls/*.sql` in CI, running as a JWT-minted session):
-- 1. Creator A cannot SELECT Creator B's social_links, metric_snapshots,
--    applications, submissions, notifications, push_tokens.
-- 2. Lister X cannot SELECT Lister Y's listings (draft), applications,
--    submissions, notifications — even for shared creators.
-- 3. Creator A cannot SELECT Lister X's non-active listings.
-- 4. A creator cannot INSERT a submission for an application they don't own.
-- 5. A lister cannot UPDATE an application status for a listing they don't own.
-- 6. Attempting to subscribe to a Realtime channel the user can't SELECT
--    returns no rows (Supabase Realtime respects SELECT policies).

-- =========================================================
-- 15. Triggers
-- =========================================================
-- Core bump routine — called directly (from listings UPDATE trigger) or via the
-- edge function PATCH /listings/:id after it has applied listing_conditions/sample_videos edits.
-- The edge function is the sole writer to listing_conditions + sample_videos once a listing is active;
-- it calls app_private.request_listing_version_bump(listing_id, reason, changed_fields) AFTER
-- those child edits commit, which performs an UPDATE listings SET ... that fires this trigger.
create or replace function app_private.bump_listing_version()
returns trigger language plpgsql security definer as $$
declare
  versioned_changed boolean;
  new_version_id    uuid;
  prev_version_id   uuid;
  changed_fields    text[] := array[]::text[];
begin
  if old.price_cents     is distinct from new.price_cents     then changed_fields := changed_fields || 'price_cents'; end if;
  if old.currency        is distinct from new.currency        then changed_fields := changed_fields || 'currency'; end if;
  if old.max_submissions is distinct from new.max_submissions then changed_fields := changed_fields || 'max_submissions'; end if;
  -- The edge function passes a cue via the dummy `version_bump_reason` text column (set-and-reset in same UPDATE)
  -- to indicate listing_conditions or sample_videos were edited:
  if new.version_bump_reason is not null then
    changed_fields := changed_fields || new.version_bump_reason;  -- e.g. 'conditions' | 'sample_videos'
    new.version_bump_reason := null;  -- consume the cue
  end if;

  versioned_changed := array_length(changed_fields, 1) > 0;
  if versioned_changed and new.status = 'active' then
    prev_version_id      := old.current_version_id;
    new.version_number   := old.version_number + 1;
    insert into public.listing_versions(listing_id, version_number, price_cents, currency, max_submissions, snapshot, previous_version_id, changed_fields)
      values (new.id, new.version_number, new.price_cents, new.currency, new.max_submissions,
              to_jsonb(new), prev_version_id, changed_fields)
      returning id into new_version_id;
    new.current_version_id := new_version_id;

    -- Capture affected creators BEFORE we update their status (so we can notify only them).
    with cascaded as (
      update public.applications
         set status = 'cancelled_listing_edit', updated_at = now()
       where listing_id = new.id and status = 'pending'
       returning creator_id
    )
    insert into public.notifications(user_id, kind, payload)
      select c.creator_id, 'listing_version_changed',
             jsonb_build_object(
               'listing_id',          new.id,
               'new_version',         new.version_number,
               'previous_version_id', prev_version_id,
               'new_version_id',      new_version_id,
               'changed_fields',      to_jsonb(changed_fields)
             )
        from cascaded c;
  end if;
  return new;
end $$;

create trigger trg_bump_listing_version
  before update on public.listings
  for each row execute function app_private.bump_listing_version();

-- Helper the edge function calls after committing listing_conditions/sample_videos edits.
-- Produces an UPDATE that fires trg_bump_listing_version with the appropriate cue.
--
-- ORDERING CONTRACT (must be followed by the edge function):
--   The edge function owns the full edit txn. Inside ONE transaction it must:
--     1. `select id from public.listings where id = :lid for update;` — serialize against POST /applications and concurrent edits.
--     2. `insert into public.listing_versions (...) returning id into v_new;`
--        (new version row with empty conditions/sample_videos initially)
--     3. `insert into public.listing_conditions (listing_version_id=v_new, ...)` for each pre/post-condition.
--     4. `insert into public.sample_videos (listing_version_id=v_new, ...)` for each sample.
--     5. `select app_private.request_listing_version_bump(:lid, :reason);`
--        This swaps `listings.current_version_id` to v_new atomically. The
--        `trg_bump_listing_version` trigger then runs `refresh_listing_thresholds`
--        against the now-populated v_new, cascades applications, and emits
--        notifications. Because conditions were inserted in step 3 against v_new
--        — which is NOT yet `current_version_id` until step 5 — the per-row
--        `refresh_listing_thresholds()` trigger on `listing_conditions` becomes
--        a no-op (it filters `where listings.current_version_id = NEW.listing_version_id`),
--        so thresholds are computed exactly once, against the full set, at step 5.
--     6. commit.
--
--   Feed queries never observe a partial-conditions state: conditions are
--   written to a version that is not current, then made current atomically.
--
--   The `refresh_listing_thresholds()` trigger on listing_conditions is therefore
--   MUST-filter by `current_version_id = NEW.listing_version_id` and return
--   early otherwise. (See §15 trigger definition — keep this invariant.)
create or replace function app_private.request_listing_version_bump(
  p_listing_id uuid, p_reason text
) returns uuid
  language plpgsql security definer as $$
declare new_ver uuid;
begin
  if p_reason not in ('conditions', 'sample_videos') then
    raise exception 'invalid version bump reason %', p_reason;
  end if;
  update public.listings
     set version_bump_reason = p_reason,
         updated_at = now()
   where id = p_listing_id
  returning current_version_id into new_ver;
  return new_ver;
end $$;

-- Coherence: scrape_mode must match the linked social_link's platform.
-- Trigger-enforced because a CHECK can't reference another table.
create or replace function app_private.check_metric_snapshot_coherence()
returns trigger language plpgsql as $$
declare p platform;
begin
  select platform into p from public.social_links where id = new.social_link_id;
  if p is null then
    raise exception 'social_link % not found', new.social_link_id;
  end if;
  if (p = 'tiktok'    and new.scrape_mode <> 'tiktok_profile')
  or (p = 'instagram' and new.scrape_mode not in ('ig_details', 'ig_posts')) then
    raise exception 'scrape_mode % incoherent with platform %', new.scrape_mode, p;
  end if;
  return new;
end $$;

create trigger trg_metric_snapshots_coherence
  before insert or update of scrape_mode, social_link_id on public.metric_snapshots
  for each row execute function app_private.check_metric_snapshot_coherence();

-- Race-free latest-row promotion + denormalization.
-- Fired BEFORE INSERT so we hold a row-level lock on social_links via advisory lock
-- for the (social_link, scrape_mode) pair. This ensures concurrent webhook redeliveries
-- and manual refreshes cannot both set is_latest=true.
create or replace function app_private.denorm_metrics()
returns trigger language plpgsql security definer as $$
declare
  sl     public.social_links%rowtype;
  lock_key bigint;
begin
  if new.status <> 'fresh' then
    -- 'refreshing' and 'failed' rows never become latest, never denormalize.
    new.is_latest := false;
    return new;
  end if;

  -- Serialize per (social_link_id, scrape_mode). hashtext gives a stable bigint mapping.
  lock_key := hashtextextended(new.social_link_id::text || ':' || new.scrape_mode::text, 0);
  perform pg_advisory_xact_lock(lock_key);

  -- Demote any previous latest for this (social_link, scrape_mode) pair.
  update public.metric_snapshots
     set is_latest = false
   where social_link_id = new.social_link_id
     and scrape_mode    = new.scrape_mode
     and is_latest;

  -- Claim latest for this new row.
  new.is_latest := true;

  -- Denormalize into creator_profiles — only columns owned by this scrape_mode.
  select * into sl from public.social_links where id = new.social_link_id;

  if new.scrape_mode = 'tiktok_profile' then
    update public.creator_profiles
       set tiktok_follower_count    = new.follower_count,
           tiktok_avg_views_last_10 = new.avg_views_last_10,
           tiktok_total_likes       = new.total_likes,
           tiktok_video_count       = new.video_count,
           tiktok_is_verified       = new.is_verified,
           metrics_fetched_at       = greatest(metrics_fetched_at, new.fetched_at),
           updated_at               = now()
     where user_id = sl.user_id;

  elsif new.scrape_mode = 'ig_details' then
    update public.creator_profiles
       set instagram_follower_count = new.follower_count,
           instagram_media_count    = new.video_count,
           metrics_fetched_at       = greatest(metrics_fetched_at, new.fetched_at),
           updated_at               = now()
     where user_id = sl.user_id;

  elsif new.scrape_mode = 'ig_posts' then
    update public.creator_profiles
       set instagram_avg_views_last_10 = new.avg_views_last_10,
           metrics_fetched_at          = greatest(metrics_fetched_at, new.fetched_at),
           updated_at                  = now()
     where user_id = sl.user_id;
  end if;

  return new;
end $$;

create trigger trg_denorm_metrics
  before insert on public.metric_snapshots
  for each row execute function app_private.denorm_metrics();

create or replace function app_private.submission_approved_counter()
returns trigger language plpgsql security definer as $$
declare lst public.listings%rowtype;
begin
  if tg_op = 'UPDATE' and new.status = 'approved' and old.status <> 'approved' then
    select l.* into lst from public.listings l
      join public.applications a on a.listing_id = l.id
      where a.id = new.application_id;
    update public.listings
      set approved_submissions_count = approved_submissions_count + 1
      where id = lst.id;
  end if;
  return new;
end $$;

create trigger trg_submission_approved_counter
  after update on public.submissions
  for each row execute function app_private.submission_approved_counter();

-- Keeps listings.active_pending_applications_count in sync. Drives design §2.5
-- age-bucketed nudge banners and the lister Dashboard "N waiting" tile. The
-- counter reflects applications currently in status='pending' only.
--
-- Tracked transitions (new → effect):
--   INSERT pending                          → +1
--   UPDATE pending → anything else          → -1
--   UPDATE anything else → pending          → +1   (rare: withdraw-undo not in v1, but safe)
--   DELETE where old.status='pending'       → -1
create or replace function app_private.maintain_pending_apps_counter()
returns trigger language plpgsql security definer as $$
declare
  delta smallint := 0;
  target uuid;
begin
  if tg_op = 'INSERT' then
    if new.status = 'pending' then delta := 1; target := new.listing_id; end if;
  elsif tg_op = 'DELETE' then
    if old.status = 'pending' then delta := -1; target := old.listing_id; end if;
  elsif tg_op = 'UPDATE' then
    if new.status = 'pending' and old.status <> 'pending' then delta := 1;  target := new.listing_id; end if;
    if old.status = 'pending' and new.status <> 'pending' then delta := -1; target := new.listing_id; end if;
    -- listing_id is immutable on applications, so old.listing_id = new.listing_id.
  end if;

  if delta <> 0 then
    update public.listings
       set active_pending_applications_count = active_pending_applications_count + delta
     where id = target;
  end if;
  return coalesce(new, old);
end $$;

create trigger trg_maintain_pending_apps_counter
  after insert or update or delete on public.applications
  for each row execute function app_private.maintain_pending_apps_counter();

-- =========================================================
-- 15b. Listing threshold maintenance
-- =========================================================
-- Keeps listings.min_followers_tiktok/instagram in sync with the MAX pre-condition
-- threshold across the listing's CURRENT version. Fired on any write to listing_conditions.
create or replace function app_private.refresh_listing_thresholds()
returns trigger language plpgsql security definer as $$
declare
  v_listing_id       uuid;
  v_current          uuid;
  v_affected_version uuid;
begin
  v_affected_version := coalesce(new.listing_version_id, old.listing_version_id);
  -- Resolve the listing_id from the condition's version (works for INSERT/UPDATE/DELETE).
  select l.id, l.current_version_id
    into v_listing_id, v_current
    from public.listings l
    join public.listing_versions lv on lv.listing_id = l.id
   where lv.id = v_affected_version;

  if v_listing_id is null then
    return coalesce(new, old);
  end if;

  -- Ordering-contract invariant: edge function inserts conditions against a
  -- version that is NOT yet current; only request_listing_version_bump swaps
  -- current_version_id. If the affected row belongs to a non-current version,
  -- skip — thresholds will be recomputed by refresh_thresholds_on_version_bump
  -- when the version swap happens, and at that point the full condition set is
  -- already in place. This prevents partial-set reads during multi-condition edits.
  if v_affected_version <> v_current then
    return coalesce(new, old);
  end if;

  update public.listings
     set min_followers_tiktok = (
           select max(numeric_threshold)::integer
             from public.listing_conditions
            where listing_version_id = v_current
              and kind     = 'pre'
              and metric   = 'min_followers'
              and platform = 'tiktok'
         ),
         min_followers_instagram = (
           select max(numeric_threshold)::integer
             from public.listing_conditions
            where listing_version_id = v_current
              and kind     = 'pre'
              and metric   = 'min_followers'
              and platform = 'instagram'
         ),
         updated_at = now()
   where id = v_listing_id;

  return coalesce(new, old);
end $$;

create trigger trg_listing_conditions_refresh_thresholds
  after insert or update or delete on public.listing_conditions
  for each row execute function app_private.refresh_listing_thresholds();

-- When a listing's current_version_id changes (version bump), recompute thresholds
-- against the new version's condition set.
create or replace function app_private.refresh_thresholds_on_version_bump()
returns trigger language plpgsql security definer as $$
begin
  if new.current_version_id is distinct from old.current_version_id then
    update public.listings
       set min_followers_tiktok = (
             select max(numeric_threshold)::integer
               from public.listing_conditions
              where listing_version_id = new.current_version_id
                and kind = 'pre' and metric = 'min_followers' and platform = 'tiktok'
           ),
           min_followers_instagram = (
             select max(numeric_threshold)::integer
               from public.listing_conditions
              where listing_version_id = new.current_version_id
                and kind = 'pre' and metric = 'min_followers' and platform = 'instagram'
           )
     where id = new.id;
  end if;
  return new;
end $$;

create trigger trg_listings_refresh_thresholds_on_bump
  after update of current_version_id on public.listings
  for each row execute function app_private.refresh_thresholds_on_version_bump();

-- =========================================================
-- 15c. Session revocation (JWT denylist)
-- =========================================================
create table public.revoked_sessions (
  session_id uuid primary key,
  user_id    uuid not null references public.users(id) on delete cascade,
  revoked_at timestamptz not null default now(),
  reason     text,
  -- Set to the session's original `exp` claim so cleanup can safely prune
  -- after the JWT is no longer presentable anyway.
  expires_at timestamptz not null
);
create index on public.revoked_sessions (user_id);
create index on public.revoked_sessions (expires_at);

-- Cache semantics (each edge-function container instance):
--   * In-memory Set<session_id> keyed by session_id, loaded from
--     `select session_id from public.revoked_sessions where expires_at > now()`.
--   * TTL: 5 minutes. (Was 15. Tightened because custom-auth revocation latency
--     is security-material — 5 min is the upper bound on how long a stolen token
--     can still be used after the user clicks "log out everywhere".)
--   * LISTEN channel `revoked_sessions_invalidate` — a NOTIFY is emitted by a
--     trigger on INSERT carrying the new session_id as payload; the container
--     adds it to the Set immediately without a DB roundtrip.
--   * Reconnect policy: whenever the LISTEN connection drops for ANY reason
--     (deploy, network blip, Postgres restart, idle timeout), on successful
--     reconnect the container MUST execute a full reload query — otherwise
--     revocations that happened during the disconnect are lost until the next
--     TTL expiry. `listen_reconnected` events are logged for ops visibility.
--   * Cold start: load the full set synchronously before the container accepts
--     its first request. A cold container accepting requests with a stale
--     denylist is the worst case we're avoiding.
--   * Query path: `if (denylist.has(jwt.session_id)) reject 401`. O(1).
--
-- A JWT presenting a `session_id` that is missing from the denylist but present
-- in the table (e.g., TTL just expired and NOTIFY hasn't fired yet) falls back
-- to a point-lookup on Postgres for `session_id IN :set-of-sids-from-this-request`.
-- This covers the 5-min window without flooding the DB for every request.
create or replace function app_private.notify_revoked_session()
returns trigger language plpgsql as $$
begin
  perform pg_notify('revoked_sessions_invalidate', new.session_id::text);
  return new;
end $$;
create trigger trg_revoked_sessions_notify
  after insert on public.revoked_sessions
  for each row execute function app_private.notify_revoked_session();

-- =========================================================
-- 15d. Signup abuse throttle (per-IP)
-- =========================================================
-- Rolling window of signup attempts keyed by IP hash. Edge function rejects the 6th
-- attempt from the same IP within 1 hour. Cleaned up by cron.
create table public.signup_attempts (
  id            uuid primary key default gen_random_uuid(),
  ip_hash       text not null,                 -- sha256 of client IP + salt
  user_agent    text,
  role_attempted user_role not null,
  success       boolean not null,
  created_at    timestamptz not null default now()
);
create index on public.signup_attempts (ip_hash, created_at desc);

-- =========================================================
-- 16. Cron
-- =========================================================
-- Mark snapshots stale after 24h (surfaces the "Outdated" badge in UI)
select cron.schedule('mark-metrics-stale', '0 * * * *', $$
  update public.metric_snapshots
     set status = 'stale'
   where status = 'fresh' and fetched_at < now() - interval '24 hours' and is_latest;
$$);

-- Janitor for stuck `refreshing` snapshots: if the webhook was lost (payload signed
-- with a rotated secret, endpoint outage during delivery, etc.) the snapshot sits
-- `refreshing` forever. After 10 min we fail-close so the creator sees an error
-- and manual refresh becomes available again.
select cron.schedule('fail-stuck-refreshing', '*/5 * * * *', $$
  update public.metric_snapshots
     set status = 'failed',
         error_message = coalesce(error_message, 'webhook_lost')
   where status = 'refreshing' and fetched_at < now() - interval '10 minutes';
$$);

-- Notifications retention: drop read notifications older than 90 days.
select cron.schedule('prune-read-notifications', '0 3 * * *', $$
  delete from public.notifications
   where read_at is not null and read_at < now() - interval '90 days';
$$);

-- Signup attempt log retention: drop rows > 7d.
select cron.schedule('prune-signup-attempts', '0 3 * * *', $$
  delete from public.signup_attempts where created_at < now() - interval '7 days';
$$);

-- Revoked-sessions retention: drop rows past their original JWT expiry (safe to forget).
select cron.schedule('prune-expired-revocations', '0 3 * * *', $$
  delete from public.revoked_sessions where expires_at < now() - interval '1 day';
$$);

-- Application/submission expiration crons: INTENTIONALLY NOT SCHEDULED — no auto-expire in v1.
```

---

## 5. API / Edge Function Spec Sheet

**Transport mix:**
- **Direct PostgREST** for RLS-safe reads (feed browse, notifications inbox).
- **Edge Functions** for (a) external Apify calls, (b) multi-table atomic writes, (c) business logic, (d) JWT issuance, (e) webhook receivers.
- **Realtime channels** on `applications`, `submissions`, `notifications`.

Role = custom-JWT `role` claim.

### 5.1 Auth

**`POST /auth/signup-creator`**
```ts
interface Req {
  username: string;
  tiktok_handle?: string;
  instagram_handle?: string;        // at least one of the two
  display_name?: string;
  country?: string;
}
interface Res {
  user_id: string;
  jwt: string;
  social_links: { id: string; platform: Platform; handle: string; status: 'linked' }[];
  initial_scrape_queued: boolean;
}
```
**Transaction boundary:** the identity rows (`users`, `creator_profiles`, `social_links`, and pre-created `refreshing` `metric_snapshots` rows) commit in a single Postgres transaction. Apify runs are dispatched **after** the transaction commits — a dispatch failure does NOT roll back the account. The creator gets a working account, the `social_links` row, and a `refreshing` snapshot; the UI displays "Couldn't fetch metrics — we'll retry automatically" and the daily cron picks the link up within 24h. This is intentional: Apify outages shouldn't block signup.

**Per-run outcomes after the commit** (handled inline in the edge function before returning):
- If `.call(input, { waitSecs: 60 })` returns with `status: 'SUCCEEDED'` and items → parse + UPDATE snapshot to `fresh` inline. Counts toward the response's `initial_scrape_queued = false` flag per-platform.
- If it returns with `status: 'RUNNING'` (inside-wait timeout) → webhook completes later. `initial_scrape_queued = true`.
- If it throws (rate limit, 4xx/5xx from Apify) → UPDATE snapshot to `failed` with `error_message`, increment `social_links.fail_count`, return normally. The UI chips the failed mode as "Couldn't fetch" with a retry button.

Signup is idempotent on `(username)` — a duplicate call returns `409 USERNAME_TAKEN` before any Apify dispatch.

**Per-IP throttle:** the edge function computes `sha256(ip + SIGNUP_SALT)` and inserts a `signup_attempts` row. If ≥5 attempts from the same `ip_hash` occurred in the prior 60 minutes (regardless of success/failure), return `429 TOO_MANY_ATTEMPTS` with `retry_after_sec`. Salt rotates quarterly.

Errors: `400 MISSING_HANDLE`, `409 USERNAME_TAKEN`, `409 HANDLE_ALREADY_REGISTERED`, `429 TOO_MANY_ATTEMPTS`.

**`POST /auth/signup-lister`**
```ts
interface Req { username: string; email: string; org_name: string; website_url?: string; }
interface Res { user_id: string; jwt: string; }
```
Same per-IP throttle as `signup-creator` (shared `signup_attempts` table).
Errors: `409 USERNAME_TAKEN`, `409 EMAIL_TAKEN`, `429 TOO_MANY_ATTEMPTS`.

**`POST /auth/signout`**
```ts
interface Req { session_id: string; }
interface Res { ok: true; }
```
Inserts a row into `revoked_sessions` with `expires_at = <jwt exp claim>`. Edge middleware caches the revocation set in-memory (5-min TTL; `LISTEN revoked_sessions_invalidate` pushes inserts live, with force-reload on reconnect — see §15c comments). JWTs with `session_id` in the set are rejected with `401`. Max stale-revocation window = 5 min (TTL) worst-case after a container cold-start that misses a NOTIFY during the one-request reload gap; typical window is zero because NOTIFY is synchronous.

### 5.2 Social Handles & Metrics

**`POST /social/add-handle`** — creator links an additional platform
```ts
interface Req { platform: Platform; handle: string; }
interface Res { social_link_id: string; scrape_run_id: string; }
```
Side effects: insert `social_links` + kick initial Apify run (async, webhook-completed).
Errors: `409 HANDLE_ALREADY_REGISTERED`, `409 PLATFORM_ALREADY_LINKED`.

**`POST /social/update-handle`** — creator changed their username on the platform
```ts
interface Req { social_link_id: string; new_handle: string; }
interface Res { ok: true; scrape_run_id: string; }
```
Side effects: update handle + trigger fresh scrape. Old snapshots retained.
Errors: `409 HANDLE_ALREADY_REGISTERED`.

**`POST /social/unlink`**
```ts
interface Req { social_link_id: string; }
interface Res { ok: true; }
```
Errors: `409 LAST_LINK` (creator must keep ≥1 linked platform).

**`POST /metrics/refresh`** — creator-triggered, rate-limited
```ts
interface Req { social_link_id: string; }
interface Res {
  snapshot_ids: string[];  // 1 for TikTok, 2 for Instagram (details + posts)
  status: 'queued' | 'already_fresh';
  retry_after_sec?: number;
}
```
Side effects: check 6h throttle on `social_links.last_scrape_attempt_at`; for each scrape_mode owed by the platform, insert `metric_snapshots(status=refreshing, scrape_mode=...)` and start the matching Apify run with our webhook.

| Platform | scrape_modes triggered | Actor runs |
|---|---|---|
| `tiktok` | `tiktok_profile` | `clockworks/tiktok-scraper` × 1 |
| `instagram` | `ig_details`, `ig_posts` | `apify/instagram-scraper` × 2 (different `resultsType`) |

Errors: `429 RATE_LIMIT` (with `retry_after_sec`), `502 APIFY_ERROR`.

**Internal cron-invoked function `cron-refresh-metrics`**
- Runs daily (scheduled via Supabase `pg_cron` → edge function).
- Picks up to `APIFY_DAILY_BUDGET` links with `metrics_fetched_at < now() - 24h AND status != 'failed_fetch'`.
- Fires the appropriate scrape_modes per link (TikTok=1 run, IG=2 runs). All async with our webhook.
- **Overlap guard.** Apify slowdowns or budget pressure can cause a run to take longer than 24h, so the next cron firing could overlap its predecessor. The edge function opens its DB transaction with:
  ```sql
  -- 0xC17DEF1E15 is an arbitrary 64-bit key reserved for this cron. Returns
  -- false immediately if another session holds it — the function then exits
  -- with a `cron_refresh_skipped_overlap` event (for ops visibility) and no
  -- Apify runs are queued.
  select pg_try_advisory_lock(hashtextextended('cron-refresh-metrics', 0));
  ```
  The lock auto-releases at txn end (session-scoped via `pg_advisory_lock` would leak on container crash; `pg_try_advisory_xact_lock` is safer). This guarantees at-most-one active refresh cron, regardless of how far behind the previous one ran. The 24h cadence combined with the 10-min `fail-stuck-refreshing` janitor means no single slow run can stall the pipeline indefinitely.

### 5.3 Apify Webhook Receiver

**`POST /webhooks/apify`** — called by Apify when a run finishes
```ts
interface Req {  // Apify payload + our payloadTemplate vars
  eventType:
    | 'ACTOR.RUN.SUCCEEDED'
    | 'ACTOR.RUN.FAILED'
    | 'ACTOR.RUN.TIMED_OUT'
    | 'ACTOR.RUN.ABORTED';
  resource: { id: string; defaultDatasetId: string; status: string; actId: string; };
  // injected via payloadTemplate when we started the run:
  social_link_id: string;
  scrape_mode: 'tiktok_profile' | 'ig_details' | 'ig_posts';
  run_id: string;
  status: string;
  dataset_id: string;
}
interface Res { ok: true; }
```
Security: verify `X-Apify-Webhook-Secret` header (constant-time compare) against `APIFY_WEBHOOK_SECRET`. Idempotent by `run_id` (partial unique index on `metric_snapshots.apify_run_id`).

Flow:
1. Look up the pre-created `metric_snapshots` row by `apify_run_id`. If missing (rare edge case — initial insert failed), create one in `refreshing` state so later steps are idempotent.
2. If `eventType !== 'ACTOR.RUN.SUCCEEDED'`: prepare `status_next=failed`, fill `error_message`, short-circuit to step 5.
3. Fetch dataset items via `client.dataset(dataset_id).listItems({ clean: true })`.
4. Parse per-scrape_mode (see §3e table) — set `follower_count`/`avg_views_last_10`/etc. columns the mode owns, leave others null.
5. **Guarded terminal-state UPDATE** — crucial for Apify's retry semantics, which can deliver `SUCCEEDED` first and a retried `ABORTED` for the same `run_id` later (or vice versa). The update only transitions OUT OF `refreshing`, never between terminal states:
   ```sql
   update public.metric_snapshots
      set status        = :status_next,         -- 'fresh' | 'failed'
          raw_payload   = :items,
          error_message = :error_message,
          -- fetched_at stamped at run-completion, not at webhook-arrival,
          -- so retries don't shift the timestamp forward.
          fetched_at    = :apify_finished_at
    where apify_run_id = :run_id
      and status       = 'refreshing';          -- guard: do nothing if already terminal
   ```
   If zero rows are affected, log a `webhook_duplicate` event and return `200 OK` — idempotent no-op. The first terminal signal wins; later retries are ignored. This keeps a fresh snapshot from being clobbered by a retried-ABORTED.
6. Trigger fires `denorm_metrics()` → updates only the `creator_profiles` columns owned by this `scrape_mode`. (Note: `denorm_metrics()` already short-circuits when the new row's status is not `fresh` — see §15 trigger — so the no-op guard in step 5 also keeps the denorm path clean.)
7. On failure: increment `social_links.fail_count`; if ≥3 consecutive failures across all scrape_modes → `social_links.status=failed_fetch` + notify creator. On success: reset `social_links.fail_count = 0` so the consecutive-failure counter only reflects *uninterrupted* failures.

**IG consistency note:** Because IG needs two runs per refresh, `creator_profiles.metrics_fetched_at` will bump *twice* per refresh (once per webhook). The UI treats "fresh" as `min(metrics_fetched_at_across_modes)`. If one run fails and the other succeeds, the creator still sees a partial update — the failed mode's old value remains stale-but-shown, with a subtle warning chip. (Detail reconciled via `metric_snapshots.status` per mode.)

### 5.4 Listings — Browse (Creator)

**`GET /rest/v1/listings?status=eq.active&...`** — PostgREST direct. Client sends its cached creator metrics as filter params (generated columns make this cheap).

**`GET /listings/:id`** — Edge Function
```ts
interface Res {
  listing: Listing;
  conditions: ListingCondition[];
  sample_videos: SampleVideo[];
  eligibility: {
    eligible: boolean;
    failed_conditions: Array<{ metric; required; actual }>;
    has_active_application: boolean;
  };
}
```

### 5.5 Listings — Manage (Lister)

**`POST /listings`**
```ts
interface Req {
  title: string; description?: string;
  price_cents: number; currency?: string;
  max_submissions?: number | null;
  end_date?: string | null;
  pre_conditions: ListingConditionInput[];
  post_conditions: ListingConditionInput[];
  sample_videos: { platform: Platform; url: string; caption?: string; }[];
  publish: boolean;
}
interface Res { listing_id: string; version_id: string; }
```

**`PATCH /listings/:id`**
```ts
interface Req { /* subset of create */ }
interface Res { listing_id: string; version_id: string; cascaded_applications: number; }
```

**`POST /listings/:id/status`**
```ts
interface Req { action: 'publish' | 'pause' | 'resume' | 'close' | 'archive'; }
interface Res { ok: true; new_status: ListingStatus; }
```

### 5.6 Applications

**`POST /applications`**
```ts
interface Req { listing_id: string; cover_note?: string; }
interface Res { application_id: string; listing_version_id: string; }
```
Server re-evaluates eligibility; notifies lister.
Errors: `403 INELIGIBLE`, `409 ALREADY_APPLIED`, `409 LISTING_NOT_ACTIVE`, `409 LISTING_VERSION_CHANGED`.

**Concurrency contract — closes the race with `bump_listing_version`.** Without row locks, an applicant's `INSERT applications` can interleave with a lister's `UPDATE listings` that triggers the version bump + cascade-cancel, leaving a fresh `pending` row pinned to an already-stale version. The insert txn must serialize on the listing row:

```sql
begin;
-- 1. Pin the listing to this txn. Both POST /applications and the edge-function
--    wrapper of bump_listing_version must take this lock. The bump trigger runs
--    under the UPDATE's own row lock, so they are mutually exclusive.
select id, status, current_version_id
  from public.listings
 where id = :listing_id
 for update;

-- 2. Abort if the listing moved out of 'active' in that window.
-- 3. Re-run eligibility against the NOW-current version_id (not the one the
--    client thought was current when it opened the confirm sheet).
-- 4. Insert applications.listing_version_id = the locked current_version_id.
commit;
```

If the lister's version bump commits first, the creator's txn reads the new `current_version_id` after acquiring the lock; the eligibility rules may now differ, so the edge function re-checks and returns `409 LISTING_VERSION_CHANGED` with the new version's diff, which the client surfaces as "Terms just changed — review before applying" on Campaign Detail. No silent commit against a stale version is possible.

**`POST /applications/:id/withdraw`** — creator
**`POST /applications/:id/approve`** — lister
```ts
interface Req { override_ineligible?: boolean; decision_note?: string; }
```
May return `409 INELIGIBLE_NOW` with `override_allowed=true`.
**`POST /applications/:id/reject`** — lister
```ts
interface Req { decision_note?: string; }
```

### 5.7 Submissions

**`POST /applications/:id/submissions`**
```ts
interface Req { videos: { platform: Platform; url: string }[]; cover_note?: string; }
interface Res { submission_id: string; }
```
Validates URLs via oEmbed; creates submission + videos; notifies lister.
Errors: `403 APPLICATION_NOT_APPROVED`, `409 SUBMISSION_EXISTS`, `422 INVALID_VIDEO_URL`.

**`POST /submissions/:id/approve`** — lister
**`POST /submissions/:id/reject`** — lister
```ts
interface Req { decision_note?: string; }
```

### 5.8 Notifications

**`GET /rest/v1/notifications`** — PostgREST direct.
**`POST /notifications/mark-read`**
```ts
interface Req { ids: string[] | 'all'; }
interface Res { updated: number; }
```
**Realtime** — `supabase.channel('notif').on('postgres_changes', {filter: 'user_id=eq.<me>'}, ...)`.

### 5.9 Realtime Channels

| Channel | Who | Events |
|---|---|---|
| `notifications:user_id=<me>` | both | INSERT |
| `applications:listing_id=<id>` | lister | INSERT, UPDATE |
| `submissions:listing_id=<id>` | lister | INSERT, UPDATE |
| `applications:creator_id=<me>` | creator | UPDATE |
| `submissions:creator_id=<me>` | creator | UPDATE |
| `metric_snapshots:social_link_id=<id>` | creator | INSERT, UPDATE (push metrics-ready) |

**RLS enforcement on Realtime:** Supabase Realtime runs every broadcast row through the table's SELECT policy before sending, so a creator who subscribes to `applications:creator_id=<otherId>` receives zero rows — the underlying policy `creator_id = auth.jwt()->>'sub'::uuid` filters rows at the database, not client-side. Channel filters in the client are an optimization, not a security boundary. Manual test plan for launch: subscribe from Creator A's JWT to a channel filtered on Creator B's id, perform a write against Creator B's data, assert zero events delivered. Automate this in the integration suite.

---

## 6. Eligibility Evaluation Engine

### 6.1 Condition Catalog

| metric | platform | operator | threshold |
|---|---|---|---|
| `min_followers` | tt \| ig | gte | numeric |
| `min_avg_views_last_n` | tt \| ig | gte | numeric |
| `min_total_likes` | tt | gte | numeric |
| `min_videos_posted` | tt \| ig | gte | numeric |
| `verified_only` | tt | bool | boolean (IG can't detect reliably from scrape) |

### 6.2 Evaluator Signature

```ts
type Metric = 'min_followers' | 'min_avg_views_last_n' | 'min_total_likes' | 'min_videos_posted' | 'verified_only';
interface Condition { metric: Metric; platform: 'tiktok' | 'instagram'; operator: 'gte' | 'bool'; threshold: number | boolean; }
interface CreatorMetrics {
  tiktok: { follower_count?: number; avg_views_last_10?: number; total_likes?: number; video_count?: number; is_verified?: boolean; fetched_at?: string } | null;
  instagram: { follower_count?: number; avg_views_last_10?: number; media_count?: number; fetched_at?: string } | null;
}
interface EligibilityResult {
  eligible: boolean;
  failed: Array<{condition: Condition; actual: number | boolean | null}>;
  stale_platforms: string[];
}
function evaluate(conditions: Condition[], metrics: CreatorMetrics): EligibilityResult { ... }
```

### 6.3 Where It Runs

- **Client:** on app resume, loads `creator_profiles` into context. Feed inlines `pre_conditions` per listing; filters locally. Instant "eligible only" toggle.
- **Server (authoritative):** `POST /applications` runs the same TS function on Deno.
- **Approve-time re-check:** `POST /applications/:id/approve` re-runs. Returns `409 INELIGIBLE_NOW` with override.

### 6.4 Scaling Feed to 1000+ Listings

- `listings.min_followers_tiktok/ig` generated (MAX of pre-conditions per platform), btree-indexed.
- Feed query:
  ```sql
  select * from public.listings
  where status = 'active'
    and (min_followers_tiktok is null or min_followers_tiktok <= $creator_tt_followers)
    and (min_followers_instagram is null or min_followers_instagram <= $creator_ig_followers)
  order by created_at desc
  limit 50;
  ```
- Complex conditions (avg views, video count) evaluated client-side after first-pass server filter.

---

## 7. Critical Workflow Sequence Diagrams

### 7.1 Creator Signup + Initial Apify Scrape

```
App           EdgeFn(signup-creator)       Apify API          Our Webhook Fn        DB
 │─POST /auth/signup-creator {username, tt, ig}──>│                                    │
 │                                                  │─INSERT users, creator_profile─────>│
 │                                                  │─INSERT social_links (tt, ig)───────>│
 │                                                  │─INSERT metric_snapshots refreshing ×3
 │                                                  │    (tiktok_profile, ig_details, ig_posts)─>│
 │                                                  │─actor('clockworks/tiktok-scraper').call
 │                                                  │    {profiles:[tt], resultsPerPage:10,
 │                                                  │     profileSorting:'latest'} waitSecs:60─>│
 │                                                  │─actor('apify/instagram-scraper').call
 │                                                  │    {directUrls:[ig_url],
 │                                                  │     resultsType:'details'} waitSecs:60──>│
 │                                                  │─actor('apify/instagram-scraper').call
 │                                                  │    {directUrls:[ig_url],
 │                                                  │     resultsType:'posts',
 │                                                  │     resultsLimit:10} waitSecs:60────────>│
 │                                                  │<─{runs × 3 with datasetIds}────────│
 │                                                  │  (for runs that returned inside 60s,
 │                                                  │   parse + UPDATE snapshot fresh inline;
 │                                                  │   for runs still RUNNING, leave refreshing
 │                                                  │   + register webhook for completion)│
 │<─{jwt, user_id, initial_scrape_queued: true}─────│                                    │
 │                                                                                         │
 │  (30–60s later, app shows "fetching your stats…" skeleton on metrics)                  │
 │                                                                                         │
 │                                                    Apify finishes TikTok run───>│       │
 │                                                                                 │─POST /webhooks/apify
 │                                                                                 │  fetch dataset
 │                                                                                 │  parse items
 │                                                                                 │─UPDATE metric_snapshots fresh─>DB
 │                                                                                 │   (trg denorm → creator_profiles)
 │  Realtime push metric_snapshots INSERT ─────────────────────────────────────────────────│
 │  UI updates follower count + avg views                                                    │
```

### 7.2 Creator Apply Flow

```
App              Client cache            EdgeFn(applications)         DB
 │─tap Apply────────>│                                                  │
 │ client eligibility│                                                  │
 │─POST /applications────────────────────────>│                         │
 │                                              │─SELECT listing+version+conds│
 │                                              │─SELECT creator_profiles─────│
 │                                              │─evaluate() server-side─────│
 │                                              │─INSERT applications────────>│
 │                                              │─INSERT notification(lister)>│
 │<─{application_id}────────────────────────────│                            │
 Realtime: lister sees INSERT on applications
```

### 7.3 Lister Edit → Cascade

```
Lister app    EdgeFn(listings PATCH)    DB (trigger)              Affected creators
 │─PATCH /listings/:id price──>│                                       │
 │                              │─UPDATE listings──────────────────────>│
 │                              │            trg_bump_listing_version  │
 │                              │            ├─INSERT listing_versions │
 │                              │            ├─UPDATE applications SET cancelled_listing_edit│
 │                              │            └─INSERT notifications     │
 │<─{version_id, cascaded=12}───│                                      │
                                                             Realtime push to each creator
```

### 7.4 Submit → Review

```
Creator app    EdgeFn(submissions)       oEmbed          DB              Lister app
 │─POST /applications/:id/submissions─>│                                    │
 │                                      │─validate URLs─>│                  │
 │                                      │<─200/404──────│                  │
 │                                      │─INSERT submissions+videos────>│    │
 │                                      │─INSERT notification──────────>│    │
 │<─{submission_id}─────────────────────│                             │Realtime├─>lister UI
 │                                       (lister reviews, approves)    │       │
 │                                      <─POST /submissions/:id/approve───────│
 │                                      │─UPDATE submissions approved──>│    │
 │                                      │─INSERT notification(creator)─>│    │
 │ Realtime update ────────────────────────────────────────────────────│    │
```

### 7.5 Metrics Refresh (Creator-Triggered)

```
App     EdgeFn(metrics/refresh)   Rate limiter   Apify API       Webhook Fn     DB
 │─POST /metrics/refresh sl_id─>│                                                 │
 │                               │─last_scrape_attempt_at within 6h?──>│          │
 │<─429 {retry_after_sec}────────│ (denied)                                       │
 │                               │ (allowed)                                       │
 │                               │ For each scrape_mode owed by platform:         │
 │                               │   INSERT snapshot(status=refreshing,           │
 │                               │                   scrape_mode=X)──>DB          │
 │                               │   actor.start(actor_for(X), input_for(X),      │
 │                               │               webhook{scrape_mode:X,           │
 │                               │                       social_link_id})─>│      │
 │                               │<──{run_id}──────────────────────────────│      │
 │<─{snapshot_ids[], status: queued}                                               │
 │                                                                                  │
 │  (30–60s later, one webhook per run)                                              │
 │                               Apify run 1 done───>│                              │
 │                                                    │─POST /webhooks/apify         │
 │                                                    │  parse by scrape_mode         │
 │                                                    │─UPDATE snapshot fresh───────>DB
 │                                                    │   (trg denorm_metrics branches│
 │                                                    │    on scrape_mode, updates    │
 │                                                    │    only owned columns)        │
 │ Realtime push metric_snapshots UPDATE────────────────────────────────────────────│
 │                                                                                  │
 │  IG case: second run lands a few seconds later — same webhook path, other mode    │
 │                                                                                  │
 │  On failure path:                                                                 │
 │  Webhook Fn: UPDATE snapshot failed, social_link.fail_count++                     │
 │  if fail_count >= 3: status=failed_fetch + notification                           │
```

---

## 8. MVP Scope Cuts

Everything below is **explicitly out of v1** and tracked for v1.1 / v2 consideration. None of this is an oversight; each item was considered and cut.

1. **No payment.** `price` is display-only. Off-platform handshake.
2. **No OAuth / platform integrations.** Apify does all scraping.
3. **No IG Business/Creator requirement.** Apify works on personal accounts too.
4. **No post-submission performance tracking.** v2 "Marketify Analytics".
5. **No lister dashboard analytics.** Counts only.
6. **No admin moderation console.** Reports land in a table; admins work via Supabase Studio.
7. **No revision-request flow.** Binary approve/reject only.
8. **No push notifications.** In-app + Realtime only.
9. **No auto-expire** for applications, submissions, or listings — manual close only.
10. **No auto-close-on-max-submissions.** v1.1.
11. **Sample videos: URL only** — no Storage upload in v1.
12. **No blocklists.** Report-only.
13. **No in-app chat.** Out of scope.
14. **No dark mode.** v2.
15. **No handle ownership verification** — first-to-register wins.

---

**Ready for build.** Step 1 is the migration from §4.7; step 2 is Apify client + webhook receiver edge function; step 3 is signup flows. See `product-plan.md` §6 for the full build sequence.

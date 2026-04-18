# Marketify

A mobile marketplace where independent creators claim paid content bounties posted by companies. Built as a four-week MVP on Expo + React Native + Supabase.

> **Two roles, one loop.** Listers post campaigns with eligibility rules. Creators see only campaigns they qualify for, apply, get approved, film, submit a video URL, and get reviewed. No payment rails in v1 — the cash handshake happens off-platform.

---

## Core user loop

```
CREATOR                                   LISTER
────────                                  ──────
Sign up: username + handle(s)             Sign up: username + email + org
        │                                         │
(Apify scrapes profile ~30s)                      ↓
        │                                  Create campaign (5-step wizard)
        ↓                                         │
Discover feed (eligible-only by default) ◄── Publish → status=active
        │
        ↓
Tap campaign → live eligibility check
        │
        ↓ (if eligible)
Apply (optional pitch) ─────────────────► Lister inbox (Realtime)
                                                  │
                                                  ↓
                                        Approve / Reject
                                        (re-check eligibility,
                                         override dialog if drifted)
        ◄─────────────────────────────────────────┘
        │ (if approved)
        ↓
Submit video URL (oEmbed-validated) ────► Lister inbox (embedded video +
                                          post-condition checklist)
                                                  │
                                                  ↓
                                        Approve / Reject (with feedback)
        ◄─────────────────────────────────────────┘
```

Cross-cutting:

- **Listing versioning.** Edits to versioned fields create a new `listing_versions` row, cascade-cancel pending applications, and notify affected creators — atomically, in a single trigger.
- **Metric refresh.** Daily cron + manual pull-to-refresh (throttled 1 per 6h per platform). A staleness chip appears after 24h.
- **Realtime everywhere.** Notifications, applications, submissions, and metric snapshots all push over Supabase Realtime — no polling.

---

## Feature inventory

### Creator

| Surface | What it does |
|---|---|
| **Signup** | Pick a username and at least one of `tiktok_handle` / `instagram_handle`. Apify kicks off in the background; metrics typically populate before the user reaches Discover. |
| **Discover feed** | All active listings, filtered to *only* what the creator qualifies for by default (toggle off to see ineligible). Pre-condition thresholds (follower count, avg views) are evaluated against the creator's denormalized cache for O(log n) filtering. Pull-to-refresh. |
| **Listing detail** | Full campaign card with live eligibility evaluation, sample videos (TikTok / Instagram embeds), pre-conditions, post-conditions, max submissions, and reuse hints. |
| **Apply flow** | Optional pitch. Server re-checks eligibility before insert. Surfaces server-side error states (`NOT_ELIGIBLE`, `ALREADY_APPLIED`, `CAP_REACHED`) inline. |
| **My Applications** | Pending / approved / rejected / cancelled tabs. Realtime status changes animate in. |
| **Submission composer** | Paste a TikTok or Instagram URL → oEmbed validation → self-affirm post-condition checklist → submit. |
| **My Submissions** | Pending / approved / rejected with lister feedback if rejected. |
| **Profile** | Linked handles with metrics, manual pull-to-refresh, add / update / unlink. Unlink atomically clears the platform's denorm cache so re-linking a different handle doesn't show stale numbers. |
| **Notifications inbox** | In-app only (no push in v1). Bell badge with unread count, deep-links into the relevant screen. |

### Lister

| Surface | What it does |
|---|---|
| **Signup** | Username + email + org name. Plain JWT issued by our edge function, no email verification in v1. |
| **Dashboard** | At-a-glance counts: active campaigns, pending applications, pending submissions. |
| **Create-campaign wizard** | 5 steps — Basics → Pre-conditions → Post-conditions → Samples + max submissions → Review + publish. Draft is preserved across step navigation; preview shows the creator-side card. |
| **My Campaigns** | Active / inactive segments. Quick-edit, close, and delete actions. |
| **Edit campaign** | All versioned fields editable; saving any of them shows the **cascade-cancel modal** — *"This will cancel N pending applications"* — with single-prompt deduplication when both versioned and non-versioned changes are saved together. Sample video URLs are editable through a server-side path that respects RLS (lister has read-only on `sample_videos`). |
| **Applications inbox** | Realtime-updating list with each applicant's metrics surfaced inline. |
| **Application review** | Approve / reject. On approve, eligibility is re-evaluated; if the applicant drifted out of the threshold between apply and approve, an **OverrideEligibilityDialog** lets the lister approve anyway with intent. |
| **Submissions inbox** | Realtime list. Each row shows the embedded video preview, applicant, and reuse badge if the URL has been submitted to other campaigns. |
| **Submission review** | Embedded video (WebView), per-post-condition checklist, optional feedback, approve / reject. Status change animates on the creator's side over Realtime. |
| **Notifications inbox** | Same shape as the creator's. |

### Cross-cutting

- **Custom JWT auth.** HS256 signed by an edge function. No Supabase Auth — a deliberate choice so the same JWT carries our `app_role` claim into RLS without an OAuth dance.
- **Apify integration.** `clockworks/tiktok-scraper` (one run per TikTok refresh) and `apify/instagram-scraper` (two independent runs per IG refresh: `details` + `posts`). Webhook receiver verifies a shared secret, persists `metric_snapshots`, and a `BEFORE INSERT` trigger updates the per-user denormalized cache columns on `creator_profiles`, serialized with `pg_advisory_xact_lock`.
- **Eligibility engine.** Pre-conditions live as a JSONB array on the listing; the trigger maintains `listings.min_followers_tiktok` / `min_followers_instagram` cache columns for fast feed filtering. Live evaluation on the listing detail screen reads the freshest snapshot.
- **Listing versioning + cascade-cancel.** A SECURITY DEFINER trigger in `app_private` bumps a version on edits to versioned fields, copies the row, marks pending applications `cancelled_listing_edit`, and inserts notifications — all in one transaction.
- **Metric staleness marker.** Hourly cron flips snapshots `>24h old` to `status='stale'`, surfacing the "Outdated" chip on the profile screen.
- **Realtime subscriptions.** Notifications, applications, submissions, and metric_snapshots are all in the realtime publication. Both sides of the marketplace stay in sync without polling.
- **Append-only events table.** Every state-changing action writes a row for audit and future analytics.

---

## Tech stack

| Layer | Choice |
|---|---|
| Mobile runtime | Expo (managed) ~54, React Native 0.81, React 19, TypeScript (strict) |
| Routing | `expo-router` v6 with grouped routes (`(auth)`, `(creator)`, `(lister)`, `(dev)`) |
| Animations | `react-native-reanimated` 4 worklets — three spring presets, press-collapse shadows, celebration bursts, `useReducedMotion` honored everywhere |
| Icons | `lucide-react-native` (no emoji in product UI) |
| Storage | `react-native-mmkv` for persisted slices, `expo-secure-store` for the JWT |
| Backend | Supabase — Postgres + Edge Functions (Deno) + Realtime + `pg_cron` |
| Auth | Custom HS256 JWT signed by `auth-signup-*` edge functions |
| Metrics | Apify scrapers with webhook callbacks |
| Package manager | `bun` |

---

## Project structure

```
app/                            expo-router routes
  (auth)/                         signup screens (creator + lister)
  (creator)/                      4-tab creator app (Discover / Applied / Submitted / Profile)
  (lister)/                       4-tab lister app (Home / Campaigns / Inbox / Profile) + create-campaign FAB
  (dev)/                          internal previews (primitives, etc.)

src/
  components/primitives/          Button, Chip, StatusPill, BottomSheet, Toast, …
  components/shared/              EmptyState, ErrorState, ReuseBadge, …
  screens/                        screen-specific composites (campaign-wizard, listing-detail, …)
  lib/                            supabase client, auth context, oembed, time, storage
  design/                         tokens (colors, spacing, radii, shadows), typography, motion presets
  types/                          generated supabase.ts + hand-written types

supabase/
  functions/                      edge functions (auth, apply, submit, decide, apify-webhook, metrics-refresh, …)
  functions/_shared/              shared Deno utilities
  migrations/                     append-only SQL, named us_NNN_short_description

docs/
  product-plan.md                 canonical product, scope, build sequence
  design.md                       visual language, components, screens, motion
  tech-architecture.md            DB schema, RLS, triggers, Apify integration

scripts/
  ralph/                          autonomous-loop driver and per-iteration story config
  test/                           one-off probe scripts
```

---

## Edge functions

| Function | Purpose |
|---|---|
| `auth-signup-creator` | Creates `users` + `creator_profiles` + `social_links`, kicks Apify runs, returns JWT. |
| `auth-signup-lister` | Creates `users` + `lister_profiles`, returns JWT. |
| `dev-signin` | Dev-only convenience: issues a JWT for an existing user (gated, not deployed in prod). |
| `manage-social-link` | Add / unlink social handles; unlink clears denorm cache + drops snapshots atomically. |
| `metrics-refresh` | Manual pull with 1-per-6h-per-platform throttle; returns 429 on cooldown. |
| `apify-webhook` | Verifies shared secret, fetches dataset, dispatches by `scrape_mode` to per-mode persist RPCs. |
| `create-listing` | Lister 5-step wizard endpoint. |
| `update-listing-samples` | Server-side write path for sample videos (lister has read-only RLS). |
| `get-listing-detail` | Listing + conditions + live eligibility for the creator-side detail screen. |
| `apply-to-listing` | Server-side eligibility re-check + insert. |
| `decide-application` | Lister approve/reject with re-check + override path. |
| `submit-video` | oEmbed-validated submission. |

---

## Getting started

### Prereqs

- Node 20+ and **bun** (npm/yarn/pnpm not supported)
- Supabase project (URL + anon key + service-role key)
- Apify account (`APIFY_KEY`)
- iOS Simulator (Xcode) or Android emulator for mobile testing

### Install

```bash
bun install
```

### Environment

Copy `.env.example` to `.env` and fill in:

```
APIFY_KEY=…
SUPABASE_URL=…
SUPABASE_ANON_KEY=…
MARKETIFY_JWT_SECRET=…
APIFY_WEBHOOK_SECRET=…
APIFY_WEBHOOK_SECRET_PREVIOUS=…   # optional — used for zero-downtime secret rotation
```

`MARKETIFY_JWT_SECRET` is the HS256 secret used by both the edge functions and the Postgres `jwt.verify` helper — keep them in sync.

### Run

```bash
bun start            # Expo dev server
bun run ios          # iOS Simulator
bun run android      # Android emulator
```

### Quality gates

```bash
bun run typecheck    # tsc --noEmit — must be zero errors
bun run lint         # expo lint — no new warnings
```

After any schema or RLS change, run Supabase security advisors and confirm zero error-level findings.

---

## Hard scope rules (v1)

These are intentional cuts — not bugs.

- **No payments.** `price_cents` is display-only; the cash handshake is off-platform.
- **No platform OAuth.** Public-profile scrape via Apify is the only metric source.
- **One role per account.** Creator-listers make two accounts.
- **No push notifications.** In-app inbox only.
- **No revision-request flow.** Binary approve/reject; the column is reserved for v1.1.
- **No dark mode.** Neubrutalism translates cleanly but doubles visual QA.
- **No auto-expiration.** Applications and submissions stay open until acted on.
- **Handles are unverified.** A spoofed handle passes the numeric pre-check but the lister still judges the submitted video before approving.

---

## Documentation

| Doc | Purpose |
|---|---|
| `docs/product-plan.md` | Canonical product spec, scope decisions, build sequence |
| `docs/design.md` | Visual language, color palette, typography, component inventory, motion |
| `docs/tech-architecture.md` | DB schema, RLS, triggers, Apify wiring, edge-function specs, eligibility engine |
| `AGENTS.md` | Conventions for AI coding agents working on the repo |

The three docs in `docs/` are the source of truth. Pivots that change a major decision must be reflected in all three — not silently in one.

---

## License

Private. All rights reserved.

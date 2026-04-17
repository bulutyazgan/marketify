# Marketify — Product Plan

*The canonical product spec. Synthesizes the initial PRD with the design (`design.md`) and technical (`tech-architecture.md`) plans, which hold authoritative detail.*

---

## 0. TL;DR

A mobile marketplace (Expo + React Native + Supabase) where creators claim bounties from companies.

- **Two roles**, chosen at onboarding (no dual-role accounts in v1).
- **Creators** sign up with a username + at least one social handle (TikTok and/or Instagram). **No OAuth** — we pull public profile data via **Apify scrapers** (`clockworks/tiktok-scraper` and `apify/instagram-scraper`). The app trusts whatever handle the creator types; handle ownership is unverified in v1.
- **Listers** sign up with username + email + org name.
- Listers post campaigns with **pre-conditions** (follower/view thresholds) and **post-conditions** (content rules).
- Creators see only eligible campaigns by default, apply, get approved, film, submit a video URL, get reviewed.

**Design language:** Disciplined Neubrutalism — hard shadows, 2px ink borders, pink/orange creator-economy palette, Reanimated-driven micro-interactions.

**No payments in v1.** `price_cents` is display-only; the creator–lister payment handshake happens off-platform.

---

## 1. The Core User Loop

```
CREATOR                                   LISTER
────────                                  ──────
Sign up with username + handle(s)         Sign up with username + email
        │                                         │
(Apify scrapes profile                            ↓
 in background ~30s)                      Create campaign (5-step wizard)
        │                                         │
        ↓                                         ↓
Browse feed ←─────────────────── Publish → status=active
   │  (filter: eligible only — default)
   ↓
Tap campaign → eligibility evaluated live
   │
   ↓ (if eligible)
Apply (optional pitch) ─────────────────► Lister inbox (Realtime)
                                             │
                                             ↓
                              Approve / Reject application
   (Realtime push to creator) ◄──────────────┘
   │
   ↓ (if approved)
Film → paste video URL ─────────────────► Lister review (embedded video + post-condition checklist)
                                             │
                                             ↓
                              Approve / Reject submission
   (Realtime push to creator) ◄──────────────┘
```

Two cross-cutting mechanics the PRD surfaced:

- **Listing versioning + auto-cancel.** Editing price, pre-conditions, post-conditions, sample videos, or `max_submissions` bumps a version and cascades `cancelled_listing_edit` to all pending applications, with notifications.
- **Metrics refresh.** Creators can't edit their numbers. Pulled via Apify on sign-up, refreshed daily by cron, or manually pulled once per 6 hours per platform via pull-to-refresh.

---

## 2. Identity Model — Apify, not OAuth

The PRD's original ask was *"no auth — users just select a role and create an account with a username and social media links."* TikTok and Instagram APIs both require OAuth (TikTok's `user.info.stats` scope; IG's Business/Creator Graph API token) to expose follower and view counts — unacceptable friction for a consumer app. Our answer: skip the platform APIs entirely and scrape public profile pages via Apify.

- **Creators** sign up with: username + at least one of `tiktok_handle`, `instagram_handle`. No password, no platform consent, no Business/Creator account conversion, no server-side OAuth token management.
- A custom JWT signed by our edge function is the session. No Supabase Auth.
- At signup, we kick up to three Apify runs (TikTok profile, IG details, IG posts) with a 60s `waitSecs` — the common case is that metrics populate before the user finishes the next screen.
- **Trust model:** handles are *unverified.* A creator could type a handle they don't own, and we would scrape and display that account's metrics against their profile. In v1 we accept this risk because (a) it doesn't give them money — `price` is display-only — and (b) listers re-check eligibility at approval time and see the actual submitted video's author before approving. Verification can ship in v2 via a TikTok/IG "post this code in your bio" challenge if abuse emerges.

**Trade-off with listers:** listers trust the displayed metrics when reviewing applications. If a creator spoofs a popular handle, they pass the numeric pre-check but the lister still judges the *submitted video* — the fraud is self-limiting. We surface handles in monospace (`@xxx`) so listers can tap through to verify before approving.

---

## 3. Scope — What Ships in v1

### 3.1 IN (build this first)

**Foundations**
- Supabase project + full schema (`tech-architecture.md` §4.7)
- Custom JWT auth signed by our edge function (RLS-aware)
- Design tokens + base component library (Neubrutalism primitives)
- Apify client wrapper + webhook receiver edge function

**Creator**
- Handle-based signup (username + TikTok and/or Instagram handle)
- Initial Apify scrape on sign-up (synchronous `waitSecs: 60`, falls back to webhook completion)
- 6h-throttled manual metrics refresh + daily cron
- Campaign feed with client-side eligibility filter (`Eligible only` toggle, default on)
- Campaign detail with live eligibility evaluation
- Apply flow with server-side eligibility re-check
- My Applications (pending / approved / rejected / cancelled)
- Submission composer (paste URL → oEmbed validate → self-affirm post-conditions)
- My Submissions (pending / approved / rejected)
- Profile (linked handles, metrics, pull-to-refresh, add/update/unlink)
- In-app notifications inbox

**Lister**
- Username/email signup
- 5-step create-campaign wizard
- My Campaigns (active / inactive)
- Edit campaign with cascade-cancel confirmation (*"This will cancel N applications"*)
- Applications inbox (with creator metrics surfaced)
- Application review (approve with optional re-eligibility override, reject)
- Submissions inbox
- Submission review (embedded video + post-condition checklist + feedback)
- In-app notifications inbox

**Cross-cutting**
- Listing versioning + cascade trigger (Postgres trigger, §4.7)
- Metrics staleness marker cron (hourly; surfaces "Outdated" chip after 24h)
- Realtime subscriptions (notifications, applications, submissions, metric_snapshots)
- Append-only `events` audit table

### 3.2 OUT — explicitly cut from v1

| # | Cut | Why | Revisit |
|---|---|---|---|
| 1 | Payment / escrow / Stripe | `price` is display-only; off-platform handshake | v2 |
| 2 | Post-submission performance tracking (view count, ROI) | Requires repeated Apify runs per submission | v2 as "Marketify Analytics" |
| 3 | Push notifications | APNs/FCM provisioning friction | v1.1 |
| 4 | Revision-request flow on submissions | Reduces state-machine complexity; column reserved | v1.1 |
| 5 | Handle ownership verification ("post this code in your bio") | Accept spoofing risk in v1; self-limiting via submission review | v2 if abuse emerges |
| 6 | In-app admin moderation UI | Reports logged to table, admin via Supabase Studio | v2 |
| 7 | Lister analytics dashboard | Just counts in v1 | v2 |
| 8 | Creator/lister blocklists | Report-only | v2 |
| 9 | In-app chat | Out of scope | v2 |
| 10 | Auto-close-on-max-submissions | Listers close manually; re-add when usage clarifies | v1.1 |
| 11 | Sample-video upload to Storage | External URLs only (TikTok/IG links) | v2 |
| 12 | Dark mode | Neubrutalism translates but doubles visual QA | v2 |
| 13 | A single user being both creator and lister | One role per account — creator-listers make two accounts | v2 |
| 14 | Application/submission expiration timers | Kept the pipeline open indefinitely — listers close manually | v1.1 if pipelines clog |

---

## 4. Key Technical Decisions

Detail lives in `tech-architecture.md` §1 (design decisions) and §3 (Apify integration).

| Area | Decision |
|---|---|
| **Metric source** | Apify scrapers: `clockworks/tiktok-scraper` (1 run per TikTok refresh) and `apify/instagram-scraper` (2 runs per IG refresh: `resultsType=details` + `resultsType=posts`). No OAuth, no Business/Creator requirement. |
| **Versioned fields** | `price`, `currency`, `max_submissions`, pre-conditions, post-conditions, sample videos. Editing any of these bumps a version and cascades `cancelled_listing_edit` to pending applications. |
| **Role cardinality** | One role per account. Dual-role users make two accounts. |
| **Revision flow** | Binary approve/reject. No "request changes" in v1; column reserved for v1.1. |
| **Auto-expiration** | None. Applications and submissions stay in their inbox until acted on. Listings close only when the lister closes them. |
| **Submission re-use** | A single video URL may be submitted to multiple campaigns. Surfaced to the lister via `ReuseBadge` ("also submitted to N other campaigns") but never blocked. |
| **Eligibility re-check** | Re-evaluated at lister approve-time, not at submission-time. Prevents metric-gaming; approval locks the creator in at that moment's numbers. Lister sees `OverrideEligibilityDialog` if the applicant drifted out of eligibility between apply and approve. |

**Supporting architectural calls:**

- Denormalized creator metrics on `creator_profiles` (`tiktok_follower_count`, `instagram_avg_views_last_10`, etc.) — populated by a `BEFORE INSERT` trigger on `metric_snapshots`, scoped by `scrape_mode`, serialized with `pg_advisory_xact_lock`.
- Trigger-maintained `listings.min_followers_tiktok` / `min_followers_instagram` cache columns, btree-indexed for O(log n) feed filtering. Plain `integer` columns (not `GENERATED ALWAYS AS`) because the source lives in another table.
- `metric_snapshots.scrape_mode` enum (`tiktok_profile` | `ig_details` | `ig_posts`) — lets a single Apify webhook resolve into the correct subset of denormalized fields. IG's two runs land independently and can partially succeed.
- Manual refresh throttle: 1 per 6h per `(user, platform)` — `429` returned from edge function before any Apify call.

---

## 5. Design System Summary

Full details in `docs/design.md`. Highlights:

- **Style:** Neubrutalism (hard shadows, 2px ink borders, 12px card radius, 999px pill radius).
- **Palette:** Pink primary `#EC4899`, Orange CTA `#F97316`, warm canvas `#FFF9F2`, four semantic status colors with soft-bg variants.
- **Typography:** Clash Display (display/heading), Satoshi (body/caption), JetBrains Mono (URLs/handles).
- **Motion:** Reanimated 3 worklets. Three spring presets (soft/snappy/bouncy). Press-collapse shadows on every pressable. Celebration burst on approval. Shake on rejection. `useReducedMotion` respected everywhere.
- **Icons:** Lucide React Native only. No emoji.
- **Tabs:** 4 per role. Creator = Discover / Applied / Submitted / Profile. Lister = Home / Campaigns / Inbox / Profile. Lister has a FAB for create-campaign.

---

## 6. Build Sequence (12 steps)

Each step ends with something demonstrable. Numbered for checkpointing.

1. **Supabase project + migration.** Apply the full schema from `tech-architecture.md` §4.7 (including `scrape_mode` enum, `metric_snapshots` v2 shape, denorm trigger). Seed: one lister, one active listing, one creator with two linked handles and fake metric snapshots. Verify RLS blocks cross-user reads.
2. **Custom JWT edge function + `/auth/signup-lister`.** Listers can create accounts and receive a JWT. Round-trip tested with curl. JWT claims validated by RLS on a shared read.
3. **Apify client wrapper + webhook receiver.** Edge function `apify-core` exposes `.runTikTokProfile(handle)`, `.runInstagramDetails(handle)`, `.runInstagramPosts(handle)`. `POST /webhooks/apify` verifies the shared secret, fetches the dataset, upserts `metric_snapshots` by `apify_run_id`, branches on `scrape_mode`. Demonstrate against live Apify sandbox with two test handles.
4. **`/auth/signup-creator` + initial scrape.** Handle-based signup inserts `users` + `creator_profiles` + `social_links` rows, then kicks the scraper runs synchronously (60s wait) and falls back to webhook completion. Demonstrate via curl: signup returns JWT; within 60s, `creator_profiles` has populated metrics; Supabase Studio shows the `metric_snapshots` rows.
5. **Metric refresh plumbing.** `POST /metrics/refresh` with the 6h throttle + `pg_cron` daily job. Manual pull works; throttle returns `429`. Cron populates stale profiles.
6. **Design tokens + primitive component library.** Colors, typography, spacing, `ButtonPrimary`, `ButtonSecondary`, `Chip`, `StatusPill`, `CampaignCard`, `SkeletonCard`, `BottomSheet`, `Toast`. Each with a Storybook-style preview screen.
7. **Creator feed + eligibility filter.** Direct PostgREST query with generated-column filters. Client-side fine-grained eligibility. Pull-to-refresh.
8. **Campaign detail + apply flow.** `GET /listings/:id` edge function returns listing + conditions + live eligibility. Apply modal → `POST /applications` with server re-check. Toast on success.
9. **Create-campaign wizard (lister).** 5 steps → `POST /listings`. Draft + publish. Review step shows creator-side preview.
10. **Applications inbox + review (lister) + My Applications (creator).** Lister approves/rejects. Realtime updates on both sides. Eligibility re-check on approve with override dialog.
11. **Submission composer + review.** Creator pastes URL → oEmbed validation → submit. Lister embeds video (WebView), checks post-conditions, approves/rejects. Status change animations wired.
12. **Notifications + polishing pass.** In-app inbox, bell badge, deep-link routing, listing-edit cascade UX (*"cancel 12 apps?"* modal), empty states, error states, reduced-motion audit.

**Target velocity:** a solo dev with this stack can land steps 1–4 in week 1, 5–7 in week 2, 8–10 in week 3, 11–12 in week 4. Four-week MVP is realistic.

---

## 7. Reference Artifacts

- **`docs/design.md`** — full UI/UX language, screen catalog, wireframes, component inventory, motion spec.
- **`docs/tech-architecture.md`** — design decisions, state machines, Apify integration specs (actor catalog, input/output schemas, webhook wiring, cost management), Supabase schema + RLS + triggers + cron, edge-function spec sheet, eligibility engine, sequence diagrams, v1 scope cuts.
- **`docs/product-plan.md`** (this file) — synthesis + decisions + build sequence.

All three are living docs. Pivots that change a §4 decision (e.g. handle verification, revision-request, push notifications) must be reflected in all three files — not silently in one.

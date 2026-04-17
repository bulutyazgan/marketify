# Marketify — UI/UX Design Document

*Mobile app for the creator marketing industry. Expo + React Native + Reanimated + Supabase.*

---

## 1. Design Language

### 1.1 Chosen Style

**Neubrutalism** as the primary language, with disciplined restraint for mobile comfort.

**Why it fits Marketify:**
- The marketplace/directory pattern (Vibrant & Block-based) is the top match; Neubrutalism is its most purposeful expression — bold borders, hard offset shadows, flat pop colors.
- The pattern rewards scannability — hard black outlines on CampaignCards make bounties feel like physical "cards on a board."
- WCAG AAA by construction (high contrast), Excellent performance — critical for mid-tier Android.
- Differentiated. TikTok is dark-glassmorphic, Instagram is quiet gradient, every campaign-management tool (Grin, Aspire) is corporate-blue SaaS. Neubrutalism carves out a clear creator-native identity.

**Disciplines to keep it mobile-friendly (not a desktop stunt):**
- Borders are 2px, not 4px.
- Shadows are 3px offset max, never 6–8px.
- Corner radius is 12px on cards, 999px on pills — not 0. Pure 0 feels brittle on touch.
- No intentionally "broken" layouts. Brutalism's anti-design aesthetic is skipped in favor of its craft elements only.

### 1.2 Color Palette

Base palette anchored on the **"Creator Economy Platform"** colors (pink + orange CTA), with semantic statuses added.

| Role | Token | Hex | Usage |
|---|---|---|---|
| Primary | `--primary` | `#EC4899` | Brand, active tab icon, primary surfaces, logo mark |
| Primary Soft | `--primary-soft` | `#FDF2F8` | Primary-tinted backgrounds, selected chip bg |
| Primary Deep | `--primary-deep` | `#831843` | Primary text on soft bg, pressed states |
| Accent (CTA) | `--cta` | `#F97316` | All primary action buttons, "Apply", "Submit", "Create Campaign" |
| Accent Deep | `--cta-deep` | `#9A3412` | CTA pressed state |
| Ink (text) | `--ink` | `#0F172A` | All body and heading text, hard borders |
| Ink-70 | `--ink-70` | `#475569` | Secondary text, captions |
| Ink-40 | `--ink-40` | `#94A3B8` | Tertiary / disabled text |
| Surface | `--surface` | `#FFFFFF` | Card bodies |
| Canvas | `--canvas` | `#FFF9F2` | App background (warm off-white — matches orange CTA undertone) |
| Hairline | `--hairline` | `#E5E7EB` | Dividers inside cards |
| **Success (approved)** | `--success` | `#16A34A` | Approved submissions, approved applications, eligible checks |
| Success Soft | `--success-soft` | `#DCFCE7` | Approved pill bg |
| **Danger (rejected)** | `--danger` | `#DC2626` | Rejected submissions, rejected applications |
| Danger Soft | `--danger-soft` | `#FEE2E2` | Rejected pill bg, ineligibility warning |
| **Warning (pending)** | `--warning` | `#F59E0B` | Pending status, waiting-for-review states |
| Warning Soft | `--warning-soft` | `#FEF3C7` | Pending pill bg |
| **Cancelled** | `--cancelled` | `#6B7280` | Auto-cancelled applications |
| Cancelled Soft | `--cancelled-soft` | `#F3F4F6` | Cancelled pill bg |
| Shadow | `--shadow` | `#0F172A` | Neubrutalist hard shadow (always ink, never tinted) |

**Contrast targets (measured against `--canvas` `#FFF9F2`):**
- Body text (`--ink` `#0F172A`): **17.8:1** — passes WCAG AAA.
- Secondary text (`--ink-70` `#475569`): **7.9:1** — passes AAA.
- Primary brand pink (`--primary` `#EC4899`) on canvas: **~3.3:1** — passes WCAG AA for large text (18pt+ or 14pt bold) and UI components, but **does not clear AAA**. Primary pink is therefore **never used for body text** — only for brand marks, large display accents, active-tab icons (paired with a text label), and soft-tinted backgrounds. Where pink needs to carry meaning on light backgrounds at body size, we use `--primary-deep` `#831843` (contrast ~11:1, AAA).
- CTA orange (`--cta` `#F97316`) is a background color under black label text (17.8:1), so the button itself is AAA; the orange is never used as foreground text.

**Dark mode:** deferred for MVP. Neubrutalism translates cleanly (invert canvas → `#0B0B0F`, keep shadow as a white 1px border with a `rgba(0,0,0,0.4)` offset), but it doubles visual QA.

### 1.3 Font Pairing

**"Startup Bold"** — `Clash Display` for headings, `Satoshi` for body. Both via `expo-font` (Fontshare CDN or self-host). Fallbacks: `Outfit` for headings, `Rubik` for body.

| Role | Font | Weight | Size (mobile) |
|---|---|---|---|
| Display (screen titles, campaign titles) | Clash Display | 600–700 | 28 / 22 |
| Heading | Clash Display | 600 | 20 |
| Subhead | Satoshi | 600 | 17 |
| Body | Satoshi | 500 | 15 |
| Caption | Satoshi | 500 | 13 |
| Micro (pills, chip labels) | Satoshi | 700 | 11 (uppercase, `letter-spacing: 0.08em`) |
| Monospace (URLs, handles @xxx) | JetBrains Mono | 500 | 14 |

**Usage rules:**
- Display font is *only* for titles and hero metric numbers. Never stack two Clash Display elements in the same card.
- User-generated content (campaign descriptions) bumps to 16px.
- Line-height: 1.55 body, 1.15 display.
- Line-length: max 65 characters → content width caps at ~340px on a 390px screen.

**Dynamic Type / system font scale.** Honor iOS Dynamic Type and Android font scale up to **130%** on all text — all sizes above scale proportionally via `allowFontScaling={true}` (RN default). **Cap at 130%** to protect Neubrutalism's fixed line-heights (1.15 display) and the 340px content-width cap, both of which break visually past that threshold (letters start touching; cards overflow gutters). Above 130% we clamp the scale factor in a top-level `Text.defaultProps.maxFontSizeMultiplier = 1.3` setting — the OS-level preference is still reflected up to the cap, just not beyond it. For users who need more, the v2 accessibility settings screen will expose a "Full size-up (may break layout)" escape hatch. Pills, status chips, and tab-bar labels use `allowFontScaling={false}` because their containers are fixed — they're UI chrome, not content.

### 1.4 Motion Language (Reanimated)

**Spring presets** (define in `animations/springs.ts`):
```
soft:    { damping: 20, stiffness: 180, mass: 1 }   // cards, chips
snappy:  { damping: 18, stiffness: 260, mass: 1 }   // tab switch, pill transitions
bouncy:  { damping: 12, stiffness: 220, mass: 1 }   // status change celebration
```

**Timing presets:**
```
micro:  150ms  ease-out     // press feedback
short:  220ms  ease-out     // enter/exit
medium: 320ms  cubic-bezier(0.2, 0.8, 0.2, 1)  // screen transitions
```

**Motion rules:**
1. **Screen transitions** — stack push uses native `slide_from_right` (expo-router default). Modals use `modal` presentation with a spring slide-up (snappy).
2. **Press feedback** — every pressable scales to 0.97 on `pressIn` (spring.soft), returns on `pressOut`. Use `Pressable` + `useAnimatedStyle` with `useSharedValue`. Never use `TouchableOpacity`.
3. **Status change (pending → approved/rejected)** — StatusPill morphs color with a 320ms color interpolation + one-shot bouncy scale (1 → 1.12 → 1). Approved gets confetti-lite: 8 small squares in primary/cta/success burst upward from the pill, fade over 800ms. Rejected gets a gentle left-right shake (3 cycles, ±4px, 120ms each). Both respect `prefers-reduced-motion`. **Deep-link arrivals** (user tapped the push notification and the Submission Detail screen is the first screen they land on) — the celebration anchor is the StatusPill inside the just-mounted screen, triggered 220ms after mount (after the screen-slide settles) so the burst reads as a response to the arrival, not a hanging-over-from-last-screen artifact. If the screen mounts with `status` already `approved` (i.e. the user arrived via deep link, not via an in-app realtime update), we still fire the celebration exactly once, gated by a `celebration_seen_for_submission_id` entry in MMKV so revisits don't re-trigger.
4. **Pull-to-refresh on metrics** — custom refresh control. Vertical "pull" reveals a Clash Display counter that rolls up (`withTiming` + numerical interpolation). On success, new value "slams" into place with bouncy spring and `✓` fades in. Delta shows `+1.2K` in success green for 1.5s.
5. **Card interactions (CampaignCard)** — on press, the card drops its hard shadow (translate `3px,3px` → `0,0`) and moves `translateX/Y(2px,2px)` to simulate a physical press. Spring.soft.
6. **Eligibility check animation** — tap "Apply" → criteria animate in a staggered list (each row fades + slides 8px from left, 60ms stagger). Passing conditions show a green check drawing in (SVG stroke-dashoffset, 280ms). Failing conditions shake once and fade to muted.
7. **Tab bar** — active tab icon morphs from `strokeWidth=1.5` outline to `strokeWidth=2.5` + filled enclosed areas via a paired ship-in-repo SVG (crossfaded, 180ms). Active indicator is a 4px bar under the icon (spring.snappy).
8. **FlatList entries** — on first mount, cards stagger in 40ms apart (translateY 16 → 0, opacity 0 → 1). Skip for subsequent renders. **Skip on screen re-entry within the same session** — a `useFocusEffect`-tracked `hasMountedOnce` ref gates the stagger so re-entering Feed from a pushed detail screen (or switching tabs back) doesn't replay the animation. Pull-to-refresh does *not* re-stagger either; new rows fade in individually (`LinearTransition` via `react-native-reanimated`'s layout animation API, 180ms). Full app relaunches reset the ref — the stagger is a first-impression-per-session flourish, not a per-mount one.

**Performance:** all worklets, `runOnUI` for imperative runs. No `Animated` API. Gestures via `react-native-gesture-handler` + Reanimated v3.

**Reduced motion:** wrap spring helpers in `useReducedMotion()`. Replace springs with `withTiming(value, { duration: 0 })` or short 120ms fade. Confetti and shake become no-ops; color transitions remain.

### 1.5 Component Personality

| Attribute | Decision |
|---|---|
| Corners | Cards 12px, buttons 10px, pills 999px, inputs 10px, images 8px. |
| Borders | 2px solid `--ink` on every card, button, input, chip. |
| Shadow | `offset (3, 3), color: --ink, opacity: 1, radius: 0` — signature hard shadow. Pressed collapses to (0,0). |
| Elevation | Two tiers: "flat" (no shadow) and "lifted" (hard shadow). No z-stacking beyond modal overlay. |
| Iconography | **Lucide React Native** exclusively. 24×24 viewBox, 2px stroke. Tab bar uses **stroke-weight toggle**, not filled variants — Lucide doesn't ship filled glyphs for every icon we need (`video`, `megaphone`, `inbox`). Inactive tab: `strokeWidth={1.5}`; active tab: `strokeWidth={2.5}` + fills the glyph's enclosed areas (e.g. compass needle) via a paired `fill` SVG we ship ourselves for the 4 creator + 4 lister tab icons. No emoji. |
| Imagery | Campaign sample videos get 2px ink border + hard shadow. Thumbnail aspect 9:16 for TikTok/Reels, 1:1 for avatars. |
| Empty-state illustrations | Geometric line drawings using primary/cta/ink only. No stock illustration libraries. |
| Haptics | `expo-haptics` — Light on press, Medium on status change, Success/Error on approve/reject arrivals. |

---

## 2. Information Architecture

Legend: **[C]** creator only, **[L]** lister only, **[S]** shared.

### 2.1 Auth / Setup

| Screen | Route | Role | Purpose | Primary CTA |
|---|---|---|---|---|
| Welcome | `/welcome` | S | First-launch brand intro | "I'm a Creator" / "I'm a Company" |
| Role Select | `/onboarding/role` | S | Commit to role | "Continue" |
| Enter Handles (Creator) | `/onboarding/creator-handles` | C | Username + TikTok handle and/or Instagram handle (at least one) | "Continue" |
| Fetching Metrics | `/onboarding/metrics` | C | Skeleton while Apify scrapes the profile(s); resolves in ~15–60s or slides into the next screen with a "still working in the background" chip | (auto) |
| Company Profile | `/onboarding/company-profile` | L | Capture username, email, org name, logo | "Finish" |

*(Note: creator onboarding is handle-based — no OAuth, no platform consent screens. Our Apify scrapers pull public profile data from the handle alone. Handles are unverified in v1; there is no "claim your account" flow. The app simply trusts the creator to enter their own handle.)*

### 2.2 Creator Screens

| Screen | Route | Purpose | Primary CTA |
|---|---|---|---|
| Campaign Feed | `/(creator)/feed` | Browse active campaigns with eligibility toggle | Tap card |
| Filters Sheet | `/(creator)/feed/filters` | Refine feed (price, platform, eligible-only) | "Apply" |
| Campaign Detail | `/(creator)/campaign/[id]` | Full campaign info + live eligibility | "Apply" (or disabled "Not eligible") |
| Apply Confirm | `/(creator)/campaign/[id]/apply` | Confirm application | "Send application" |
| My Applications | `/(creator)/applications` | Track applications | Tap row |
| Application Detail | `/(creator)/applications/[id]` | Specific application status | "Submit video" (if approved) |
| Submission Composer | `/(creator)/applications/[id]/submit` | Paste video URL | "Send for review" |
| My Submissions | `/(creator)/submissions` | Track submissions | Tap row |
| Submission Detail | `/(creator)/submissions/[id]` | Status, feedback, video | "Open video" |
| Profile | `/(creator)/profile` | Own profile, handles, metrics | "Refresh metrics" |
| Edit Handles | `/(creator)/profile/handles` | Add / update / remove a TikTok or Instagram handle. Removing a handle stops future scrapes but preserves snapshot history. | "Save" |
| Notifications | `/(creator)/notifications` | Activity inbox | Tap item |

### 2.3 Lister Screens

| Screen | Route | Purpose | Primary CTA |
|---|---|---|---|
| Dashboard | `/(lister)/dashboard` | Stat tiles + recent activity | "Create campaign" (FAB) |
| Create Campaign — Steps 1–5 | `/(lister)/campaigns/new/*` | Wizard: basics → price → pre → post → samples → review | "Next" / "Publish" |
| My Campaigns | `/(lister)/campaigns` | List active + inactive | Tap card |
| Campaign Detail (lister) | `/(lister)/campaigns/[id]` | Manage: toggle active, edit, counts | "Edit" / Toggle |
| Edit Campaign | `/(lister)/campaigns/[id]/edit` | Modify fields (triggers cancel-warning) | "Save changes" |
| Applications Inbox | `/(lister)/campaigns/[id]/applications` | Review applicants with metrics | Tap row |
| Application Review | `/(lister)/campaigns/[id]/applications/[appId]` | Approve/Reject | "Approve" / "Reject" |
| Submissions Inbox | `/(lister)/campaigns/[id]/submissions` | Review final videos | Tap row |
| Submission Review | `/(lister)/campaigns/[id]/submissions/[subId]` | Video + checklist + decide | "Approve" / "Reject" |
| Profile | `/(lister)/profile` | Company profile | "Edit" |
| Notifications | `/(lister)/notifications` | Activity inbox | Tap item |

### 2.4 Shared / System

| Screen | Route | Role | Purpose |
|---|---|---|---|
| Status Detail (auto-cancel) | `/shared/status/cancelled/[id]` | C | Explains what changed when a listing got edited |
| Error | `/shared/error` | S | Generic recoverable error screen |
| Not Found | `/shared/404` | S | Dead-link fallback |

### 2.5 Empty & Error States (inline)

- Feed empty (no campaigns): "Nothing live right now." + "Notify me" toggle.
- Feed empty (no eligible): see §5.5.
- Applications empty: "Apply to your first campaign." → feed.
- Submissions empty: "No submissions yet. Get approved on an application to start filming."
- Lister dashboard empty: "Post your first bounty."
- Applications inbox empty (lister): "Waiting for creators to apply."
- Network error: hard-shadow card with "Can't reach servers" + "Try again".

**Age-bucketed nudges for non-expiring inboxes.** Applications and submissions do not auto-expire, so an inbox is never "full" in the OS sense — but stale rows rot quietly. On inboxes where any open row is older than a threshold, the list prepends a soft-warning banner (not an empty state — the list is non-empty):

| Inbox | Trigger | Banner copy |
|---|---|---|
| Lister Applications Inbox | any pending application `created_at > 7 days` | *"N applications pending > 7 days. Review or close the listing."* |
| Lister Submissions Inbox | any pending submission `created_at > 5 days` | *"N submissions waiting > 5 days. Creators are watching the clock."* |
| Creator Applications | any pending application `created_at > 14 days` and no activity | *"N applications no one's touched in 2 weeks. Find a similar bounty?"* → routes to Feed |

Banner is dismissible per-session but returns on next cold start until the condition clears.

---

## 3. Navigation Structure

### 3.1 Tab Bar — Creator (4 tabs)

| Tab | Icon | Label | Stack root |
|---|---|---|---|
| Feed | compass | Discover | `/(creator)/feed` |
| Applications | send | Applied | `/(creator)/applications` |
| Submissions | video | Submitted | `/(creator)/submissions` |
| Profile | user | Profile | `/(creator)/profile` |

Notifications are a bell button in every tab's header (lower traffic, avoids 5-tab trap).

### 3.2 Tab Bar — Lister (4 tabs)

| Tab | Icon | Label | Stack root |
|---|---|---|---|
| Dashboard | layout-dashboard | Home | `/(lister)/dashboard` |
| Campaigns | megaphone | Campaigns | `/(lister)/campaigns` |
| Inbox | inbox | Inbox | `/(lister)/inbox` (apps + submissions, segmented) |
| Profile | building-2 | Profile | `/(lister)/profile` |

Create-campaign is a **FAB** (cta color, hard shadow, 56px) on Dashboard + Campaigns tabs — not a center-tab bump.

**Inbox model — relationship to §2.3 IA.** §2.3 lists Applications Inbox and Submissions Inbox as *campaign-scoped* routes (`/(lister)/campaigns/[id]/applications` and `/(lister)/campaigns/[id]/submissions`) because review always happens in-context for a specific campaign. The **Inbox tab** (`/(lister)/inbox`) is a cross-campaign roll-up — same underlying data, different entry point:

- **Segmented header:** `Applications · Submissions` (segmented control, not two tabs — keeps the 4-tab bar).
- **Default segment:** whichever has the higher unreviewed count; ties go to Submissions (higher creator-anxiety cost per day of delay).
- **Row grouping:** grouped by campaign with `SectionHeader` rows; tapping a row pushes into the campaign-scoped review screen (same route as §2.3).
- **Empty state:** if both segments empty, "Nothing to review. Good time to post another bounty." with a CTA button to Create Campaign.

So the campaign-scoped routes are the sources of truth; the Inbox tab is a lens. This matches how lister work actually happens — sometimes you think "that Nike campaign has applicants" (campaign-first), sometimes "do I have anything to review?" (inbox-first).

### 3.3 Modal vs Stack vs Tab

| Case | Pattern | Why |
|---|---|---|
| Filters (creator feed) | Bottom sheet (80% height) | Scannable, preserves feed scroll. |
| Apply Confirm | Full-screen modal slide-up | Commitment moment — needs focus. |
| Create Campaign wizard | Stack with progress header | 5 steps need back-navigation. |
| Edit Campaign | Full-screen modal | Single-page edit. |
| Application Review (lister) | Stack push | Back-swipe preserved. |
| Submission Review (lister) | Stack push with video | Back-swipe preserved. |
| Submission Composer | Stack push | Mid-flow from application detail. |
| Confirmations | Alert-style modal | Short, high-stakes. |
| Notifications | Stack push from bell | Allows deep-link. |

### 3.4 Deep Link Strategy

Scheme: `marketify://`

| Event | Deep link | Lands on | Back-stack seed |
|---|---|---|---|
| Creator app approved | `marketify://applications/:id` | Application Detail with animated status change | Applied tab → Application Detail |
| Creator app rejected | `marketify://applications/:id` | Application Detail, rejection reason expanded | Applied tab → Application Detail |
| Creator app cancelled (listing edited) | `marketify://applications/:id?reason=listing_edited` | Application Detail with "What changed" diff card | Applied tab → Application Detail |
| Submission approved/rejected | `marketify://submissions/:id` | Submission Detail with status change | Submitted tab → Submission Detail |
| Lister new application | `marketify://campaigns/:cid/applications/:aid` | Application Review | Home tab → Campaign Detail (`:cid`) → Applications Inbox → Application Review |
| Lister new submission | `marketify://campaigns/:cid/submissions/:sid` | Submission Review | Home tab → Campaign Detail (`:cid`) → Submissions Inbox → Submission Review |
| Metric refresh ready | `marketify://profile` | Profile with refresh banner | Profile tab (own root) |

Built with `expo-router`. **Back-stack seeding rule:** deep links hydrate a realistic navigation spine, not just the target screen on top of the home tab. The table above spells out each link's spine — back-swipe from an Application Review lands the lister on the Applications Inbox they would have reached manually, not on Dashboard. One-level-deep links (creator Application Detail, Profile) seed a single parent tab and stop there.

---

## 4. Key Screen Wireframes (text-described)

All measurements assume a 390×844 iPhone baseline. 16px horizontal gutter. 12px vertical rhythm. Safe-area respected.

### 4.0 Onboarding — Fetching Metrics (Creator)

```
┌───────────────────────────────────────────┐
│                                           │
│                  ▓▓▓▓▓                    │ animated geometric
│                 ▓     ▓                   │ line illustration
│                 ▓     ▓                   │ (primary + ink)
│                  ▓▓▓▓▓                    │
│                                           │
│         Fetching your stats               │ Clash Display 22
│                                           │
│   We're pulling your public profile(s).   │ Satoshi 15
│   Usually takes 15–60 seconds.            │
│                                           │
│   ┌─────────────────────────────────────┐ │
│   │ ● TikTok       @sarahfilms   ✓ 18s │ │ per-run status row
│   │ ● Instagram    @sarahfilms   …     │ │ (ig_details)
│   │ ● Instagram — videos         …     │ │ (ig_posts)
│   └─────────────────────────────────────┘ │
│                                           │
│   [ Keep me here ]  [ Continue in bg → ]  │ Secondary / Primary
│                                           │
└───────────────────────────────────────────┘
```

**Core behavior.** After the creator submits handles on `/onboarding/creator-handles`, the edge function dispatches up to three Apify runs in parallel (1 for TikTok, 2 for Instagram) and routes the creator to this screen. Each run gets a status row. The screen subscribes via realtime to `metric_snapshots` for this user.

**Per-run row states** (reuses `MetricStaleIndicator`):

| State | Row visual |
|---|---|
| `dispatching` | `●` (ink), handle, trailing "queued…" |
| `refreshing` | `●` (warning), handle, trailing animated pulsing `…` |
| `fresh` | `●` (success), handle, trailing "✓ 18s" (elapsed time) |
| `failed` | `●` (danger), handle, trailing "✗ Couldn't fetch" + inline "Retry" link (respects 6h throttle) |

**Completion rules** (screen auto-advances based on these):
- **All three fresh** → 220ms soft fade → push `/(creator)/feed`. Success toast: "You're in. N campaigns match you."
- **All fresh except one photo-only IG `ig_posts` returned 0 videos** (not a scrape error — a real "this creator has no videos" signal, distinguishable in the webhook's `raw_payload`) → same as above; the creator enters the feed with `instagram_avg_views_last_10 = null` and only sees campaigns that don't require that metric. Success toast: "You're in. Video-views stats were skipped — you have no IG videos."
- **At least one `failed`** → do NOT auto-advance. The "Continue in bg" CTA upgrades to "Skip for now — you can add this later" and routes to the feed anyway; the failed handle's profile page later shows a retry card (§5.4). Success criterion is "at least one scrape landed" — if *all three* fail, the screen flips to a full-error state (below).
- **"Continue in background"** at any time → immediate route to the feed; outstanding runs complete in the background and update Profile metrics silently. A small `MetricStaleIndicator state='refreshing'` chip appears in the Profile tab's icon dot until all runs land.

**"Keep me here"** anchors the screen; useful for impatient first-timers who want to watch the rows flip. No timeout — if the user stays, they stay.

**Full-error state** (all three scrapes failed):
```
┌───────────────────────────────────────────┐
│                                           │
│              ⚠ (danger-soft)              │
│                                           │
│      Couldn't fetch any of your profiles  │
│                                           │
│   This usually means one of:              │
│   • The handle has a typo                 │
│   • The profile is private                │
│   • Our scraper is temporarily down       │
│                                           │
│   [ Edit handles ]    [ Skip for now ]    │
│                                           │
└───────────────────────────────────────────┘
```
"Edit handles" returns to `/onboarding/creator-handles` with the values pre-filled. "Skip for now" routes to the feed; the profile shows a persistent "Add or fix a handle to see campaigns" card (they can browse but Apply is gated on at least one `fresh` platform metric set).

**Timeouts + edge cases.**
- If any run is still `refreshing` after 90s, the row's trailing copy changes from animated `…` to "still working…" (same state, different reassurance). The screen does *not* surface the 10-min stuck-timeout (§3 `fail-stuck-refreshing` cron) — from the creator's POV the run either completes or they hit "Continue in bg" first.
- If the app is backgrounded during this screen, realtime subscriptions reconnect on foreground and the rows render the current persisted state — no stuck "refreshing" if a webhook actually landed while backgrounded.

### 4.1 Campaign Feed (Creator)

```
┌───────────────────────────────────────────┐
│ 16pt margin                               │
│ ┌─────────────────────────────┐           │
│ │ Discover                  🔔│ ← 28pt Clash Display, bell right-aligned
│ └─────────────────────────────┘           │
│                                           │
│ ┌───────────── Search ───────────────┐    │ 44pt height, 2px border
│ │ 🔍  Search campaigns               │    │
│ └────────────────────────────────────┘    │
│                                           │
│ [✓ Eligible only] [Platform▼] [Price▼] [+]│ ← Horizontal chip row
│                                           │
│ ───────── 12 campaigns ──────────────     │
│                                           │
│ ┌─────────── CampaignCard ──────────┐     │
│ │ ┌──────┐  Clean Beauty Review     │     │
│ │ │ logo │  @cleanco                │     │
│ │ └──────┘                          │     │
│ │ Film a 30s skincare routine…      │     │
│ │ [TikTok] [Instagram]              │     │
│ │ $250  •  ✓ Eligible               │     │
│ └───────────────────────────────────┘     │
│ ... FlatList, pull-to-refresh from top    │
└───────────────────────────────────────────┘
[■][□][□][□]  ← Tab bar, 64pt + safe area
```

**States:** Loading (3 skeleton cards), Empty (illustration + notify-me), Empty-eligible (see §5.5), Error (hard-shadow retry card), Ineligible cards (desaturated, "Not eligible" badge).

### 4.2 Campaign Detail (Creator)

```
┌───────────────────────────────────────────┐
│ ←                                    ⇡    │
│ ┌──────┐                                  │
│ │ logo │  @cleanco                        │
│ └──────┘                                  │
│ Clean Beauty Review                       │
│ $250                                      │
│ Payout after approval                     │
│                                           │
│ ══════ Sample videos ══════                │
│ [thumb][thumb][thumb]  →                  │
│                                           │
│ ══════ Eligibility ══════                  │
│ ┌── EligibilityRow ──────────────────┐    │
│ │ ✓  10K+ TikTok followers (you: 12.3K)│  │
│ │ ✓  5K+ avg views (you: 8.1K)       │    │
│ │ ✗  Instagram handle required       │    │
│ │    Add your IG handle             →│    │ (opens AddHandleSheet → kicks Apify)
│ └────────────────────────────────────┘    │
│                                           │
│ ══════ What to film ══════                 │
│ • 30s vertical video                      │
│ • Mention "cruelty-free"                  │
│ • Family-friendly                         │
│ • Link in bio to cleanco.com              │
│                                           │
│ ══════ Brief ══════                       │
│ [rich text description]                   │
└───────────────────────────────────────────┘
┌───────────────────────────────────────────┐
│  [     APPLY TO COLLAB      ]             │ ← Sticky footer, cta color
└───────────────────────────────────────────┘
```

**States:** Eligible (full CTA), Ineligible (disabled, first failing row auto-scrolled + pulsed), Already-applied (status chip), Already-approved (CTA becomes "Submit your video"), Now-inactive (banner + CTA hidden).

**Inline `AddHandleSheet` flow (spec).** Tapping "Add your IG handle" (or "Add your TikTok handle") on any failing EligibilityRow opens a bottom sheet without leaving Campaign Detail. This keeps the creator's intent intact — they came here to apply to *this* campaign, not to manage their profile.

```
┌───────────────────────────────────────────┐
│  Add your Instagram handle                │
│                                           │
│  @ ┌───────────────────────────────────┐  │ JetBrains Mono input
│    │ sarahfilms                         │  │ (same style as §4.7)
│    └───────────────────────────────────┘  │
│                                           │
│  We'll fetch your public profile stats.   │
│  Takes 15–60 seconds.                     │
│                                           │
│  [ Cancel ]            [ Add handle ]     │
└───────────────────────────────────────────┘
```

**Sheet states** (internal state machine, not separate screens):

| State | Visual | Transition |
|---|---|---|
| `input` | normal sheet, "Add handle" button enabled once @handle validates client-side | `POST /social-links` returns 201 → `dispatching` |
| `dispatching` | "Add handle" becomes a `ButtonPrimary loading` with an inline spinner; input is read-only | edge function enqueues Apify runs → `scraping` (usually <300ms) |
| `scraping` | sheet collapses to a pinned bottom progress banner (`MetricStaleIndicator state='refreshing'`, copy: "Fetching @sarahfilms …") and Campaign Detail becomes interactive again; eligibility rows that depend on IG enter a `refreshing` visual | one or both IG webhooks land (`ig_details` / `ig_posts`) |
| `partial` (IG only) | banner shows "@sarahfilms · followers ✓, views loading…"; eligibility rows that depend on `instagram_follower_count` can re-evaluate and pass / fail optimistically, while `instagram_avg_views_last_10`-dependent rows stay in `refreshing` | second webhook lands → `fresh` or `failed` |
| `fresh` | banner flips to a 2.5s success toast ("@sarahfilms added — you're now eligible" / "…still missing conditions"); eligibility rows re-render with final pass/fail | banner auto-dismisses; CTA re-evaluates; if now eligible the Apply CTA pulses once (`bouncy` spring) |
| `failed` | banner flips to `failed` MetricStaleIndicator variant with retry CTA: "Couldn't fetch @sarahfilms · Edit handle" | tap → re-opens AddHandleSheet in `input` state with handle pre-filled (doesn't unlink) |
| `scrape_error + handle_invalid` (distinct subkind — resolved from webhook's `error_message`) | banner copy: "@sarahfilms doesn't look like a real Instagram account. Double-check the spelling." | same as `failed` |

**Interaction with §5.6 "Is this you?" card.** If the creator adds a handle here and immediately navigates to Profile (e.g., from the "Edit Handles" secondary action later in the session), the first-scrape confirmation card renders on Profile *once the first `fresh` snapshot exists*. The two flows are independent — AddHandleSheet is about adding the handle for eligibility in context; the confirmation card is a profile-level sanity check. A creator who never visits Profile still sees the card the first time they do.

**What the eligibility rows show during `scraping` / `partial`.**
- Rows bound to the being-scraped platform render `MetricStaleIndicator state='refreshing'` over their user_value (e.g., "12.3K" becomes a skeleton).
- The Apply CTA is disabled with copy: "Waiting for @sarahfilms…" — not "Not eligible" (honesty: eligibility is currently unknown, not failed).
- If the creator backgrounds the app and returns, the banner + refreshing state persist (driven by realtime subscription to `metric_snapshots` for the creator's own social_links).
- If the creator applies to a *different* campaign in the meantime, the banner follows them on that Campaign Detail too — it's a global pinned-bottom banner, not screen-local, until all outstanding runs resolve.

**Backend contract.** The sheet calls `POST /social-links { platform, handle }` which (a) inserts `social_links` with `status='linked'`, (b) enqueues the scrape_modes for that platform via Apify client, (c) returns `{ social_link_id, queued_scrape_modes: [...] }` synchronously. The sheet then subscribes to realtime on `metric_snapshots` filtered to `social_link_id` and drives its state machine from webhook arrivals. The sheet is the only UI that interleaves a Campaign Detail eligibility check with an active scrape; the state model above is its spec.

### 4.3 Application Flow (Creator)

Detail → full-screen modal slide-up:

```
┌───────────────────────────────────────────┐
│ ✕                              Cancel     │
│ You're applying to                        │
│ Clean Beauty Review                       │
│                                           │
│ ══════ We double-checked ══════           │
│ ┌────────────────────────────────────┐    │ Staggered reveal
│ │ ✓ 10K+ TikTok followers            │    │
│ │ ✓ 5K+ avg views                    │    │
│ │ ✓ Instagram handle on file         │    │
│ │ ✓ Family-friendly profile          │    │
│ └────────────────────────────────────┘    │
│                                           │
│ ══════ Pitch (optional) ══════            │
│ ┌────────────────────────────────────┐    │
│ │ Why are you a fit?         0/160   │    │
│ └────────────────────────────────────┘    │
│                                           │
│ By applying you confirm you'll follow     │
│ the campaign rules.                       │
│                                           │
│ [      SEND APPLICATION       ]           │
└───────────────────────────────────────────┘
```

### 4.4 Submission Composer (Creator)

```
┌───────────────────────────────────────────┐
│ ← Submit your video                       │
│ For: Clean Beauty Review                  │
│                                           │
│ ══════ Platform ══════                    │
│ [ TikTok ] [ Instagram ]                  │ ← Segmented control
│                                           │
│ ══════ Paste your video URL ══════        │
│ ┌────────────────────────────────────┐    │
│ │ https://tiktok.com/@me/video/…     │    │
│ └────────────────────────────────────┘    │
│ ⓘ We'll validate the link.                │
│                                           │
│ ══════ Preview ══════                     │
│ ┌────────────────────┐                    │
│ │   [thumbnail]      │                    │
│ └────────────────────┘                    │
│                                           │
│ ══════ Rules checklist (self-affirm) ═══  │
│ ┌────────────────────────────────────┐    │
│ │ ☐ 30s vertical video               │    │
│ │ ☐ Mentions "cruelty-free"          │    │
│ │ ☐ Family-friendly                  │    │
│ │ ☐ Link in bio to cleanco.com       │    │
│ └────────────────────────────────────┘    │
│                                           │
│ [    SEND FOR REVIEW    ]                 │
└───────────────────────────────────────────┘
```

**States:** Empty URL (dashed placeholder), Invalid (danger border + helper), Fetching (shimmer), Preview failed (non-blocking), Submitting (spinner), Success (full-screen card, auto-dismiss).

### 4.5 Create Campaign Wizard (Lister)

```
┌───────────────────────────────────────────┐
│ ← Step 3 of 5                             │
│ ●●●○○                                     │
│ Who can apply?                            │
│ Set eligibility rules for creators.       │
│                                           │
│ ══════ TikTok ══════                      │
│ Min followers                             │
│ ┌──────────────┐                          │
│ │ 10,000       │                          │
│ └──────────────┘                          │
│ Min avg views                             │
│ ┌──────────────┐                          │
│ │ 5,000        │                          │
│ └──────────────┘                          │
│                                           │
│ ══════ Instagram ══════                   │
│ Min followers  ...                        │
│                                           │
│ [+ Required]  ← both platforms?           │
└───────────────────────────────────────────┘
┌───────────────────────────────────────────┐
│                           [ NEXT → ]      │
└───────────────────────────────────────────┘
```

Step-by-step: Basics → Price → Pre-conditions → Post-conditions → Samples → Review.

### 4.6 Submission Review (Lister)

```
┌───────────────────────────────────────────┐
│ ← Review submission                       │
│ From: @sarahfilms                         │
│ For: Clean Beauty Review                  │
│ ┌────────────────────────────────┐        │ ReuseBadge — header variant
│ │ ↻ Also submitted to 2 others   │        │ tap → sheet listing the other campaigns
│ └────────────────────────────────┘        │ (warning-soft bg, not blocking)
│                                           │
│ ══════ Video ══════                       │
│ ┌──────────────────────┐                  │
│ │   [video preview]  ▶ │                  │
│ └──────────────────────┘                  │
│ tiktok.com/@sarahfilms/video/123          │
│                                           │
│ ══════ Check the rules ══════             │
│ ┌────────────────────────────────────┐    │ 3-state checkboxes
│ │ ☐ 30s vertical video               │    │
│ │ ✓ Mentions "cruelty-free"          │    │
│ │ ☐ Family-friendly                  │    │
│ │ ✗ Link in bio to cleanco.com       │    │ ← failed row stays red
│ └────────────────────────────────────┘    │
│                                           │
│ ══════ Feedback (optional) ══════         │
│ ┌────────────────────────────────────┐    │
│ │ Message to creator…        0/240   │    │
│ └────────────────────────────────────┘    │
└───────────────────────────────────────────┘
┌───────────────────────────────────────────┐
│ [   REJECT   ] [    APPROVE ✓    ]        │
└───────────────────────────────────────────┘

If APPROVE tapped with any ✗ rows → OverrideEligibilityDialog:

┌────────────────────────────────────────┐
│  Approve anyway?                       │
│                                        │
│  1 rule wasn't met:                    │
│  • Link in bio to cleanco.com          │
│                                        │
│  Approving overrides this. The creator │
│  will be paid in full.                 │
│                                        │
│  Type OVERRIDE to confirm:             │
│  ┌──────────────────────────────────┐  │
│  │                                  │  │
│  └──────────────────────────────────┘  │
│                                        │
│  [ Cancel ]   [ Approve with override ]│
└────────────────────────────────────────┘
```

Notes on the two Q-driven affordances:
- **ReuseBadge** reads from the `submission_reuse_view` server aggregate; tap opens a bottom sheet showing the other campaigns with their status so the lister can decide whether reuse is a problem for *their* brief (some briefs permit cross-posting, others require exclusivity).
- **OverrideEligibilityDialog** only appears when approving with failed post-conditions. Typed confirmation (not just a button) is intentional friction — overrides are auditable (`submissions.override_reason`, `submissions.override_by_user_id`) and we want the lister to pause. Reject-with-failed-conditions needs no dialog (expected path).

**Self-affirm vs review checkbox mapping.** The Submission Composer (creator, §4.4) and Submission Review (lister, §4.6) render the same `ConditionChecklist` with different `mode` props:
- `mode='self'` (composer) → two-state: `☐` unchecked / `☑` checked. Every row starts unchecked; the creator affirms each one. No `✗` red state — a creator who can't honestly affirm a row just leaves it unchecked, and the client-side validator blocks submit until all rows are checked.
- `mode='review'` (lister) → three-state: `☐` unreviewed / `✓` passes / `✗` fails. Rows land in unreviewed; the lister taps to cycle through the three states. `✗` rows persist their red visual until decision, and light up the OverrideEligibilityDialog trigger on Approve.

---

## 5. Critical UX Moments

### 5.1 Eligibility Failure (Soft Rejection)

**Tone:** Never "you're not good enough." Always "here's what's missing, here's how to fix it."

- **Copy:** "You're not eligible yet for this one."
- **Visual:** danger-soft background (warm, not aggressive red); danger icon (subtle circle-slash, not harsh X).
- **Always pair with action:** inline CTA per failing row ("Link Instagram", "Refresh metrics").
- **Motion:** failing rows fade in *after* passing rows (200ms delay), gentle single-pulse danger-soft background. No shaking.
- **Escape hatch:** "Notify me when I qualify" toggle at the bottom.

### 5.2 Application Auto-Cancellation (Lister Edited Listing)

This is a trust-critical moment.

- **Notification copy:** "@cleanco updated Clean Beauty Review. Your application was cancelled — you can re-apply with the new terms."
- **Deep link:** Application Detail with a distinctive **"What changed" diff card** at top (cancelled-soft bg, cancelled-color 2px border, no shadow).
- **Diff card:** side-by-side old vs new for changed fields (price, pre/post-conditions). Changed values in primary-soft pills.
- **Primary CTA:** "Re-apply" (cta color) — takes creator to new campaign detail pre-scrolled to eligibility.
- **Secondary:** "Dismiss".
- **Motion:** status pill transitions pending/approved → cancelled with 600ms color wash (no bounce — neutral).
- **Lister side:** "This will cancel **N** pending applications. They'll be notified." Requires explicit confirmation button.
- **Lister-side warning on subsequent edits:** after the first version bump, every subsequent edit confirmation also surfaces: *"Creators cancelled by a previous edit are **not** re-notified. Only currently active applications (N) will be told about this change."* This is a one-way fan-out — by design, to prevent spamming ex-applicants — but listers have expected "edit again = re-ping everyone" and been surprised. Copy is inline in the ConfirmationModal body, not a separate dialog, so it reads as context, not another obstacle.

### 5.3 Submission Status Change (pending → approved/rejected)

The most emotional moment.

**Approved:**
- Deep-link to Submission Detail.
- StatusPill: 200ms warning → 320ms color-interpolated success + bouncy scale (1 → 1.12 → 1).
- Confetti-lite: 8 small 6×6 squares burst upward, fade over 800ms.
- Haptic: `Success`.
- Banner: "Approved — nice work!" cta-colored, auto-dismiss 2.5s.
- All respects `useReducedMotion`.

**Rejected:**
- Same deep-link.
- StatusPill: 400ms warning → danger wash + **one shake gesture made of 3 oscillation cycles** (±4px each, 120ms per half-cycle, ~720ms total). No confetti.
- Haptic: `Warning` (not Error — not punitive).
- Lister feedback card always visible (danger-soft bg).
- **Primary CTA: "Find a similar bounty"** — routes to Feed pre-filtered by the rejected campaign's `listings.category` + a price band of ±30% around its `listings.price_cents`. Both columns exist in the schema (see `tech-architecture.md` §7); the feed uses the `listings_category_price_idx` partial index for sub-ms response. The rejected path must offer forward motion, not just a closed door.
- **Secondary CTA: "Read campaign rules"** — re-orients toward learning for anyone who wants to understand the rejection.
- Copy under the feedback card: *"This one didn't land. Plenty more that fit your profile."* Blameless, forward-looking.
- Silent landing — no banner, no confetti anti-pattern.

### 5.4 Metrics Refresh

**State model is per-metric, not per-platform.** A single Instagram refresh is two independent Apify runs (follower count + avg views). They can land out-of-order, and one can fail while the other succeeds. TikTok is a single run and collapses to the simple case.

**Per-metric states** (rendered by `MetricStaleIndicator`):

| State | Visual | When |
|---|---|---|
| `fresh` | no chip; timestamp reads "Updated 2m ago" | last snapshot for this `scrape_mode` is `fresh` and `< 24h` old |
| `stale` | tiny warning-soft dot; timestamp reads "Updated 3d ago" | `fresh` but `> 24h` (auto-flipped by cron) |
| `refreshing` | faint pulsing skeleton over the metric value | a webhook is outstanding |
| `failed` | danger-soft chip: "Couldn't refresh · Retry" | last snapshot is `failed`; tapping retries (respects 6h throttle) |

**Pull-to-refresh gesture** on Profile:
- **Pull phase:** counter above metric tiles interpolates upward; "Release to refresh".
- **Release phase:** all per-metric tiles owned by the platform(s) being refreshed enter `refreshing` simultaneously. Per-platform odometer only starts when that mode's webhook lands.
- **Partial-success phase (IG):** if `ig_details` lands first, follower count runs the odometer + delta pill; `ig_avg_views_last_10` stays in `refreshing` with its skeleton until `ig_posts` lands. If `ig_posts` fails (e.g. photo-only profile), the views tile flips to `failed` with "Not enough video content" as the specific copy (we distinguish "no videos" from "scrape error" by checking `raw_payload`).
- **Full-success phase:** each mode's tile runs its own odometer with bouncy spring and fades its delta pill (`+1.2K`/`-300`) for 1.5s.
- **Error phase:** if a manual refresh hits the 6h throttle (`429 RATE_LIMIT`), toast surfaces the exact `retry_after_sec` using a **tiered format**:
  - `≥ 1h`: `"Try again in Xh Ym."` (e.g. "Try again in 4h 23m.")
  - `60s ≤ t < 1h`: `"Try again in Xm."` (e.g. "Try again in 7m.")
  - `< 60s`: `"Try again in a few seconds."` (we round down aggressively here — nobody benefits from "try again in 11s")
  Never "in a minute" unless `retry_after_sec` literally falls between 60 and 119.
- **Last-refreshed timestamp** is per-platform, not per-metric, and reads the **older** of the two IG snapshots: "IG updated 14m ago" (not "5m ago" — honesty over recency).

### 5.5 Empty State — No Eligible Campaigns

- **Illustration:** geometric line art (primary + ink only).
- **Headline:** "Nothing matches you — yet."
- **Body:** "Campaigns get added daily. Meanwhile, here's what to try."
- **Two action cards:**
  - **"Refresh your metrics"** → Profile, auto-triggers refresh.
  - **"See all campaigns"** → flips eligibility toggle off, reloads feed.
- **Never** just "no results".

### 5.6 First-Scrape Handle Confirmation ("Is this you?")

Handles are self-declared — no OAuth, no ownership verification. That's fine for v1, but we want one *soft* confirmation step the first time a handle resolves to a real profile, so the creator catches their own typos (`@sarah.films` vs `@sarahfilms`) before we lean on the metrics for eligibility.

- **When:** on the Profile screen, the first time *any* scrape for a newly-added handle lands with `status='fresh'` (not on re-scrapes, not on re-linked handles). Gated by `handle_confirmed_at` on `social_links`.
- **What renders:** an inline confirmation card at the top of Profile, *above* the metric tiles, with the scraped display name + avatar + the bio-first-line, and two buttons:
  - **"Yes, that's me"** → sets `handle_confirmed_at = now()`, card fades out (220ms short).
  - **"Wrong profile"** → opens Edit Handles with the handle pre-selected in the edit row. Doesn't un-link automatically — the creator re-types.
- **Tone:** neutral, not alarmed. Copy: *"Quick check — is this your account? We'll use these stats for campaign eligibility."*
- **Visual:** primary-soft background card, 2px ink border, hard shadow. Avatar is 1:1 with 2px border.
- **No blocking:** metric tiles render normally below the card. The creator can ignore it — the card just doesn't go away until they answer. Applications still work; the card is a nudge, not a gate.
- **Unconfirmed-handle footgun:** if a creator ignores this and we later detect their handle resolves to a suspiciously-different profile (e.g., metrics drop 90%+ between refreshes, bio changes language), we re-surface the card with danger-soft styling and slightly firmer copy — but this is a v2 concern; MVP just shows the card once per handle.

---

## 6. Component Library Inventory

| Component | Purpose | Key props |
|---|---|---|
| **CampaignCard** | Feed + inbox cell | `title, company, platforms[], price, eligibility, variant: 'creator'\|'lister', counts?` |
| **StatusPill** | Status indicator | `status`, exposes `animateTo(newStatus)` worklet |
| **EligibilityBadge** | Compact badge on card | `eligible: boolean, reason?` |
| **EligibilityRow** | Single pre-condition row | `label, required, user_value, passed, action?` |
| **ConditionChecklist** | Post-condition list | `items[], mode: 'self'\|'review', onChange` |
| **MetricChip** | Follower / avg-views chip | `platform, label, value, delta?, lastUpdated?` |
| **VideoURLInput** | TikTok/IG URL with preview | `platform, onChange, onPreview` |
| **VideoThumbnail** | 9:16 or 1:1 preview | `url, aspect, onPress` |
| **ButtonPrimary** | CTA button | `label, onPress, loading, disabled, variant` |
| **ButtonSecondary** | Low-emphasis button | `label, onPress, loading, disabled` |
| **FAB** | Floating action (Lister) | `icon, onPress` |
| **Chip** | Filter + category | `label, active, variant, onPress` |
| **SectionHeader** | ══════ Label ══════ | `title, action?` |
| **ProgressDots** | Wizard progress | `total, current` |
| **DiffCard** | "What changed" card | `oldValue, newValue, fieldName` |
| **EmptyState** | Generic empty | `illustration: EmptyStateIllustrationKey, title, body, primaryAction, secondaryAction?` — `EmptyStateIllustrationKey` is a string-keyed registry: `'no_campaigns' \| 'no_eligible' \| 'no_applications' \| 'no_submissions' \| 'lister_no_campaigns' \| 'lister_no_applications' \| 'lister_no_submissions' \| 'network_error' \| 'not_found'`. Each key maps to a ship-in-repo SVG (`assets/illustrations/<key>.svg`) using only `--primary` / `--cta` / `--ink` per §1.5 |
| **ErrorState** | Recoverable error | `title, body, onRetry` |
| **SkeletonCard** | Loading placeholder | `height, shape` |
| **RefreshOdometer** | Number-scroll animation | `value, previousValue` |
| **Toast** | Top banner | `message, variant, duration` |
| **ConfirmationModal** | Two-button alert | `title, body, primaryLabel, onConfirm, variant` |
| **BottomSheet** | Filters + quick actions | `children, snapPoints` |
| **CelebrationBurst** | Approval confetti | `anchorRef` |
| **TabBar** | Custom tab bar per role | `tabs[], activeIndex` |
| **NotificationRow** | Inbox item | `type, title, timestamp, read, href` |
| **ReuseBadge** | "Also submitted to N other campaigns" chip on submission row / review sheet — surfaces cross-posting without blocking it | `count, variant: 'inline'\|'header'` |
| **OverrideEligibilityDialog** | Approve-time confirmation for listers overriding a failed post-condition; renders the failed-conditions summary + required typed confirmation | `failedConditions[], onConfirm, onCancel` |
| **MetricStaleIndicator** | Per-metric tri-state marker attached to `MetricChip` (fresh / stale / refreshing / failed) — drives the visual in §5.4 | `state: 'fresh'\|'stale'\|'refreshing'\|'failed', retryAfterSec?, errorKind?: 'no_videos'\|'scrape_error', onRetry?` |
| **AddHandleSheet** | Bottom-sheet flow that adds a TikTok/IG handle inline from any surface (Campaign Detail eligibility row, Edit Handles). Owns its own state machine across `input → dispatching → scraping → (partial) → fresh \| failed` — see §4.2 | `platform: 'tiktok'\|'instagram', preFilledHandle?: string, onSuccess: (socialLinkId) => void, onCancel: () => void` |

---

## 7. Anti-Patterns to Avoid

- Heavy skeuomorphism.
- Emoji as UI icons.
- Soft blurred drop shadows — breaks the Neubrutalism contract.
- Scale-transform hover states that cause layout shift.
- Punitive copy around eligibility, rejection, or cancellation. Always blameless.
- 5-tab bars.
- Animated celebrations on the *rejected* path.
- Dense color coding without icons — every status uses color + icon + text.
- Hiding metric refresh as a tiny setting. Pull-to-refresh is the gesture users expect.
- Modal-over-modal.

---

## 8. Pre-Delivery Checklist

- [ ] All SVG icons sourced from Lucide React Native, consistent 24×24 viewBox
- [ ] No emojis used as UI elements
- [ ] All `Pressable` components have press feedback
- [ ] Press/hover transitions 150–300ms
- [ ] Body text contrast verified ≥ 4.5:1 (`#0F172A` on `#FFF9F2` = 17.8:1, AAA)
- [ ] Primary pink `#EC4899` never used as foreground text at body size (fails AAA at 3.3:1) — swap to `--primary-deep` `#831843` where text meaning is required
- [ ] All content text respects system Dynamic Type / font scale up to 130% (`maxFontSizeMultiplier = 1.3`); UI chrome (pills, tab labels, status chips) opts out with `allowFontScaling={false}`
- [ ] All `EmptyState` usages reference a key from the illustration registry; no loose illustration SVGs
- [ ] Focus states visible for external keyboard
- [ ] `useReducedMotion()` respected on all spring/shake/confetti
- [ ] Responsive across 360dp / 375pt / 390pt / 430pt
- [ ] Safe-area insets handled
- [ ] Color is never the sole status indicator
- [ ] All images have `accessibilityLabel`

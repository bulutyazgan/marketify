---
name: Marketify project
description: Mobile marketplace MVP — Expo + RN + Supabase, Apify-powered creator metrics, no payments in v1
type: project
originSessionId: 0461a92f-f322-4d81-b1ad-3e67a5008603
---
Marketify is a mobile marketplace where creators claim bounties from listers, built on Expo + React Native + Supabase. v1 ships with: custom HS256 JWT auth (no Supabase Auth, no platform OAuth), Apify scrapers for TikTok/Instagram metrics, two roles (one per account), display-only price (no payments), neubrutalism design language.

**Why:** User scoped tightly for a 4-week solo MVP; OAuth friction for creators is unacceptable, so Apify is the metric source.

**How to apply:** Treat `docs/product-plan.md`, `docs/design.md`, and `docs/tech-architecture.md` as the canonical specs. Don't invent product behavior. Scope cuts in product-plan.md §3.2 (no payments, no OAuth, no dual-role, no push, no dark mode, no revisions) are firm.

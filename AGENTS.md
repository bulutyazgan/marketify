# Marketify — Agent Conventions

These rules apply to **every** AI coding agent (Claude Code, Amp, Codex, etc.) that touches this repo. They are read on every fresh context.

## Authoritative specs

- `docs/product-plan.md` — canonical product, scope, build sequence
- `docs/design.md` — visual language, components, screens, motion
- `docs/tech-architecture.md` — DB schema, RLS, triggers, Apify integration, edge-function specs

If a task is ambiguous, the specs decide. Do not invent product behavior.

## Stack

- **Mobile:** Expo (managed) + React Native + TypeScript (strict)
- **Backend:** Supabase (Postgres + Edge Functions + Realtime)
- **Auth:** custom HS256 JWT signed by our own edge function (NOT Supabase Auth) — see `docs/product-plan.md §2`
- **Metrics:** Apify scrapers (no OAuth) — see `docs/tech-architecture.md §3`
- **Package manager:** `bun` (do not use npm/yarn/pnpm)
- **Animations:** Reanimated 3 worklets
- **Icons:** Lucide React Native (no emoji in product UI)
- **Routing:** expo-router
- **State:** React context + MMKV for persisted slices

## MCP usage (required, not optional)

- **Supabase MCP (`mcp__plugin_supabase_supabase__*`)** for ALL DB operations: migrations (`apply_migration`), queries (`execute_sql`), edge function deploys (`deploy_edge_function`), type generation (`generate_typescript_types`), security advisors (`get_advisors`). Do **not** use the local `supabase` CLI for these.
- **mobile-mcp (`mcp__mobile-mcp__*`)** for any UI verification on iOS simulator. A UI story is not done without a screenshot from `mobile_take_screenshot`.
- **Context7 MCP (`mcp__plugin_context7_context7__*`)** for library docs (Expo, Reanimated, Supabase JS, expo-router) — your training data may be stale.
- **Apify** is called from edge functions, not the app. Key is `APIFY_KEY` in `.env`.

## Quality gates (every commit)

1. `bun run typecheck` (`tsc --noEmit`) — zero errors
2. `bun run lint` (`expo lint`) — no new warnings
3. After any schema/RLS change: `get_advisors({type: "security"})` — zero error-level findings
4. For UI changes: mobile-mcp verification + screenshot saved under `scripts/ralph/screenshots/`
5. Code review by `feature-dev:code-reviewer` subagent before commit

## Migration discipline

- Append-only — never edit a previously applied migration
- Named `us_NNN_short_description` (matches the Ralph story ID when applicable)
- Always regenerate `src/types/supabase.ts` and commit it in the same commit
- Always run security advisors after RLS / schema changes

## Folder layout

- `app/` — expo-router routes (grouped by `(auth)`, `(creator)`, `(lister)`)
- `src/components/primitives/` — reusable atoms (Button, Chip, etc.)
- `src/components/shared/` — cross-feature composites (EmptyState, ErrorState)
- `src/screens/` — screen-specific composites
- `src/lib/` — supabase client, auth context, utilities
- `src/design/` — tokens, typography, motion
- `src/types/` — including generated `supabase.ts`
- `supabase/functions/<name>/` — edge functions
- `supabase/functions/_shared/` — shared edge-function utilities
- `supabase/migrations/` — append-only SQL
- `scripts/ralph/` — autonomous loop config (do not modify mid-loop)
- `docs/` — authoritative specs (do not edit unless story explicitly requires)

## Hard scope rules (v1)

- No payments — `price_cents` is display-only
- No platform OAuth — Apify only
- One role per account — no dual-role
- No push notifications — in-app only
- No revision-request — binary approve/reject
- No dark mode

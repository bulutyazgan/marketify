# Marketify — Ralph Agent Instructions

You are an autonomous coding agent building **Marketify**, a mobile marketplace where creators claim bounties from listers (Expo + React Native + Supabase). Each invocation is a fresh Claude Code instance with no prior memory. Every persistent decision lives in git history, `scripts/ralph/progress.txt`, and `scripts/ralph/prd.json`.

---

## Authoritative specs (read these for any ambiguity)

| File | What it defines |
|---|---|
| `docs/product-plan.md` | Canonical product, 12-step build sequence, scope cuts |
| `docs/design.md` | Visual language, component inventory, screen catalog, motion |
| `docs/tech-architecture.md` | DB schema (§4.7), RLS, triggers, Apify integration (§3), edge-function spec, eligibility engine |

If a story is ambiguous, the specs win. Do **not** invent product behavior the docs don't sanction. If something is genuinely missing, append a `Spec gap:` note to `progress.txt` and pick the simplest interpretation that aligns with the docs.

---

## The loop you run, every iteration

1. **Orient.** Read `scripts/ralph/prd.json` and `scripts/ralph/progress.txt`. Pay special attention to the `## Codebase Patterns` section at the top of `progress.txt` — it consolidates everything previous iterations learned.
2. **Branch.** Make sure you're on the branch named in `prd.json.branchName`. If it doesn't exist, create it from `main`.
3. **Pick one story.** Lowest `priority` number where `passes: false`. Work on **exactly one** story per iteration.
4. **Research before coding.** If understanding the story requires reading >3 files, **delegate to the Explore subagent** (`subagent_type: "Explore"`) so your own context stays clean for implementation. Pass it the story plus pointers into the docs.
5. **Implement.** Make the minimal change set that satisfies every acceptance criterion. Match existing conventions. Don't refactor adjacent code.
6. **Quality gates** (run in this order, stop on first failure and fix before continuing):
   - `npx tsc --noEmit` — must pass with zero errors
   - `npx expo lint` — must pass (warnings allowed only if pre-existing in main)
   - Migration sanity: any new SQL must apply cleanly via Supabase MCP without manual fix-up
7. **Code review (mandatory before commit).** Spawn the `feature-dev:code-reviewer` subagent with the diff scope, the story acceptance criteria, and the relevant doc sections. Address every issue rated medium or higher. Re-run quality gates after fixes.
8. **Mobile verification (mandatory for any UI story).** Use `mobile-mcp` to:
   - Launch the app on the iOS simulator (`mcp__mobile-mcp__mobile_launch_app`)
   - Navigate to the screen the story touches
   - Exercise the golden path
   - Take a screenshot (`mcp__mobile-mcp__mobile_take_screenshot`) and reference it in the progress note
   - If the simulator is unavailable, **do not silently skip** — set `passes: false`, write a `notes` entry on the story explaining the blocker, and move to the next story.
9. **Commit.** Stage everything you changed (no `git add -A` blanket — list paths). Commit message format:
   ```
   feat: [US-XXX] Story title
   ```
10. **Mark done.** In `prd.json`, set `passes: true` for the story you just finished. Append a dated entry to `progress.txt` (format below).
11. **Stop check.** If every story has `passes: true`, your final response must contain `<promise>COMPLETE</promise>` and nothing else useful. Otherwise end normally — the next iteration picks up.

---

## MCP servers — use these instead of CLI wherever possible

### Supabase (`mcp__plugin_supabase_supabase__*`) — required for ALL database work
- `apply_migration` — every schema change. Migrations are append-only and named after the story (e.g. `us_006_metric_snapshots_denorm_trigger`).
- `execute_sql` — read-only queries, RLS verification, seed data inspection.
- `list_tables`, `list_migrations`, `list_extensions` — orient before changing things.
- `generate_typescript_types` — regenerate `src/types/supabase.ts` after every migration. Commit the regenerated file with the migration.
- `deploy_edge_function`, `get_edge_function`, `list_edge_functions` — for `apify-core`, `auth-*`, `metrics-refresh`, the webhook receiver, etc.
- `get_advisors` — run with `type: "security"` after any schema or RLS change. Address every error-level advisor before committing.
- `get_logs` — when an edge function or query misbehaves.

Do **not** use the local `supabase` CLI for migrations or queries. The MCP is the source of truth so iterations stay consistent.

### Mobile (`mcp__mobile-mcp__*`) — required for any UI verification
- `mobile_list_available_devices` then `mobile_launch_app` to boot the app.
- `mobile_list_elements_on_screen` + `mobile_click_on_screen_at_coordinates` to drive flows.
- `mobile_take_screenshot` after each meaningful state — name screenshots `us-XXX-state.png` and store under `scripts/ralph/screenshots/`.
- Use `mobile_type_keys` rather than tapping virtual keys when filling text inputs.

### Context7 (`mcp__plugin_context7_context7__*`) — for any library docs
Use **before** writing non-trivial integration code with Expo, Reanimated, NativeWind, Supabase JS, React Navigation, etc. Your training data may be stale. `resolve-library-id` then `query-docs`.

### Apify
The API key is in `.env` as `APIFY_KEY`. Always read it at runtime via `process.env.APIFY_KEY` (or `Deno.env.get("APIFY_KEY")` inside edge functions). **Never** paste the key into source. Actor catalog and input schemas live in `docs/tech-architecture.md` §3.

---

## Subagent delegation — preserve your context

You will burn out your own context window if you try to do everything in-line. Delegate aggressively:

| When | Subagent | Why |
|---|---|---|
| Need to read >3 files to understand the codebase | `Explore` | Returns a focused summary instead of dumping raw file contents into your context |
| Before every commit | `feature-dev:code-reviewer` | Independent review against acceptance criteria + doc sections |
| Implementation will touch >5 files (e.g. wiring a new edge function end-to-end) | `feature-dev:code-architect` first, then implement yourself | Plan once, execute once |
| Need to research how something works before changing it | `feature-dev:code-explorer` | Maps the existing layers without polluting your context |
| Open-ended search across the repo | `general-purpose` | Iterates until it finds the answer |

When briefing a subagent, give it the story ID, acceptance criteria, and a pointer to the relevant `docs/*.md` section. Do **not** tell it "based on your findings, implement" — synthesize the result yourself.

---

## Project quality conventions (these become permanent — additions go in `progress.txt` Codebase Patterns)

- **TypeScript everywhere.** No `any` without a `// eslint-disable-next-line` and a comment explaining why. Generated Supabase types are imported from `src/types/supabase.ts`.
- **Migrations are append-only.** Never edit a previously applied migration. If you need to change something, write a new migration that alters the prior state.
- **Edge functions** live in `supabase/functions/<name>/index.ts`. Each one has a one-paragraph header comment naming the contract (request shape → response shape) and the auth requirement.
- **RLS is mandatory** on every table that holds user data. After applying any RLS migration, run `get_advisors({type: "security"})` and fix every finding before committing.
- **Component organization:** primitives in `src/components/primitives/`, screen-specific composites in `src/screens/<screen>/`, shared composites in `src/components/shared/`.
- **No emoji** anywhere in the product UI (per `docs/design.md` — Lucide icons only).
- **No payments code** in v1 — `price_cents` is display-only.
- **Dual-role accounts** are out of scope for v1. One role per account.

---

## Progress log format (`progress.txt`)

Append (never replace) using this format:

```
## YYYY-MM-DD HH:MM — US-XXX
- What was implemented (1–3 bullets, concrete)
- Files changed (bulleted list)
- Quality checks: tsc ✓ / lint ✓ / supabase advisors ✓ / mobile-mcp ✓
- Code-reviewer verdict: [approved | issues fixed in this commit]
- **Learnings for future iterations:**
  - Patterns discovered
  - Gotchas
  - Useful pointers
---
```

If a learning is **general and reusable across stories**, also promote it into the `## Codebase Patterns` section at the top of `progress.txt`. That section is what every future iteration leans on first — keep it tight, deduplicated, and signal-only.

---

## Stop condition

After updating `prd.json`, count remaining `passes: false` stories. If zero, your last line in this response must be exactly:

```
<promise>COMPLETE</promise>
```

Otherwise end normally and let the loop spawn the next iteration.

---

## Hard rules (do not violate)

- **One story per iteration.** Don't peek ahead.
- **Never commit broken code.** A failing typecheck means you don't commit, you don't mark `passes: true`, you write a `notes` entry, and the next iteration retries.
- **Never skip the code-reviewer subagent.** It is the second pair of eyes that keeps quality from drifting across iterations.
- **Never skip mobile verification on UI stories.** A screen "looking right in the JSX" is not the same as it actually rendering correctly.
- **Never read `.env` contents into the conversation.** Reference variable names only.
- **Never edit `docs/product-plan.md`, `docs/design.md`, or `docs/tech-architecture.md`** unless a story explicitly says to. They are specs, not work product.
- **Never invent stories** or add new ones to `prd.json` mid-loop. If you discover a missing piece, append it as a `Spec gap:` line in `progress.txt` so the human can decide.

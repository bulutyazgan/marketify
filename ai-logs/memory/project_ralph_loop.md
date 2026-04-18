---
name: Marketify Ralph autonomous loop
description: Overnight autonomous build loop — scripts/ralph/, 65-story prd.json, Claude Code mode, mobile-mcp + Supabase MCP + code-reviewer subagent feedback
type: project
originSessionId: 0461a92f-f322-4d81-b1ad-3e67a5008603
---
An autonomous Ralph loop is set up under `scripts/ralph/` (snarktank/ralph pattern, Claude Code variant). It was launched 2026-04-17 with `max_iterations=60` to build the Marketify MVP overnight.

**Layout:**
- `scripts/ralph/ralph.sh` — the loop driver (`./ralph.sh --tool claude N`)
- `scripts/ralph/CLAUDE.md` — the per-iteration prompt; mandates Supabase MCP for DB, mobile-mcp for UI verification, `feature-dev:code-reviewer` subagent before every commit, `Explore` subagent for any research >3 files
- `scripts/ralph/prd.json` — 65 right-sized user stories (US-001 → US-065) covering the full v1 build sequence on branch `ralph/marketify-mvp`
- `scripts/ralph/progress.txt` — append-only iteration log with a `## Codebase Patterns` consolidation header
- `scripts/ralph/screenshots/` — mobile-mcp output per UI story
- `scripts/ralph/ralph.log` — runtime log (gitignored)

**Why:** User asked for an overnight autonomous build using Ralph that follows our development plan and respects every tool we have (Supabase MCP, mobile-mcp, Apify, code review).

**How to apply:** When the user asks about Ralph progress, read `scripts/ralph/progress.txt` (Codebase Patterns + recent entries) and `scripts/ralph/prd.json | jq '.userStories[] | {id,title,passes}'` for status. Don't re-run the loop without checking the log first; the existing run may still be in flight. To resume after a crash, just re-launch `scripts/ralph/ralph.sh --tool claude N` — it picks up the next `passes:false` story automatically.

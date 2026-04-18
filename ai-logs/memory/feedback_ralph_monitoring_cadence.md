---
name: Ralph monitoring reply cadence
description: When monitoring the Ralph loop, batch routine acknowledgments to ~once per 30 seconds instead of replying to every tool-call notification
type: feedback
originSessionId: 0461a92f-f322-4d81-b1ad-3e67a5008603
---
When monitoring the Ralph autonomous loop via activity/status monitors, do **not** reply to every single `[TOOL]` task-notification event. Batch them and acknowledge roughly once every 30 seconds (or on meaningful transitions: iter boundary, commit, error, phase change).

**Why:** The user explicitly said "Decrease routine speed, every 30 seconds." Per-event replies create noise and waste tokens — the signal value is low because they already see the monitor events directly. Only respond when it's worth reading.

**How to apply:**
- Stay silent on individual routine `[TOOL]` events (Bash, Read, Grep, screenshots, SQL reads).
- Reply at most once per ~30s with a rolled-up summary if the phase has shifted (e.g., "Code-reviewer done → committing," "Mobile-mcp verification started," "Iter boundary → US-036 starting").
- Always reply promptly for: errors that need action, iter completion, new commits/story transitions, watchdog kills, explicit user questions.
- If nothing has changed phase-wise in the last 30s, stay silent entirely — don't pad.

**Even quieter cadence when the user is present at the laptop (added 2026-04-18):** when the user explicitly says they're back / "stop active monitoring" / "report every N minutes," drop per-event replies entirely and only respond to the 5-min status-snapshot monitor (or whatever interval they named) plus genuine action-required events (errors, watchdog kills, explicit questions). The 30s batched cadence is for *passive background monitoring while the user is away*; once they're sitting in front of the terminal they don't need a stream of acks.

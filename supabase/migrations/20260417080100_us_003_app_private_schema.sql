-- US-003 (companion) — private schema for security-definer helpers.
-- Per docs/tech-architecture.md §4.7: triggers and internal functions live in
-- app_private and are invoked via security-definer functions. anon +
-- authenticated must never hit this schema directly.

create schema if not exists app_private;
revoke all on schema app_private from anon, authenticated;

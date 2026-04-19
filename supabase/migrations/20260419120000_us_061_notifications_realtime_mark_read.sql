-- US-061 — Notifications inbox + bell badge
--
-- Adds `public.notifications` to the `supabase_realtime` publication so the
-- bell badge and inbox screens receive INSERT (new notification) + UPDATE
-- (mark-as-read) events scoped to the caller's own rows. RLS policy
-- `notifications_self_rw` (us_009) gates visibility via
-- `user_id = current_user_id()` — the Realtime broker evaluates that policy
-- server-side (Codebase Pattern #123 / #105).
--
-- Mark-as-read path is plain PostgREST: the existing `notifications_self_rw`
-- policy (polcmd='*') already permits `update … set read_at = now() where
-- user_id = current_user_id()` from the client, so no RPC is needed.
-- Spec §5.8 names a `POST /notifications/mark-read` endpoint; for v1 we
-- satisfy the contract entirely via RLS + direct table update and skip the
-- extra RPC hop. If a future story needs atomic batch semantics across
-- additional side-effects (e.g. decrementing a cached unread counter), it
-- can introduce a SECURITY DEFINER wrapper without churning this migration.
--
-- Replica identity is set to FULL so UPDATE events ship the complete row in
-- `payload.new`. The default PK-only identity would be enough for today's
-- mark-read path (clients only read `id` + `read_at`), but every existing
-- realtime subscription in the project does a `{...prior, ...payload.new}`
-- merge on UPDATE (see `app/(creator)/applications.tsx`,
-- `app/(creator)/submissions.tsx`, `app/(lister)/inbox/applications.tsx`)
-- which would corrupt local state with `undefined` fields if a future emitter
-- touched any column other than `read_at`. notifications is a low-volume
-- write surface so the FULL WAL overhead is negligible.

alter publication supabase_realtime add table public.notifications;
alter table public.notifications replica identity full;

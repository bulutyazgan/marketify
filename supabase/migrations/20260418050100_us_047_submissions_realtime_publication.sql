-- US-047 — add public.submissions to the supabase_realtime publication so
-- creators receive UPDATE events when a lister flips their submission to
-- approved or rejected. RLS is evaluated by the Realtime broker via
-- supabase.realtime.setAuth(marketify_jwt); submissions has no direct
-- creator_id column, so we rely on the `submissions_creator_rw` policy's
-- join-through-applications subquery to gate the stream (same as the
-- REST read path). Default replica identity (primary key) is sufficient
-- because the client only reads payload.new.id + payload.new.status.

alter publication supabase_realtime add table public.submissions;

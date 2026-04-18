-- US-044 — add public.applications to the supabase_realtime publication so
-- creators receive UPDATE events on their own applications (RLS applied by
-- the Realtime broker via supabase.realtime.setAuth(marketify_jwt)). The
-- default replica identity (primary key only) is sufficient because the
-- client only reads payload.new.id + payload.new.status; the old-row
-- record is not consulted.

alter publication supabase_realtime add table public.applications;

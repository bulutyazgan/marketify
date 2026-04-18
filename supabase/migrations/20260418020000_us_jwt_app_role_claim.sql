-- The Marketify JWT now puts the Postgres role under the standard `role` claim
-- (always "authenticated") and the app-level role under `app_role`. PostgREST
-- uses `role` to switch DB role; RLS reads the app role through this helper.
create or replace function public.current_user_role()
returns public.user_role
language sql
stable
set search_path = ''
as $$
  select nullif(auth.jwt() ->> 'app_role', '')::public.user_role
$$;

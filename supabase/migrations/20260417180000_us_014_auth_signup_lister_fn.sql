-- US-014 — RPC backing the auth-signup-lister edge function.
--
-- Contract: public.auth_signup_lister(p_username, p_email, p_org_name,
-- p_website_url) returns jsonb. On success: {"user_id": "<uuid>"}. On
-- conflict: {"error": "USERNAME_TAKEN" | "EMAIL_TAKEN"}. Any other
-- unique_violation is re-raised for the edge function to log as 500.
--
-- Atomicity: the function body runs in a single implicit transaction; a
-- failure on the lister_profiles insert rolls back the users insert too,
-- satisfying the "single transaction" acceptance criterion without
-- relying on PostgREST's per-call transactions.
--
-- Why this is in a migration: two separate supabase-js inserts are two
-- separate transactions, so a mid-flight crash would leave orphan users
-- rows. An RPC function gives us true atomicity for the signup flow.
--
-- Auth: revoked from anon/authenticated/public. Only service_role (used
-- by the edge function) may execute.
--
-- Spec gap handoff: the spec also requires per-IP rate limiting via a
-- signup_attempts table (§5.1) — that table does not exist yet and is
-- tracked as a future-story item in progress.txt Codebase Patterns. This
-- function is intentionally rate-limit-free for now.

create or replace function public.auth_signup_lister(
  p_username extensions.citext,
  p_email extensions.citext,
  p_org_name text,
  p_website_url text default null
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_constraint text;
begin
  insert into public.users (role, username, email)
  values ('lister'::public.user_role, p_username, p_email)
  returning id into v_user_id;

  insert into public.lister_profiles (user_id, org_name, website_url)
  values (v_user_id, p_org_name, p_website_url);

  return jsonb_build_object('user_id', v_user_id);
exception
  when unique_violation then
    -- Constraint names below are Postgres's default for the inline `unique`
    -- declarations on public.users (username, email) in us_004. If US-004
    -- is ever rewritten to give those constraints explicit names, update
    -- both string literals here.
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint = 'users_username_key' then
      return jsonb_build_object('error', 'USERNAME_TAKEN');
    elsif v_constraint = 'users_email_key' then
      return jsonb_build_object('error', 'EMAIL_TAKEN');
    else
      raise;
    end if;
end;
$$;

revoke all on function public.auth_signup_lister(
  extensions.citext, extensions.citext, text, text
) from public;
revoke all on function public.auth_signup_lister(
  extensions.citext, extensions.citext, text, text
) from anon, authenticated;
grant execute on function public.auth_signup_lister(
  extensions.citext, extensions.citext, text, text
) to service_role;

comment on function public.auth_signup_lister(
  extensions.citext, extensions.citext, text, text
) is 'US-014 atomic signup RPC. Called only by the auth-signup-lister edge function via service_role. Returns jsonb {user_id} on success or {error: USERNAME_TAKEN|EMAIL_TAKEN}.';

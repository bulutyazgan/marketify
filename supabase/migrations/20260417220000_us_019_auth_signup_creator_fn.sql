-- US-019 — RPC backing the auth-signup-creator edge function.
--
-- Contract: public.auth_signup_creator(p_username, p_tiktok_handle,
-- p_instagram_handle) returns jsonb. On success: {"user_id": "<uuid>"}.
-- On conflict: {"error": "USERNAME_TAKEN" | "HANDLE_TAKEN"}. Any other
-- unique_violation is re-raised for the edge function to log as 500.
--
-- Atomicity: inserts into users + creator_profiles + social_links (0-2
-- rows) all run in the function's implicit transaction. A failure on any
-- row rolls back the whole flow — no orphan users/creator_profiles.
--
-- Handle validation: the edge function is responsible for (a) trimming +
-- stripping the leading '@', (b) requiring at least one handle. The RPC
-- treats NULL handles as "not provided" and just skips that social_links
-- insert. The RPC does not revalidate "at least one handle" — the edge
-- function guarantees it.
--
-- Auth: revoked from anon/authenticated/public. Only service_role (used
-- by the edge function) may execute.
--
-- Spec gap handoff: per-IP rate limiting via signup_attempts (spec §5.1)
-- is still pending — tracked in progress.txt Codebase Patterns alongside
-- the same gap flagged by US-014.

create or replace function public.auth_signup_creator(
  p_username extensions.citext,
  p_tiktok_handle extensions.citext default null,
  p_instagram_handle extensions.citext default null
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_constraint text;
begin
  insert into public.users (role, username)
  values ('creator'::public.user_role, p_username)
  returning id into v_user_id;

  insert into public.creator_profiles (user_id)
  values (v_user_id);

  if p_tiktok_handle is not null then
    insert into public.social_links (user_id, platform, handle)
    values (v_user_id, 'tiktok'::public.platform, p_tiktok_handle);
  end if;

  if p_instagram_handle is not null then
    insert into public.social_links (user_id, platform, handle)
    values (v_user_id, 'instagram'::public.platform, p_instagram_handle);
  end if;

  return jsonb_build_object('user_id', v_user_id);
exception
  when unique_violation then
    -- Constraint names below are Postgres's default for the inline `unique`
    -- declaration on public.users (username) in us_004 plus the partial
    -- unique indexes on public.social_links from us_004. If US-004 is ever
    -- rewritten to rename any of them, update each branch here.
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint = 'users_username_key' then
      return jsonb_build_object('error', 'USERNAME_TAKEN');
    elsif v_constraint in (
      'social_links_platform_handle_uniq',
      'social_links_user_platform_uniq'
    ) then
      return jsonb_build_object('error', 'HANDLE_TAKEN');
    else
      raise;
    end if;
end;
$$;

revoke all on function public.auth_signup_creator(
  extensions.citext, extensions.citext, extensions.citext
) from public;
revoke all on function public.auth_signup_creator(
  extensions.citext, extensions.citext, extensions.citext
) from anon, authenticated;
grant execute on function public.auth_signup_creator(
  extensions.citext, extensions.citext, extensions.citext
) to service_role;

comment on function public.auth_signup_creator(
  extensions.citext, extensions.citext, extensions.citext
) is 'US-019 atomic signup RPC. Called only by the auth-signup-creator edge function via service_role. Returns jsonb {user_id} on success or {error: USERNAME_TAKEN|HANDLE_TAKEN}.';

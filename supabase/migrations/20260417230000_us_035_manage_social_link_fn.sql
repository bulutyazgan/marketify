-- US-035 — RPC backing the manage-social-link edge function.
--
-- Contract: public.manage_social_link(p_user_id, p_action, p_platform,
--   p_handle, p_social_link_id) returns jsonb.
--   On 'add' success:    {"social_link_id": "<uuid>"}.
--   On 'unlink' success: {"ok": true}.
--   On conflict:         {"error": "ALREADY_LINKED" | "HANDLE_TAKEN"
--                                | "LINK_NOT_FOUND" | "INVALID_REQUEST"}.
--
-- Atomicity: a single INSERT (add) or a single UPDATE (unlink) run inside
-- the function's implicit transaction. An add that would violate either
-- partial unique index (user_platform_uniq / platform_handle_uniq) is
-- caught and mapped; anything else is re-raised as 500 for the edge
-- function to log.
--
-- Handle normalization: the edge function is responsible for trimming +
-- stripping the leading '@'. The RPC accepts citext and trusts the caller.
--
-- Auth: revoked from anon/authenticated/public. Only service_role (used
-- by the edge function) may execute.

create or replace function public.manage_social_link(
  p_user_id uuid,
  p_action text,
  p_platform public.platform default null,
  p_handle extensions.citext default null,
  p_social_link_id uuid default null
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_new_id uuid;
  v_updated_id uuid;
  v_constraint text;
begin
  if p_action = 'add' then
    if p_platform is null or p_handle is null or length(trim(p_handle::text)) = 0 then
      return jsonb_build_object('error', 'INVALID_REQUEST');
    end if;

    insert into public.social_links (user_id, platform, handle)
    values (p_user_id, p_platform, p_handle)
    returning id into v_new_id;
    return jsonb_build_object('social_link_id', v_new_id);

  elsif p_action = 'unlink' then
    if p_social_link_id is null then
      return jsonb_build_object('error', 'INVALID_REQUEST');
    end if;

    update public.social_links
       set status = 'unlinked'::public.social_link_status,
           updated_at = pg_catalog.now()
     where id = p_social_link_id
       and user_id = p_user_id
       and status <> 'unlinked'::public.social_link_status
     returning id into v_updated_id;

    if v_updated_id is null then
      return jsonb_build_object('error', 'LINK_NOT_FOUND');
    end if;
    return jsonb_build_object('ok', true);

  else
    return jsonb_build_object('error', 'INVALID_REQUEST');
  end if;

exception
  when unique_violation then
    -- Partial unique indexes scoped to `status <> 'unlinked'` (us_004).
    -- Update this branch if us_004 ever renames the indexes.
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint = 'social_links_user_platform_uniq' then
      return jsonb_build_object('error', 'ALREADY_LINKED');
    elsif v_constraint = 'social_links_platform_handle_uniq' then
      return jsonb_build_object('error', 'HANDLE_TAKEN');
    else
      raise;
    end if;
end;
$$;

revoke all on function public.manage_social_link(
  uuid, text, public.platform, extensions.citext, uuid
) from public;
revoke all on function public.manage_social_link(
  uuid, text, public.platform, extensions.citext, uuid
) from anon, authenticated;
grant execute on function public.manage_social_link(
  uuid, text, public.platform, extensions.citext, uuid
) to service_role;

comment on function public.manage_social_link(
  uuid, text, public.platform, extensions.citext, uuid
) is 'US-035 manage-social-link RPC. Called only by the manage-social-link edge function via service_role. Add inserts a new social_links row; unlink sets status=unlinked (partial unique index releases).';

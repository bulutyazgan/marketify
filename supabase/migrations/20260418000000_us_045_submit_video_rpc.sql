-- US-045 — RPC backing the submit-video edge function.
--
-- Contract: public.submit_video_rpc(
--   p_application_id uuid,
--   p_creator_id uuid,
--   p_video_url text,
--   p_platform public.platform,
--   p_external_id text default null,
--   p_oembed jsonb default null
-- ) returns jsonb.
--
-- On success: {"submission_id": "<uuid>"}.
-- On conflict: {"error": "APPLICATION_NOT_FOUND" | "APPLICATION_NOT_APPROVED" | "SUBMISSION_EXISTS"}.
--
-- Concurrency: locks the application row FOR UPDATE so a concurrent
-- approval flip or a duplicate-submit attempt serialises through this
-- gate. The partial unique index `submissions_open_uniq` on
-- (application_id) WHERE status IN ('pending','approved') is the DB-level
-- guarantee; the explicit pre-check yields a clean 409 instead of relying
-- on unique_violation diagnostics.
--
-- Caller responsibilities (NOT enforced here):
--   - URL shape validation (TikTok / Instagram regex)
--   - oEmbed liveness check
--   - post_condition affirmations completeness
--
-- Auth: revoked from anon/authenticated/public. Only service_role (used
-- by the edge function) may execute.

create or replace function public.submit_video_rpc(
  p_application_id uuid,
  p_creator_id uuid,
  p_video_url text,
  p_platform public.platform,
  p_external_id text default null,
  p_oembed jsonb default null
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_creator_id uuid;
  v_status public.application_status;
  v_submission_id uuid;
begin
  select a.creator_id, a.status
    into v_creator_id, v_status
    from public.applications a
   where a.id = p_application_id
     for update;

  if not found or v_creator_id <> p_creator_id then
    return jsonb_build_object('error', 'APPLICATION_NOT_FOUND');
  end if;

  if v_status <> 'approved'::public.application_status then
    return jsonb_build_object('error', 'APPLICATION_NOT_APPROVED');
  end if;

  if exists (
    select 1
      from public.submissions s
     where s.application_id = p_application_id
       and s.status in (
         'pending'::public.submission_status,
         'approved'::public.submission_status
       )
  ) then
    return jsonb_build_object('error', 'SUBMISSION_EXISTS');
  end if;

  insert into public.submissions (application_id, status)
  values (p_application_id, 'pending'::public.submission_status)
  returning id into v_submission_id;

  insert into public.submission_videos (
    submission_id, platform, url, external_id, oembed_cached, last_validated_at, sort_order
  ) values (
    v_submission_id, p_platform, p_video_url, p_external_id, p_oembed, now(), 0
  );

  return jsonb_build_object('submission_id', v_submission_id);
exception
  when unique_violation then
    return jsonb_build_object('error', 'SUBMISSION_EXISTS');
end;
$$;

revoke all on function public.submit_video_rpc(uuid, uuid, text, public.platform, text, jsonb) from public;
revoke all on function public.submit_video_rpc(uuid, uuid, text, public.platform, text, jsonb) from anon, authenticated;
grant execute on function public.submit_video_rpc(uuid, uuid, text, public.platform, text, jsonb) to service_role;

comment on function public.submit_video_rpc(uuid, uuid, text, public.platform, text, jsonb) is
  'US-045 submit-video RPC. Called only by the submit-video edge function via service_role. Acquires FOR UPDATE on the application row to serialise duplicate submits and approval-flip races; returns jsonb {submission_id} or {error}.';

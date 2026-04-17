-- US-041 — RPC backing the apply-to-listing edge function.
--
-- Contract: public.apply_to_listing_rpc(
--   p_listing_id uuid,
--   p_creator_id uuid,
--   p_expected_version_id uuid,
--   p_cover_note text default null
-- ) returns jsonb.
--
-- On success: {"application_id": "<uuid>", "listing_version_id": "<uuid>"}.
-- On conflict: {"error": "LISTING_NOT_FOUND" | "LISTING_NOT_ACTIVE" |
--   "LISTING_VERSION_CHANGED" (+ "current_version_id") | "ALREADY_APPLIED"}.
--
-- Concurrency: acquires a row lock via SELECT ... FOR UPDATE on the
-- listing, which serialises this flow against app_private.bump_listing_version
-- (that runs under the UPDATE's own row lock on listings). Closes the
-- race described in docs/tech-architecture.md §5.5 where an applicant's
-- INSERT could interleave with a lister's version bump and end up pinned
-- to an already-stale version.
--
-- Eligibility — NOT re-evaluated inside the RPC. The edge function runs
-- the pre-condition evaluator in TS against the same version_id it then
-- passes as p_expected_version_id. If the version changes between the
-- edge function's read and this RPC's lock, the RPC returns
-- LISTING_VERSION_CHANGED and the client re-opens the detail view to
-- re-evaluate. This avoids duplicating the eligibility engine in
-- PL/pgSQL while still matching the §5.5 "re-run eligibility against the
-- NOW-current version_id" invariant via the version-id pin.
--
-- This invariant depends on `app_private.bump_listing_version` producing a
-- new `current_version_id` for every mutation that can change eligibility
-- (listing_conditions, body fields the trigger watches). If a future
-- trigger change lets an eligibility-affecting edit land without bumping
-- `current_version_id`, this RPC would silently commit against stale TS-
-- evaluated eligibility — keep the trigger and the condition-set coupled.
--
-- Auth: revoked from anon/authenticated/public. Only service_role (used
-- by the edge function) may execute.

create or replace function public.apply_to_listing_rpc(
  p_listing_id uuid,
  p_creator_id uuid,
  p_expected_version_id uuid,
  p_cover_note text default null
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_status public.listing_status;
  v_current_version_id uuid;
  v_application_id uuid;
begin
  select l.status, l.current_version_id
    into v_status, v_current_version_id
    from public.listings l
   where l.id = p_listing_id
     for update;

  if not found then
    return jsonb_build_object('error', 'LISTING_NOT_FOUND');
  end if;

  if v_status <> 'active'::public.listing_status then
    return jsonb_build_object('error', 'LISTING_NOT_ACTIVE');
  end if;

  if v_current_version_id is null then
    -- Data-integrity guard: an active listing without a current_version_id
    -- is a persistence bug; re-raise so the edge function surfaces as 500.
    raise exception 'listing % has no current_version_id', p_listing_id;
  end if;

  if v_current_version_id <> p_expected_version_id then
    return jsonb_build_object(
      'error', 'LISTING_VERSION_CHANGED',
      'current_version_id', v_current_version_id
    );
  end if;

  -- Active-application gate mirrors the partial unique index on
  -- (listing_id, creator_id) WHERE status IN ('pending','approved'). An
  -- explicit pre-check under the row lock yields a clean 409 rather than
  -- requiring unique_violation diagnostics; the partial index remains
  -- the DB-level guarantee.
  if exists (
    select 1
      from public.applications a
     where a.listing_id = p_listing_id
       and a.creator_id = p_creator_id
       and a.status in (
         'pending'::public.application_status,
         'approved'::public.application_status
       )
  ) then
    return jsonb_build_object('error', 'ALREADY_APPLIED');
  end if;

  insert into public.applications (
    listing_id, listing_version_id, creator_id, status, cover_note
  ) values (
    p_listing_id, v_current_version_id, p_creator_id,
    'pending'::public.application_status, p_cover_note
  )
  returning id into v_application_id;

  return jsonb_build_object(
    'application_id', v_application_id,
    'listing_version_id', v_current_version_id
  );
end;
$$;

revoke all on function public.apply_to_listing_rpc(uuid, uuid, uuid, text) from public;
revoke all on function public.apply_to_listing_rpc(uuid, uuid, uuid, text) from anon, authenticated;
grant execute on function public.apply_to_listing_rpc(uuid, uuid, uuid, text) to service_role;

comment on function public.apply_to_listing_rpc(uuid, uuid, uuid, text) is
  'US-041 apply-to-listing RPC. Called only by the apply-to-listing edge function via service_role. Acquires FOR UPDATE on the listing row to serialise against version bumps; returns jsonb {application_id, listing_version_id} or {error}.';

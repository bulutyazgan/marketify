-- US-057 — RPC backing the decide-application edge function (lister-side
-- approve/reject for a pending application).
--
-- Contract: public.decide_application_rpc(
--   p_application_id      uuid,
--   p_lister_id           uuid,
--   p_action              text,             -- 'approve' | 'reject'
--   p_decision_note       text default null,
--   p_expected_version_id uuid default null -- non-null only on the
--                                           -- non-override approve path
-- ) returns jsonb.
--
-- On success: {"ok": true, "status": "approved"|"rejected",
--              "decided_at": "<timestamptz>"}.
-- On conflict: {"error": "APPLICATION_NOT_FOUND" | "NOT_OWNER" |
--                "NOT_PENDING" | "INVALID_ACTION" |
--                "LISTING_VERSION_CHANGED" (+ "current_version_id")}.
--
-- Concurrency: acquires a row lock via SELECT ... FOR UPDATE on the
-- application, which serialises this flow against the partial unique index
-- (`applications_open_uniq`) and the cascade trigger
-- (`app_private.bump_listing_version`). Without the lock, two listers
-- racing could both flip a pending app and one write would silently lose;
-- with the lock the second caller observes the new status and returns
-- NOT_PENDING.
--
-- Eligibility — NOT re-evaluated inside the RPC. The edge function runs
-- the pre-condition evaluator in TS against the listing's current
-- `current_version_id`, then passes the version it evaluated as
-- `p_expected_version_id`. If the listing's current_version_id changed in
-- between (a fresh `app_private.bump_listing_version` interleaved), the
-- RPC returns LISTING_VERSION_CHANGED and the edge function tells the
-- client to re-open the review sheet. Same version-pin pattern as
-- US-041's `apply_to_listing_rpc` (Codebase Pattern #105).
--
-- Override path: when the lister explicitly chooses to approve a now-
-- ineligible creator (the §4.6 OverrideEligibilityDialog flow), the edge
-- function passes p_expected_version_id = NULL because no eligibility
-- check ran — the lister has accepted the drift. The RPC therefore skips
-- the version match step on NULL. This is intentional: override is a
-- force-approve, and a freshly bumped version doesn't change the lister's
-- decision (they are explicitly accepting non-conformance).
--
-- Auth: revoked from anon/authenticated/public. Only service_role (used
-- by the edge function) may execute. Trust the edge function's JWT-derived
-- lister_id rather than `current_user_id()` because the RPC runs under
-- service_role (BYPASSRLS) — current_user_id() would return null.

create or replace function public.decide_application_rpc(
  p_application_id      uuid,
  p_lister_id           uuid,
  p_action              text,
  p_decision_note       text default null,
  p_expected_version_id uuid default null
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_status                 public.application_status;
  v_listing_id             uuid;
  v_listing_lister_id      uuid;
  v_listing_current_ver_id uuid;
  v_target_status          public.application_status;
  v_decided_at             timestamptz;
begin
  if p_action not in ('approve', 'reject') then
    return jsonb_build_object('error', 'INVALID_ACTION');
  end if;

  -- Lock the application row, then resolve the joined listing in the same
  -- statement. Locking the application (not the listing) is sufficient
  -- here because (a) listing.lister_id never changes and (b) listing
  -- version bumps update listings.current_version_id which we re-read
  -- below — the application row is the contention point.
  select a.status, a.listing_id
    into v_status, v_listing_id
    from public.applications a
   where a.id = p_application_id
     for update;

  if not found then
    return jsonb_build_object('error', 'APPLICATION_NOT_FOUND');
  end if;

  select l.lister_id, l.current_version_id
    into v_listing_lister_id, v_listing_current_ver_id
    from public.listings l
   where l.id = v_listing_id;

  if v_listing_lister_id is null then
    -- Should be unreachable — listing FK is on delete restrict — but
    -- treat a missing listing as not-owner to fail closed.
    return jsonb_build_object('error', 'NOT_OWNER');
  end if;

  if v_listing_lister_id <> p_lister_id then
    return jsonb_build_object('error', 'NOT_OWNER');
  end if;

  if v_status <> 'pending'::public.application_status then
    return jsonb_build_object('error', 'NOT_PENDING');
  end if;

  -- Version pin (non-override approve path). When the edge function ran
  -- the eligibility check, it pins the version it evaluated against. A
  -- fresh bump that changed `current_version_id` invalidates that check
  -- and we force the client back to the review sheet.
  if p_action = 'approve'
     and p_expected_version_id is not null
     and v_listing_current_ver_id <> p_expected_version_id then
    return jsonb_build_object(
      'error', 'LISTING_VERSION_CHANGED',
      'current_version_id', v_listing_current_ver_id
    );
  end if;

  v_target_status := case p_action
    when 'approve' then 'approved'::public.application_status
    when 'reject'  then 'rejected'::public.application_status
  end;

  v_decided_at := pg_catalog.now();

  update public.applications
     set status        = v_target_status,
         decided_at    = v_decided_at,
         decision_note = p_decision_note,
         updated_at    = v_decided_at
   where id = p_application_id;

  return jsonb_build_object(
    'ok',         true,
    'status',     v_target_status::text,
    'decided_at', v_decided_at
  );
end;
$$;

revoke all on function public.decide_application_rpc(uuid, uuid, text, text, uuid) from public;
revoke all on function public.decide_application_rpc(uuid, uuid, text, text, uuid) from anon, authenticated;
grant execute on function public.decide_application_rpc(uuid, uuid, text, text, uuid) to service_role;

comment on function public.decide_application_rpc(uuid, uuid, text, text, uuid) is
  'US-057 decide-application RPC. Called only by the decide-application edge function via service_role. Acquires FOR UPDATE on the application row, verifies lister ownership + pending status + (non-override) version pin, then flips status to approved/rejected. Returns jsonb {ok, status, decided_at} or {error}.';

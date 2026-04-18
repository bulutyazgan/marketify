-- US-059 — RPC backing the decide-submission edge function (lister-side
-- approve/reject for a pending submission) plus notification fan-out to
-- the creator.
--
-- Contract: public.decide_submission_rpc(
--   p_submission_id uuid,
--   p_lister_id     uuid,
--   p_action        text,            -- 'approve' | 'reject'
--   p_decision_note text default null,
--   p_override      boolean default false,
--   p_override_reason text default null
-- ) returns jsonb.
--
-- On success: {"ok": true, "status": "approved"|"rejected",
--              "decided_at": "<timestamptz>"}.
-- On conflict: {"error": "SUBMISSION_NOT_FOUND" | "NOT_OWNER" |
--                "NOT_PENDING" | "INVALID_ACTION" | "OVERRIDE_REASON_REQUIRED"}.
--
-- Concurrency: SELECT ... FOR UPDATE on the submission row. There's no
-- listing version pin on submissions (unlike applications, submissions do
-- not have a `listing_version_id` column) — the listing version that the
-- submission references is captured upstream on the parent application
-- (`applications.listing_version_id`), and the submission detail screen
-- reads post-conditions from THAT version. A bump that races a decide
-- doesn't invalidate the lister's review here because the post-conditions
-- shown in the UI are version-pinned via the application, not the
-- submission. (Spec gap: §4.7 doesn't carry a version pin on submissions
-- because submissions inherit the version from their parent application.)
--
-- Override audit: when the lister explicitly approves a submission with
-- failed post-conditions (the §4.6 OverrideEligibilityDialog flow), the
-- edge function passes p_override=true + p_override_reason=<typed text>.
-- These persist to submissions.override_by_user_id +
-- submissions.override_reason for the audit trail. The CHECK constraint
-- `submissions_override_requires_approved` ensures override fields are
-- only populated on approved rows. Override only applies to approve;
-- reject ignores both flags.
--
-- Notifications fan-out: on a successful flip, INSERT one row into
-- public.notifications targeting the creator (resolved via
-- applications.creator_id). kind = 'submission_approved' or
-- 'submission_rejected'. Payload includes submission_id, application_id,
-- listing_id, listing_title (resolved from the listing's
-- current_version_id title), and decision_note. The insert is part of the
-- same transaction as the submissions UPDATE — either both commit or
-- neither does, so a creator never observes "approved without
-- notification" or vice versa.
--
-- Auth: revoked from anon/authenticated/public. Only service_role
-- (used by the edge function) may execute. Trust the edge function's
-- JWT-derived lister_id rather than `current_user_id()` because the RPC
-- runs under service_role (BYPASSRLS).

create or replace function public.decide_submission_rpc(
  p_submission_id   uuid,
  p_lister_id       uuid,
  p_action          text,
  p_decision_note   text default null,
  p_override        boolean default false,
  p_override_reason text default null
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_status            public.submission_status;
  v_application_id    uuid;
  v_listing_id        uuid;
  v_listing_lister_id uuid;
  v_listing_version   uuid;
  v_listing_title     text;
  v_creator_id        uuid;
  v_target_status     public.submission_status;
  v_decided_at        timestamptz;
  v_notification_kind public.notification_kind;
  v_effective_override boolean;
  v_effective_reason   text;
begin
  if p_action not in ('approve', 'reject') then
    return jsonb_build_object('error', 'INVALID_ACTION');
  end if;

  -- Override is meaningless on a reject; collapse to false so the
  -- audit-fields branch below cannot misfire on a rejected row.
  v_effective_override := p_action = 'approve' and p_override = true;
  v_effective_reason   := case
    when v_effective_override then nullif(btrim(p_override_reason), '')
    else null
  end;

  -- Audit-trail invariant: if the lister explicitly chose override, they
  -- must supply a reason. Mirror the design.md §4.6 typed-OVERRIDE input.
  if v_effective_override and v_effective_reason is null then
    return jsonb_build_object('error', 'OVERRIDE_REASON_REQUIRED');
  end if;

  -- Lock the submission row first.
  select s.status, s.application_id
    into v_status, v_application_id
    from public.submissions s
   where s.id = p_submission_id
     for update;

  if not found then
    return jsonb_build_object('error', 'SUBMISSION_NOT_FOUND');
  end if;

  -- Resolve listing + creator + ownership.
  select a.creator_id, l.id, l.lister_id, l.current_version_id
    into v_creator_id, v_listing_id, v_listing_lister_id, v_listing_version
    from public.applications a
    join public.listings l on l.id = a.listing_id
   where a.id = v_application_id;

  if v_listing_lister_id is null then
    -- Should be unreachable — both FKs are on delete restrict — but
    -- treat a missing parent as not-owner to fail closed.
    return jsonb_build_object('error', 'NOT_OWNER');
  end if;

  if v_listing_lister_id <> p_lister_id then
    return jsonb_build_object('error', 'NOT_OWNER');
  end if;

  if v_status <> 'pending'::public.submission_status then
    return jsonb_build_object('error', 'NOT_PENDING');
  end if;

  v_target_status := case p_action
    when 'approve' then 'approved'::public.submission_status
    when 'reject'  then 'rejected'::public.submission_status
  end;

  v_notification_kind := case p_action
    when 'approve' then 'submission_approved'::public.notification_kind
    when 'reject'  then 'submission_rejected'::public.notification_kind
  end;

  v_decided_at := pg_catalog.now();

  -- Resolve listing title from `public.listings.title` (CURRENT title).
  -- `listing_versions` has no title column — snapshots store prior values
  -- in `snapshot` jsonb. Used only in the notification payload for
  -- display; not for review semantics.
  select l.title
    into v_listing_title
    from public.listings l
   where l.id = v_listing_id;

  update public.submissions
     set status              = v_target_status,
         decided_at          = v_decided_at,
         decision_note       = p_decision_note,
         override_by_user_id = case when v_effective_override then p_lister_id else null end,
         override_reason     = v_effective_reason,
         updated_at          = v_decided_at
   where id = p_submission_id;

  insert into public.notifications (user_id, kind, payload)
  values (
    v_creator_id,
    v_notification_kind,
    jsonb_build_object(
      'submission_id',  p_submission_id,
      'application_id', v_application_id,
      'listing_id',     v_listing_id,
      'listing_title',  v_listing_title,
      'decision_note',  p_decision_note
    )
  );

  return jsonb_build_object(
    'ok',         true,
    'status',     v_target_status::text,
    'decided_at', v_decided_at
  );
end;
$$;

revoke all on function public.decide_submission_rpc(uuid, uuid, text, text, boolean, text) from public;
revoke all on function public.decide_submission_rpc(uuid, uuid, text, text, boolean, text) from anon, authenticated;
grant execute on function public.decide_submission_rpc(uuid, uuid, text, text, boolean, text) to service_role;

comment on function public.decide_submission_rpc(uuid, uuid, text, text, boolean, text) is
  'US-059 decide-submission RPC. Called only by the decide-submission edge function via service_role. Acquires FOR UPDATE on the submission row, verifies lister ownership + pending status, transitions status, persists override audit fields when applicable, and inserts a notification for the creator. Returns jsonb {ok, status, decided_at} or {error}.';

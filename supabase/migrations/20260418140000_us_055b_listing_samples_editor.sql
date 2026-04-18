-- US-055b — RPC backing the update-listing-samples edge function.
--
-- Contract: public.update_listing_samples_rpc(
--   p_lister_id           uuid,
--   p_listing_id          uuid,
--   p_samples             jsonb,        -- [{platform, url}, ...] in the desired order
--   p_confirm_cascade     boolean       -- when false, refuse to commit if pending apps > 0
-- ) returns jsonb
--
-- Returns:
--   {"changed": false}                                                    -- no diff vs current_version_id's samples
--   {"changed": true, "needs_confirmation": true, "pending_count": N}     -- pending > 0 and !confirm
--   {"changed": true, "new_version_id": <uuid>, "cancelled_pending_count": N}
--
-- Errors:
--   raise 'NOT_FOUND'      — listing missing
--   raise 'FORBIDDEN'      — caller is not the listing's owner
--   raise 'INVALID_STATUS' — listing.status not in ('active','paused','closed') (no editing of draft/archived)
--
-- Flow:
--   1. SELECT FOR UPDATE the listing → ownership + status gate.
--   2. Compare incoming sample (platform,url) sequence to existing rows on
--      listings.current_version_id (order matters via sort_order; mirrors how
--      the wizard preserves the user's authored order — same set in a
--      different order should still create a new version because the lister
--      explicitly reordered them).
--   3. If unchanged → return {changed:false}.
--   4. If changed:
--      a. count pending applications;
--      b. if pending > 0 and not p_confirm_cascade → return needs_confirmation;
--      c. else call app_private.request_listing_version_bump(listing_id, 'sample_videos')
--         which fires the BEFORE UPDATE trigger that creates a new
--         listing_versions row, swaps current_version_id, and cascade-cancels
--         pending applications (with notifications). For non-active listings
--         the trigger short-circuits the version bump but the UPDATE still
--         commits — we then explicitly insert a fresh listing_versions row
--         so the new sample_videos can FK against it.
--      d. INSERT the new sample_videos against the new current_version_id
--         (re-read after the trigger ran).
--      e. Re-count pending apps post-bump (now zero on active listings) so
--         the response carries the cancelled_pending_count for the toast.
--
-- Auth: revoked from anon/authenticated/public. Only service_role (used by
-- the update-listing-samples edge function) may execute. The lister-id
-- ownership check is enforced inside the function so a service_role caller
-- still cannot edit someone else's listing.

create or replace function public.update_listing_samples_rpc(
  p_lister_id       uuid,
  p_listing_id      uuid,
  p_samples         jsonb,
  p_confirm_cascade boolean
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_owner               uuid;
  v_status              public.listing_status;
  v_current_version_id  uuid;
  v_existing            jsonb;
  v_incoming            jsonb;
  v_pending_count       integer;
  v_new_version_id      uuid;
  v_sample              jsonb;
  v_sort                smallint := 0;
begin
  -- 1. Lock the listing row + verify ownership + status gate.
  select lister_id, status, current_version_id
    into v_owner, v_status, v_current_version_id
    from public.listings
   where id = p_listing_id
   for update;

  if not found then
    raise exception 'NOT_FOUND';
  end if;
  if v_owner is distinct from p_lister_id then
    raise exception 'FORBIDDEN';
  end if;
  -- Editing is only meaningful on active/paused/closed. Draft listings have
  -- no published version yet (handled by create-listing); archived is
  -- terminal.
  if v_status not in (
    'active'::public.listing_status,
    'paused'::public.listing_status,
    'closed'::public.listing_status
  ) then
    raise exception 'INVALID_STATUS';
  end if;

  -- 2. Build comparable jsonb arrays for the existing + incoming sets, both
  -- ordered by their authored position. Compared via jsonb equality so order
  -- AND content both matter (lister-visible order is meaningful).
  select coalesce(jsonb_agg(jsonb_build_object(
           'platform', sv.platform,
           'url',      sv.url
         ) order by sv.sort_order, sv.id), '[]'::jsonb)
    into v_existing
    from public.sample_videos sv
   where sv.listing_version_id = v_current_version_id;

  -- Strip down the incoming payload to (platform, url) pairs in the exact
  -- order they were submitted; the edge function has already classified +
  -- normalized so platform is canonical. The `order by ord` inside jsonb_agg
  -- preserves the input array order through the aggregation.
  select coalesce(jsonb_agg(
           jsonb_build_object(
             'platform', t.row_data ->> 'platform',
             'url',      t.row_data ->> 'url'
           )
           order by t.ord
         ), '[]'::jsonb)
    into v_incoming
    from jsonb_array_elements(p_samples) with ordinality as t(row_data, ord);

  if v_existing = v_incoming then
    return jsonb_build_object('changed', false);
  end if;

  -- 3. Count pending applications BEFORE the cascade so we can return the
  -- needs_confirmation envelope or report cancelled_pending_count after.
  select count(*)::integer
    into v_pending_count
    from public.applications
   where listing_id = p_listing_id
     and status     = 'pending'::public.application_status;

  if v_pending_count > 0 and not p_confirm_cascade then
    return jsonb_build_object(
      'changed',            true,
      'needs_confirmation', true,
      'pending_count',      v_pending_count
    );
  end if;

  -- 4. Fire the version bump. On active listings this trigger creates a new
  -- listing_versions row, swaps current_version_id, and cascade-cancels the
  -- pending applications. On paused/closed listings the trigger guards on
  -- status='active' and skips the bump — we then create the new version row
  -- explicitly below so the new sample_videos still have a parent to FK to.
  perform app_private.request_listing_version_bump(p_listing_id, 'sample_videos');

  -- Re-read the (possibly updated) current_version_id.
  select current_version_id
    into v_current_version_id
    from public.listings
   where id = p_listing_id;

  -- For non-active listings the trigger short-circuits, so create a manual
  -- version row matching the listing's scalars.
  if v_status <> 'active'::public.listing_status then
    insert into public.listing_versions (
      listing_id, version_number, price_cents, currency, max_submissions,
      snapshot, previous_version_id, changed_fields
    )
    select p_listing_id,
           coalesce(
             (select max(version_number) from public.listing_versions where listing_id = p_listing_id),
             0
           ) + 1,
           l.price_cents, l.currency, l.max_submissions,
           to_jsonb(l.*), v_current_version_id, array['sample_videos']::text[]
      from public.listings l
     where l.id = p_listing_id
    returning id into v_new_version_id;

    update public.listings
       set current_version_id = v_new_version_id,
           version_number     = (select version_number from public.listing_versions where id = v_new_version_id),
           updated_at         = now()
     where id = p_listing_id;

    v_current_version_id := v_new_version_id;
  end if;

  -- 5. Insert the new sample_videos against the (now-current) version.
  v_sort := 0;
  for v_sample in select * from jsonb_array_elements(p_samples)
  loop
    insert into public.sample_videos (
      listing_version_id, platform, url, sort_order
    ) values (
      v_current_version_id,
      (v_sample ->> 'platform')::public.platform,
      v_sample ->> 'url',
      v_sort
    );
    v_sort := v_sort + 1;
  end loop;

  return jsonb_build_object(
    'changed',                  true,
    'new_version_id',           v_current_version_id,
    'cancelled_pending_count',  v_pending_count
  );
end;
$$;

revoke all on function public.update_listing_samples_rpc(uuid, uuid, jsonb, boolean) from public;
revoke all on function public.update_listing_samples_rpc(uuid, uuid, jsonb, boolean) from anon, authenticated;
grant execute on function public.update_listing_samples_rpc(uuid, uuid, jsonb, boolean) to service_role;

comment on function public.update_listing_samples_rpc(uuid, uuid, jsonb, boolean) is
  'US-055b update-listing-samples RPC. Diffs incoming sample URLs against current_version sample_videos, fires app_private.request_listing_version_bump when changed, inserts new sample rows against the resulting version. Cascade-cancels pending applications on active listings (via the bump trigger). Called only by the update-listing-samples edge function via service_role.';

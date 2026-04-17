-- US-043 — seed four applications for the seed creator so each segment
-- of the My Applications tab (Pending / Approved / Rejected / Cancelled)
-- renders with at least one row during mobile-mcp verification.
--
-- Partial unique `applications_open_uniq` is (listing_id, creator_id)
-- WHERE status IN ('pending','approved') so the four rows below do not
-- collide: one pending + one rejected against Acme, one approved + one
-- cancelled_listing_edit against Luxe. Rejected/cancelled are outside
-- the partial index and can coexist with pending/approved on the same
-- listing.
--
-- Idempotent via `on conflict (id) do nothing` — the deterministic UUIDs
-- below make a re-applied migration a no-op.

do $$
declare
  v_creator_id       uuid := '11111111-1111-1111-1111-111111111002';  -- seed creator
  v_acme_listing_id  uuid := '11111111-1111-1111-1111-111111111010';  -- Promote Acme Headphones
  v_acme_version_id  uuid := '11111111-1111-1111-1111-111111111011';
  v_luxe_listing_id  uuid := '22222222-2222-2222-2222-222222222010';  -- Mega-Influencer Luxe Launch
  v_luxe_version_id  uuid := '22222222-2222-2222-2222-222222222011';

  v_app_pending_id   uuid := '33333333-3333-3333-3333-333333330001';
  v_app_approved_id  uuid := '33333333-3333-3333-3333-333333330002';
  v_app_rejected_id  uuid := '33333333-3333-3333-3333-333333330003';
  v_app_cancelled_id uuid := '33333333-3333-3333-3333-333333330004';
begin
  insert into public.applications (
    id, listing_id, listing_version_id, creator_id,
    status, cover_note, created_at, updated_at, decided_at, decision_note
  ) values
    (
      v_app_pending_id, v_acme_listing_id, v_acme_version_id, v_creator_id,
      'pending', 'Excited to try these headphones in my next travel vlog.',
      now() - interval '3 hours', now() - interval '3 hours', null, null
    ),
    (
      v_app_approved_id, v_luxe_listing_id, v_luxe_version_id, v_creator_id,
      'approved', null,
      now() - interval '2 days', now() - interval '1 day',
      now() - interval '1 day', 'Love your audience fit — green-lit.'
    ),
    (
      v_app_rejected_id, v_acme_listing_id, v_acme_version_id, v_creator_id,
      'rejected', null,
      now() - interval '5 days', now() - interval '4 days',
      now() - interval '4 days', 'Already have a similar creator on this drop.'
    ),
    (
      v_app_cancelled_id, v_luxe_listing_id, v_luxe_version_id, v_creator_id,
      'cancelled_listing_edit', null,
      now() - interval '7 days', now() - interval '6 days',
      now() - interval '6 days', null
    )
  on conflict (id) do nothing;
end $$;

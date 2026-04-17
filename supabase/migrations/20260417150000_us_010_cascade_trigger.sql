-- US-010: listing-version cascade trigger
-- Implements §15 `bump_listing_version` + `request_listing_version_bump` per
-- docs/tech-architecture.md lines 1103-1203.
--
-- BEFORE UPDATE on public.listings:
--   * Detects scalar edits (price_cents, currency, max_submissions) via old/new diff.
--   * Detects conditions / sample_videos edits via the ephemeral `version_bump_reason`
--     column, set-and-reset by app_private.request_listing_version_bump before the edge
--     function commits. The trigger consumes the cue so it never persists to disk.
--   * When any versioned field changed AND new.status = 'active':
--       - Bumps `new.version_number`.
--       - Inserts a public.listing_versions row (snapshot = to_jsonb(new)).
--       - Swaps `new.current_version_id` to the new version's id.
--       - Cascade-cancels every pending application on this listing →
--         status = 'cancelled_listing_edit'.
--       - Emits a public.notifications row per affected creator
--         (kind = 'listing_version_changed').
--   * Title, description, category, and status-only edits DO NOT cascade.
--
-- Both functions follow the repo hardening pattern:
--   `security definer` + `set search_path = ''` + schema-qualified refs to every
--   user-defined table / type. `pg_catalog` functions (now(), array_length,
--   to_jsonb, jsonb_build_object, coalesce) are bare — implicit. Enum literals are
--   cast explicitly (`'active'::public.listing_status`) so coercion does not
--   depend on the caller-side search_path.
--
-- Spec gap: §15b threshold-maintenance triggers (`refresh_listing_thresholds`,
-- `refresh_thresholds_on_version_bump`) are intentionally NOT included in this
-- migration. Story AC is scoped to the cascade trigger only; the threshold
-- triggers will be needed before US-038 (discover feed eligibility filter) and
-- US-049-055 (create/edit campaign wizard), and should land in whichever of
-- those stories first needs the listings.min_followers_* cache to populate.

create or replace function app_private.bump_listing_version()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  versioned_changed boolean;
  new_version_id    uuid;
  prev_version_id   uuid;
  changed_fields    text[] := array[]::text[];
begin
  if old.price_cents is distinct from new.price_cents then
    changed_fields := changed_fields || 'price_cents';
  end if;
  if old.currency is distinct from new.currency then
    changed_fields := changed_fields || 'currency';
  end if;
  if old.max_submissions is distinct from new.max_submissions then
    changed_fields := changed_fields || 'max_submissions';
  end if;

  -- Ephemeral cue set by request_listing_version_bump when listing_conditions
  -- or sample_videos have been edited. Consume it so it never persists.
  if new.version_bump_reason is not null then
    changed_fields := changed_fields || new.version_bump_reason;
    new.version_bump_reason := null;
  end if;

  -- array_length of an empty array is NULL, so wrap in coalesce.
  versioned_changed := coalesce(array_length(changed_fields, 1), 0) > 0;

  if versioned_changed and new.status = 'active'::public.listing_status then
    prev_version_id    := old.current_version_id;
    new.version_number := old.version_number + 1;

    insert into public.listing_versions (
      listing_id, version_number, price_cents, currency, max_submissions,
      snapshot, previous_version_id, changed_fields
    )
    values (
      new.id, new.version_number, new.price_cents, new.currency, new.max_submissions,
      to_jsonb(new), prev_version_id, changed_fields
    )
    returning id into new_version_id;

    new.current_version_id := new_version_id;

    -- Cascade pending applications + emit notifications in one statement so we
    -- notify exactly the creators whose applications were cancelled.
    with cascaded as (
      update public.applications
         set status     = 'cancelled_listing_edit'::public.application_status,
             updated_at = now()
       where listing_id = new.id
         and status     = 'pending'::public.application_status
      returning creator_id
    )
    insert into public.notifications (user_id, kind, payload)
    select c.creator_id,
           'listing_version_changed'::public.notification_kind,
           jsonb_build_object(
             'listing_id',          new.id,
             'new_version',         new.version_number,
             'previous_version_id', prev_version_id,
             'new_version_id',      new_version_id,
             'changed_fields',      to_jsonb(changed_fields)
           )
      from cascaded c;
  end if;

  return new;
end;
$$;

create trigger trg_bump_listing_version
  before update on public.listings
  for each row execute function app_private.bump_listing_version();

-- Helper the edge function calls AFTER committing listing_conditions /
-- sample_videos edits. Produces an UPDATE that fires trg_bump_listing_version
-- with the appropriate cue. Invalid reasons raise so callers can never smuggle
-- arbitrary strings into changed_fields.
create or replace function app_private.request_listing_version_bump(
  p_listing_id uuid,
  p_reason     text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_ver uuid;
begin
  if p_reason not in ('conditions', 'sample_videos') then
    raise exception 'invalid version bump reason: %', p_reason;
  end if;

  update public.listings
     set version_bump_reason = p_reason,
         updated_at          = now()
   where id = p_listing_id
  returning current_version_id into new_ver;

  return new_ver;
end;
$$;

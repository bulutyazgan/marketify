-- US-010 fix: bump_listing_version crashed at runtime with
--   "ERROR 22P02: malformed array literal: 'price_cents'"
-- because `text[] || 'literal'` inside a function with `set search_path = ''`
-- resolves to the `anyarray || anyarray` operator (Postgres picks it for
-- unknown-type literals) and tries to coerce the string into a text[].
-- Fix: cast every literal to ::text so operator resolution picks anyarray||anyelement.
-- Same issue also applies to `changed_fields || new.version_bump_reason` since
-- new.version_bump_reason is typed `text`, BUT the ambiguity only arises with
-- literals — so the cue-path append is safe. We still rewrite both branches for
-- consistency.

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
    changed_fields := changed_fields || 'price_cents'::text;
  end if;
  if old.currency is distinct from new.currency then
    changed_fields := changed_fields || 'currency'::text;
  end if;
  if old.max_submissions is distinct from new.max_submissions then
    changed_fields := changed_fields || 'max_submissions'::text;
  end if;

  if new.version_bump_reason is not null then
    changed_fields := changed_fields || new.version_bump_reason;
    new.version_bump_reason := null;
  end if;

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

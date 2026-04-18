-- US-053 — RPC backing the create-listing edge function.
--
-- Contract: public.create_listing_rpc(
--   p_lister_id uuid,
--   p_payload  jsonb
-- ) returns jsonb.
--
-- Payload shape (validated at the edge):
--   {
--     title:            text,
--     description:      text,
--     price_cents:      int,
--     currency:         text,
--     max_submissions:  int | null,
--     pre_conditions:   [{ platform, metric, threshold }],  -- platform ∈ tiktok|instagram,
--                                                          -- metric ∈ followers|avg_views
--     post_conditions:  [{ id (uuid), text }],              -- id minted by wizard
--     sample_videos:    [{ platform, url }]
--   }
--
-- On success: {"listing_id": "<uuid>", "version_id": "<uuid>"}.
--
-- Transaction flow:
--   1. INSERT listings (status='active', published_at=now(), min_followers_*
--      cache columns populated from the payload's pre_conditions — spec §15b
--      triggers are still scoped out per progress.txt Codebase Pattern #52, so
--      every caller that writes listings has to populate the cache inline).
--   2. INSERT listing_versions (version_number=1, snapshot=to_jsonb(inserted
--      listing row with current_version_id=null at this point)).
--   3. INSERT listing_conditions rows (both kinds; post-conditions reuse the
--      wizard-minted uuid so the submit-video affirmation map keys survive
--      round-trip per docs/tech-architecture.md §5.6).
--   4. INSERT sample_videos rows.
--   5. UPDATE listings.current_version_id = new_version_id.
--      Trigger trg_bump_listing_version fires on this UPDATE but versioned_
--      changed is false (price/currency/max/version_bump_reason all unchanged),
--      so it passes through without creating a duplicate version row.
--
-- Post-condition metric mapping:
--   The wizard captures free-text post-conditions; condition_metric enum has no
--   generic "free-text rule" value. We store every post-condition as
--   metric='post_must_mention' + operator='contains' + text_threshold=<text>.
--   The submit-video edge function only keys off condition row.id when mapping
--   affirmations (supabase/functions/submit-video/index.ts:209-211) so the
--   specific metric value does not affect runtime semantics; it just ensures
--   the row satisfies the enum CHECK. The UI reads text_threshold for display.
--
-- Spec gap: the condition_metric enum lacks a generic free-text post-condition
-- value (see progress.txt). Documented here + in the edge function header.
--
-- Auth: revoked from anon/authenticated/public. Only service_role (used by the
-- create-listing edge function) may execute.

create or replace function public.create_listing_rpc(
  p_lister_id uuid,
  p_payload   jsonb
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_listing_id         uuid;
  v_version_id         uuid;
  v_min_tt             integer;
  v_min_ig             integer;
  v_pre_rows           jsonb;
  v_post_rows          jsonb;
  v_sample_rows        jsonb;
  v_pre                jsonb;
  v_post               jsonb;
  v_sample             jsonb;
  v_metric             public.condition_metric;
  v_platform           public.platform;
  v_sort               smallint := 0;
  v_price_cents        integer;
  v_currency           text;
  v_max_submissions    integer;
  v_title              text;
  v_description        text;
begin
  -- Hoist payload scalars; the edge function has already shape-validated, but
  -- defensive casts keep this RPC safe if a future caller forgets.
  v_title           := p_payload ->> 'title';
  v_description     := p_payload ->> 'description';
  v_price_cents     := (p_payload ->> 'price_cents')::integer;
  v_currency        := p_payload ->> 'currency';
  v_max_submissions := nullif(p_payload ->> 'max_submissions', '')::integer;
  v_pre_rows        := coalesce(p_payload -> 'pre_conditions',  '[]'::jsonb);
  v_post_rows       := coalesce(p_payload -> 'post_conditions', '[]'::jsonb);
  v_sample_rows     := coalesce(p_payload -> 'sample_videos',   '[]'::jsonb);

  -- Compute cache columns from the payload so the discover feed's threshold
  -- filter (us_038) sees correct values on first publish without depending on
  -- §15b triggers that are still out-of-scope.
  select max((row_data ->> 'threshold')::integer)
    into v_min_tt
    from jsonb_array_elements(v_pre_rows) as row_data
   where row_data ->> 'platform' = 'tiktok'
     and row_data ->> 'metric'   = 'followers';

  select max((row_data ->> 'threshold')::integer)
    into v_min_ig
    from jsonb_array_elements(v_pre_rows) as row_data
   where row_data ->> 'platform' = 'instagram'
     and row_data ->> 'metric'   = 'followers';

  insert into public.listings (
    lister_id, status, title, description, price_cents, currency,
    max_submissions, min_followers_tiktok, min_followers_instagram,
    published_at
  ) values (
    p_lister_id,
    'active'::public.listing_status,
    v_title, v_description, v_price_cents, v_currency,
    v_max_submissions, v_min_tt, v_min_ig,
    now()
  )
  returning id into v_listing_id;

  insert into public.listing_versions (
    listing_id, version_number, price_cents, currency, max_submissions,
    snapshot, previous_version_id, changed_fields
  )
  select v_listing_id, 1, v_price_cents, v_currency, v_max_submissions,
         to_jsonb(l.*), null, array[]::text[]
    from public.listings l
   where l.id = v_listing_id
  returning id into v_version_id;

  -- Pre-conditions: map wizard shape → listing_conditions rows.
  for v_pre in select * from jsonb_array_elements(v_pre_rows)
  loop
    v_platform := (v_pre ->> 'platform')::public.platform;
    v_metric := case v_pre ->> 'metric'
                  when 'followers' then 'min_followers'::public.condition_metric
                  when 'avg_views' then 'min_avg_views_last_n'::public.condition_metric
                  else null
                end;
    if v_metric is null then
      raise exception 'invalid pre-condition metric: %', v_pre ->> 'metric';
    end if;

    insert into public.listing_conditions (
      listing_version_id, kind, metric, platform, operator, numeric_threshold
    ) values (
      v_version_id,
      'pre'::public.condition_kind,
      v_metric,
      v_platform,
      'gte',
      (v_pre ->> 'threshold')::numeric
    );
  end loop;

  -- Post-conditions: reuse the wizard-minted uuid so the per-rule affirmation
  -- keys in submit-video remain stable across wizard → publish → submit.
  for v_post in select * from jsonb_array_elements(v_post_rows)
  loop
    insert into public.listing_conditions (
      id, listing_version_id, kind, metric, operator, text_threshold
    ) values (
      (v_post ->> 'id')::uuid,
      v_version_id,
      'post'::public.condition_kind,
      'post_must_mention'::public.condition_metric,
      'contains',
      v_post ->> 'text'
    );
  end loop;

  -- Sample videos: platform is classified by the edge function via
  -- classifyVideoUrl; the payload guarantees platform + url are both present.
  v_sort := 0;
  for v_sample in select * from jsonb_array_elements(v_sample_rows)
  loop
    insert into public.sample_videos (
      listing_version_id, platform, url, sort_order
    ) values (
      v_version_id,
      (v_sample ->> 'platform')::public.platform,
      v_sample ->> 'url',
      v_sort
    );
    v_sort := v_sort + 1;
  end loop;

  -- Close the circular FK. The trg_bump_listing_version trigger fires BEFORE
  -- UPDATE but versioned_changed is false here (no price/currency/max/cue
  -- change), so it passes through without inserting another listing_versions
  -- row. updated_at is refreshed so the ORDER BY created_at DESC on the feed
  -- still sees fresh listings.
  update public.listings
     set current_version_id = v_version_id,
         updated_at         = now()
   where id = v_listing_id;

  return jsonb_build_object(
    'listing_id', v_listing_id,
    'version_id', v_version_id
  );
end;
$$;

revoke all on function public.create_listing_rpc(uuid, jsonb) from public;
revoke all on function public.create_listing_rpc(uuid, jsonb) from anon, authenticated;
grant execute on function public.create_listing_rpc(uuid, jsonb) to service_role;

comment on function public.create_listing_rpc(uuid, jsonb) is
  'US-053 create-listing RPC. Atomic insert of listings + listing_versions + listing_conditions + sample_videos. Called only by the create-listing edge function via service_role.';

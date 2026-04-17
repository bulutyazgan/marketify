-- US-012 — Dev seed data per docs/tech-architecture.md §4.7.
-- Creates: 1 lister, 1 active listing (v1 + pre/post conditions + sample video),
-- 1 creator with tiktok + instagram handles, and one metric_snapshots row for
-- each of the three scrape_modes (tiktok_profile, ig_details, ig_posts).
-- The app_private.denorm_metrics BEFORE-INSERT trigger (US-007) mirrors the
-- snapshots into public.creator_profiles, so no manual denorm updates here.
-- Fixed UUIDs so later stories (US-038 discover feed, US-055 edit campaign,
-- US-038+ verification flows) can reference the seeded rows deterministically.

do $$
declare
  v_lister_id  uuid := '11111111-1111-1111-1111-111111111001';
  v_creator_id uuid := '11111111-1111-1111-1111-111111111002';
  v_listing_id uuid := '11111111-1111-1111-1111-111111111010';
  v_version_id uuid := '11111111-1111-1111-1111-111111111011';
  v_tt_link_id uuid := '11111111-1111-1111-1111-111111111020';
  v_ig_link_id uuid := '11111111-1111-1111-1111-111111111021';
begin
  -- ---- lister ----------------------------------------------------------
  insert into public.users (id, role, username, email)
  values (v_lister_id, 'lister', 'acme_studio', 'lister@seed.marketify.test');

  insert into public.lister_profiles (user_id, org_name, website_url, description)
  values (
    v_lister_id, 'Acme Studio', 'https://acme.example',
    'Seed lister for development and RLS verification.'
  );

  -- ---- creator ---------------------------------------------------------
  insert into public.users (id, role, username, email)
  values (v_creator_id, 'creator', 'seed_creator', 'creator@seed.marketify.test');

  insert into public.creator_profiles (user_id, display_name, bio, country)
  values (v_creator_id, 'Seed Creator', 'Dev seed creator.', 'US');

  insert into public.social_links (
    id, user_id, platform, handle, status, handle_confirmed_at
  ) values
    (v_tt_link_id, v_creator_id, 'tiktok',    'seed_creator_tt', 'linked', now()),
    (v_ig_link_id, v_creator_id, 'instagram', 'seed_creator_ig', 'linked', now());

  -- ---- listing + v1 ----------------------------------------------------
  -- Insert as active immediately; current_version_id is wired after v1 exists.
  -- The follow-up UPDATE touches only current_version_id, so the US-010
  -- cascade trigger detects no versioned change and does not re-bump.
  insert into public.listings (
    id, lister_id, status,
    title, description, category,
    price_cents, currency, max_submissions,
    min_followers_tiktok, min_followers_instagram,
    published_at
  ) values (
    v_listing_id, v_lister_id, 'active',
    'Promote Acme Headphones',
    'Create a 30-60s short demonstrating our new headphones. See samples for vibe.',
    'tech',
    15000, 'USD', 10,
    1000, 500,
    now()
  );

  insert into public.listing_versions (
    id, listing_id, version_number,
    price_cents, currency, max_submissions,
    snapshot, changed_fields
  ) values (
    v_version_id, v_listing_id, 1,
    15000, 'USD', 10,
    jsonb_build_object(
      'title',           'Promote Acme Headphones',
      'price_cents',     15000,
      'currency',        'USD',
      'max_submissions', 10
    ),
    array[]::text[]
  );

  update public.listings
     set current_version_id = v_version_id
   where id = v_listing_id;

  -- ---- pre + post conditions for v1 -----------------------------------
  insert into public.listing_conditions (
    listing_version_id, kind, metric, platform, operator, numeric_threshold
  ) values
    (v_version_id, 'pre', 'min_followers', 'tiktok',    'gte', 1000),
    (v_version_id, 'pre', 'min_followers', 'instagram', 'gte',  500);

  insert into public.listing_conditions (
    listing_version_id, kind, metric, operator, bool_threshold
  ) values
    (v_version_id, 'post', 'post_family_friendly', 'bool', true);

  insert into public.listing_conditions (
    listing_version_id, kind, metric, operator, text_threshold
  ) values
    (v_version_id, 'post', 'post_must_mention', 'contains', '#AcmeHeadphones');

  insert into public.sample_videos (
    listing_version_id, platform, url, caption, sort_order
  ) values (
    v_version_id, 'tiktok',
    'https://www.tiktok.com/@acme_studio/video/7100000000000000001',
    'Reference vibe', 0
  );

  -- ---- metric_snapshots (all three scrape_modes) -----------------------
  -- Triggers fire on INSERT: coherence check + denorm_metrics mirrors into
  -- creator_profiles. The three rows below populate the full denorm column
  -- set (tiktok_*, instagram_follower_count, instagram_media_count,
  -- instagram_avg_views_last_10, metrics_fetched_at).
  insert into public.metric_snapshots (
    social_link_id, scrape_mode, status,
    follower_count, avg_views_last_10, total_likes, video_count, is_verified,
    fetched_at
  ) values
    (v_tt_link_id, 'tiktok_profile', 'fresh',
     42000, 18500, 850000, 120, false, now()),
    (v_ig_link_id, 'ig_details', 'fresh',
     15000, null,  null,   55,   true,  now()),
    (v_ig_link_id, 'ig_posts', 'fresh',
     null,  6400,  null,   null, null,  now());
end $$;

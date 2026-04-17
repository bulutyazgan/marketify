-- US-040 — add a second active listing with high PRE thresholds so the
-- campaign-detail screen's ineligible state can be visually verified
-- against the seed creator (93.7M TikTok / 15k Instagram followers).
--
-- Thresholds chosen to fail BOTH platforms across multiple metrics so
-- the failed_conditions rail renders at least three rows:
--   * min_followers_tiktok        = 1_000_000_000  (actual 93_700_000 — fails)
--   * min_followers_instagram     = 50_000         (actual 15_000      — fails)
--   * instagram min_avg_views_last_n = 50_000      (actual 6_400       — fails)

do $$
declare
  v_lister_id  uuid := '11111111-1111-1111-1111-111111111001';  -- reuse seed lister
  v_listing_id uuid := '22222222-2222-2222-2222-222222222010';
  v_version_id uuid := '22222222-2222-2222-2222-222222222011';
begin
  insert into public.listings (
    id, lister_id, status,
    title, description, category,
    price_cents, currency, max_submissions,
    min_followers_tiktok, min_followers_instagram,
    published_at
  ) values (
    v_listing_id, v_lister_id, 'active',
    'Mega-Influencer Luxe Launch',
    'A whitelist bounty for mega-channel creators only. Film a 45-60s launch reveal of our limited-run luxe drop. Bar is deliberately high to gate the ineligible UI state during QA.',
    'fashion',
    250000, 'USD', 3,
    1000000000, 50000,
    now()
  );

  insert into public.listing_versions (
    id, listing_id, version_number,
    price_cents, currency, max_submissions,
    snapshot, changed_fields
  ) values (
    v_version_id, v_listing_id, 1,
    250000, 'USD', 3,
    jsonb_build_object(
      'title',           'Mega-Influencer Luxe Launch',
      'price_cents',     250000,
      'currency',        'USD',
      'max_submissions', 3
    ),
    array[]::text[]
  );

  update public.listings
     set current_version_id = v_version_id
   where id = v_listing_id;

  insert into public.listing_conditions (
    listing_version_id, kind, metric, platform, operator, numeric_threshold
  ) values
    (v_version_id, 'pre', 'min_followers',        'tiktok',    'gte', 1000000000),
    (v_version_id, 'pre', 'min_followers',        'instagram', 'gte',      50000),
    (v_version_id, 'pre', 'min_avg_views_last_n', 'instagram', 'gte',      50000);

  insert into public.listing_conditions (
    listing_version_id, kind, metric, operator, bool_threshold
  ) values
    (v_version_id, 'post', 'post_family_friendly', 'bool', true);

  insert into public.listing_conditions (
    listing_version_id, kind, metric, operator, text_threshold
  ) values
    (v_version_id, 'post', 'post_must_mention', 'contains', '#LuxeDrop');

  insert into public.sample_videos (
    listing_version_id, platform, url, caption, sort_order
  ) values
    (v_version_id, 'tiktok',
     'https://www.tiktok.com/@acme_studio/video/7100000000000000002',
     'Launch reveal — reference A', 0),
    (v_version_id, 'instagram',
     'https://www.instagram.com/p/LuxeLaunchReel/',
     'Launch reveal — reference B', 1);
end $$;

-- US-035 — widen metric_snapshots_self_read so creators can see their own
-- is_latest row when it has been flipped to status='stale' by the hourly
-- `mark-metrics-stale` cron (us_011).
--
-- Before: policy required status='fresh'. Result: the Profile screen's
-- stale-chip query returned zero rows even when snapshots were legitimately
-- stale, because RLS silently filtered them out. There was no way for a
-- creator to learn their metrics had aged past 24h without the server
-- computing it for them.
--
-- After: creators can select their own is_latest snapshot regardless of
-- fresh vs. stale. 'refreshing' and 'failed' rows stay service-role only —
-- those represent in-flight or error states the client learns about via
-- edge-function responses (metrics-refresh / apify-webhook), not direct
-- table reads. The lister-read policy stays unchanged; listers only ever
-- need a successful eligibility snapshot for their applicant reviews.

drop policy if exists metric_snapshots_self_read on public.metric_snapshots;
create policy metric_snapshots_self_read on public.metric_snapshots for select
  using (
    is_latest and status in ('fresh', 'stale')
    and exists (
      select 1 from public.social_links sl
      where sl.id = public.metric_snapshots.social_link_id
        and sl.user_id = public.current_user_id()
    )
  );

comment on policy metric_snapshots_self_read on public.metric_snapshots is
  'Creator self-read of own is_latest snapshots (fresh + stale). Widened in us_035 so the Profile screen can surface the Stale chip — the hourly mark-metrics-stale cron flips status from fresh to stale in place on the same is_latest row.';

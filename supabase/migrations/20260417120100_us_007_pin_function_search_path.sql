-- US-007 follow-up: pin search_path on the two new trigger functions.
--
-- get_advisors raised `function_search_path_mutable` (WARN) on
-- app_private.denorm_metrics and app_private.check_metric_snapshot_coherence.
-- denorm_metrics is SECURITY DEFINER, so a caller-controlled search_path could
-- shadow public.creator_profiles or public.metric_snapshots and divert writes.
-- Both functions already qualify every reference, so an empty search_path is
-- safe and clears the advisor.

alter function app_private.check_metric_snapshot_coherence()
  set search_path = '';

alter function app_private.denorm_metrics()
  set search_path = '';

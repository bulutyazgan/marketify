-- US-011: Schedule the recurring pg_cron jobs that keep metric_snapshots fresh.
--
-- Two jobs land here:
--   1. `mark-metrics-stale` (hourly) — flips `metric_snapshots.status` from
--      'fresh' → 'stale' once a snapshot is older than 24h. Verbatim from
--      docs/tech-architecture.md §16 (lines 1505-1509). Surfaces the
--      "Outdated" chip on the creator profile (design.md).
--   2. `cron-refresh-metrics` (daily, 04:00 UTC) — invokes the
--      `cron-refresh-metrics` edge function via pg_net. The function itself is
--      built in a later story (spec §5.2 lines 1641-1653); until then the
--      cron firing will fail with a 404 logged in `cron.job_run_details` —
--      harmless and self-recovering once the function is deployed.
--
-- pg_cron is preinstalled in `pg_catalog` on this project (see Codebase
-- Patterns). pg_net is enabled here for the HTTP call from the daily job.
--
-- Vault dependency (must be populated out-of-band via the Supabase dashboard
-- before the daily cron starts succeeding):
--   * marketify_project_url       — e.g. https://<project-ref>.supabase.co
--   * marketify_service_role_key  — service-role JWT used by the edge function
-- Documenting this here keeps the secret material out of the migration body
-- and out of the conversation. No-op until both are present.
--
-- Naming gap: story AC says "metrics-refresh edge function" but spec §5.2
-- distinguishes the user-triggered `metrics-refresh` (US-021) from the
-- internal `cron-refresh-metrics`. Followed the spec — the cron must NOT call
-- the user-facing function (different rate-limit + auth shape).

-- pg_net forces its functions into the `net` schema regardless of WITH SCHEMA;
-- the WITH SCHEMA clause is accepted but ignored. Calls below use `net.http_post`.
create extension if not exists pg_net with schema extensions;

-- Re-runnable schedule: cron.schedule raises on duplicate jobname, so wipe
-- any prior registrations first. cron.unschedule(text) raises when the name
-- is unknown, hence the existence guard.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'mark-metrics-stale') then
    perform cron.unschedule('mark-metrics-stale');
  end if;
  if exists (select 1 from cron.job where jobname = 'cron-refresh-metrics') then
    perform cron.unschedule('cron-refresh-metrics');
  end if;
end $$;

-- Job 1: hourly staleness marker (spec §16)
select cron.schedule(
  'mark-metrics-stale',
  '0 * * * *',
  $$
    update public.metric_snapshots
       set status = 'stale'
     where status = 'fresh'
       and fetched_at < now() - interval '24 hours'
       and is_latest;
  $$
);

-- Job 2: daily creator-metrics refresh (spec §5.2)
-- Reads URL + service-role key from supabase_vault at fire time so secret
-- rotations don't require a new migration. `timeout_milliseconds` is generous
-- because the edge function may enqueue many Apify runs in a loop.
select cron.schedule(
  'cron-refresh-metrics',
  '0 4 * * *',
  $$
    select net.http_post(
      url := (
        select decrypted_secret
          from vault.decrypted_secrets
         where name = 'marketify_project_url'
         limit 1
      ) || '/functions/v1/cron-refresh-metrics',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (
          select decrypted_secret
            from vault.decrypted_secrets
           where name = 'marketify_service_role_key'
           limit 1
        )
      ),
      body := jsonb_build_object('source', 'pg_cron'),
      timeout_milliseconds := 60000
    );
  $$
);

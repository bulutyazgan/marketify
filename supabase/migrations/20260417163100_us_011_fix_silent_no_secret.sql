-- US-011 follow-up: harden the daily cron-refresh-metrics body so that a
-- missing vault secret raises a visible exception instead of being silently
-- swallowed by pg_net.
--
-- Original (us_011_cron_jobs) wired the URL via an inline sub-select on
-- vault.decrypted_secrets. When the secret row is absent, the sub-select
-- returns NULL, and pg_net.net.http_post(url := NULL, ...) returns a row id
-- without raising. cron.job_run_details then logs the run as `succeeded` even
-- though no HTTP call ever left the database. That breaks the operational
-- intent ("don't silently skip" per story AC) and would mask a misconfigured
-- pre-production environment indefinitely.
--
-- Fix: wrap the call in an anonymous PL/pgSQL block that resolves both
-- secrets first and RAISE EXCEPTION when either is NULL. cron.job_run_details
-- records the failed status and surfaces the misconfiguration to ops.

do $$
begin
  if exists (select 1 from cron.job where jobname = 'cron-refresh-metrics') then
    perform cron.unschedule('cron-refresh-metrics');
  end if;
end $$;

select cron.schedule(
  'cron-refresh-metrics',
  '0 4 * * *',
  $$
    do $body$
    declare
      v_url text;
      v_key text;
    begin
      select decrypted_secret into v_url
        from vault.decrypted_secrets
       where name = 'marketify_project_url'
       limit 1;
      select decrypted_secret into v_key
        from vault.decrypted_secrets
       where name = 'marketify_service_role_key'
       limit 1;
      if v_url is null or v_key is null then
        raise exception
          'cron-refresh-metrics: vault secrets not configured (url=%, key=%)',
          (v_url is not null), (v_key is not null);
      end if;
      perform net.http_post(
        url := v_url || '/functions/v1/cron-refresh-metrics',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || v_key
        ),
        body := jsonb_build_object('source', 'pg_cron'),
        timeout_milliseconds := 60000
      );
    end
    $body$;
  $$
);

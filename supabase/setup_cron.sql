-- Run this ONCE in the Supabase SQL editor after deploying the edge function.
-- It schedules the DMI fetch every 5 minutes using pg_cron + pg_net.
--
-- BEFORE RUNNING, replace:
--   <PROJECT_REF>        your Supabase project ref (e.g. abcdefghijklm)
--   <SERVICE_ROLE_KEY>   Settings → API → service_role key
--
-- (Alternatively use the Dashboard: Integrations → Cron → schedule the
-- "fetch-dmi-data" edge function every 5 minutes — same effect, no SQL.)

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'fetch-dmi-data',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := 'https://<PROJECT_REF>.supabase.co/functions/v1/fetch-dmi-data',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer <SERVICE_ROLE_KEY>'
    ),
    body := '{}'::jsonb
  );
  $$
);

-- To inspect: select * from cron.job;
-- To remove:  select cron.unschedule('fetch-dmi-data');

-- Poll DMI every 5 minutes instead of 10, to reduce how stale the shown
-- reading can get. Only affects a pg_cron job named 'fetch-dmi-data'. If the
-- schedule is instead managed via the Supabase dashboard Cron integration,
-- change it there too (Integrations → Cron → fetch-dmi-data → */5 * * * *).
do $$
declare jid int;
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    select jobid into jid from cron.job where jobname = 'fetch-dmi-data';
    if jid is not null then
      perform cron.alter_job(jid, schedule := '*/5 * * * *');
    end if;
  end if;
end $$;

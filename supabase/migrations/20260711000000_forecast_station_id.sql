-- Per-station forecast.
-- The DKSS forecast was keyed only by `source` (one location — Mandø). Add
-- station_id so we can store a separate forecast per station (Mandø + Ribe
-- Kammersluse), matching station_readings / tide_predictions which already
-- carry station_id. Existing rows are backfilled to Mandø's station.
--
-- Safe ordering for rollout: apply this first. Until Ribe is actually ingested,
-- only Mandø rows exist, so both the current (unfiltered) frontend and the new
-- per-station frontend read correct data. Deploy the new frontend before the
-- edge function starts writing Ribe rows.

alter table public.water_level_forecast
  add column if not exists station_id text;

update public.water_level_forecast
  set station_id = '9007101'
  where station_id is null;

alter table public.water_level_forecast
  alter column station_id set not null;

-- Drop the old UNIQUE(source, forecast_at) by definition (not by its
-- auto-generated name) so a leftover can't block two stations sharing a
-- source + timestamp.
do $$
declare c text;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.water_level_forecast'::regclass
      and contype = 'u'
      and pg_get_constraintdef(oid) ilike '%(source, forecast_at)%'
  loop
    execute format('alter table public.water_level_forecast drop constraint %I', c);
  end loop;
end $$;

alter table public.water_level_forecast
  add constraint water_level_forecast_station_source_forecast_at_key
    unique (station_id, source, forecast_at);

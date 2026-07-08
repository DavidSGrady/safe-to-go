-- Station-calibrated forecast + provenance.
--
-- A second forecast source is added alongside the DKSS grid rows:
-- source = 'dmi_station' — the 10-minute station prognosis dmi.dk itself
-- shows for the gauge (ARIMA + DKSS, calibrated to the station). It is
-- ingested from www.dmi.dk's ninjo2dmidk endpoint and becomes the primary
-- forecast; the DKSS grid rows remain as fallback. No schema change is
-- needed for that (station_id, source, forecast_at is already unique).
--
-- generated_at records when DMI generated the model run (dmi_station) or
-- when we fetched it (DKSS). Shown in the /data page footer so a mismatch
-- with dmi.dk can be traced to a stale run at a glance. Nullable: rows
-- written by the previous edge function simply have no provenance.
alter table public.water_level_forecast
  add column if not exists generated_at timestamptz;

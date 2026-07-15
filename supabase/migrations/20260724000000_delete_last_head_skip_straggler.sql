-- The last stale row from the head-skip era: authored 2026-07-15T09:40:02Z
-- (under the old 25-minute-skip code, 26 minutes before the youngest-write
-- fix deployed at 10:06:22Z) and slipped into the past before the first
-- new-code run could rewrite it. Verified 13 cm off the measured level.
-- Post-deploy verification: all 10 rows authored by the new code are clean.

delete from public.water_level_forecast
where source = 'dmi_station'
  and station_id = '9007101'
  and forecast_at = '2026-07-15 10:10:00+00'::timestamptz;

-- Delete station-prognosis rows poisoned by NinJo's intermittent head-of-run
-- corruption (2026-07-13/14). Each of these was the LAST write its timestamp
-- received before slipping into the past, so the corrupt value became
-- permanent and showed up as an isolated 12-53 cm delta spike against the
-- measured level on /data. Verified against station_readings: every row
-- below deviates >= 12 cm from the interpolated observation at the same
-- instant, far beyond the prognosis's normal 0-6 cm error band.
--
-- Deleting (rather than patching) keeps the series honest: the display
-- interpolates across the 10-minute gap. The ingest-side fix (25-minute head
-- skip + in-run spike rejection in fetch-dmi-data) prevents new ones.

delete from public.water_level_forecast
where source = 'dmi_station'
  and (station_id, forecast_at) in (
    -- Ribe Kammersluse (9006701)
    ('9006701', '2026-07-13 15:50:00+00'::timestamptz),
    ('9006701', '2026-07-13 16:00:00+00'::timestamptz),
    ('9006701', '2026-07-13 18:00:00+00'::timestamptz),
    ('9006701', '2026-07-13 20:50:00+00'::timestamptz),
    ('9006701', '2026-07-13 21:00:00+00'::timestamptz),
    ('9006701', '2026-07-13 21:30:00+00'::timestamptz),
    ('9006701', '2026-07-13 21:50:00+00'::timestamptz),
    ('9006701', '2026-07-13 23:40:00+00'::timestamptz),
    ('9006701', '2026-07-14 05:20:00+00'::timestamptz),
    ('9006701', '2026-07-14 05:30:00+00'::timestamptz),
    ('9006701', '2026-07-14 06:30:00+00'::timestamptz),
    -- Mandø (9007101)
    ('9007101', '2026-07-13 16:50:00+00'::timestamptz),
    ('9007101', '2026-07-13 20:00:00+00'::timestamptz),
    ('9007101', '2026-07-13 20:50:00+00'::timestamptz),
    ('9007101', '2026-07-13 21:00:00+00'::timestamptz),
    ('9007101', '2026-07-13 21:10:00+00'::timestamptz),
    ('9007101', '2026-07-13 21:50:00+00'::timestamptz),
    ('9007101', '2026-07-13 22:00:00+00'::timestamptz),
    ('9007101', '2026-07-14 05:20:00+00'::timestamptz),
    ('9007101', '2026-07-14 05:50:00+00'::timestamptz),
    ('9007101', '2026-07-14 06:40:00+00'::timestamptz)
  );

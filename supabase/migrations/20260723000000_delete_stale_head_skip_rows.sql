-- Delete station-prognosis rows frozen with stale 25-30-minute-old model
-- values while the head-skip workarounds (2026-07-13/14) were live. The
-- youngest, observation-nudged points were being skipped, so each of these
-- timestamps kept a pure-model value that deviates >= 12 cm from the
-- interpolated measurement at the same instant. The ingest now keeps the
-- youngest write and rejects only shape-glitches (>20 cm off the run's own
-- curve). Displays interpolate across the deleted 10-minute gaps.

delete from public.water_level_forecast
where source = 'dmi_station'
  and (station_id, forecast_at) in (
    ('9006701', '2026-07-14T18:10:00+00'::timestamptz),
    ('9006701', '2026-07-14T21:40:00+00'::timestamptz),
    ('9006701', '2026-07-14T21:50:00+00'::timestamptz),
    ('9006701', '2026-07-14T22:00:00+00'::timestamptz),
    ('9006701', '2026-07-14T22:10:00+00'::timestamptz),
    ('9006701', '2026-07-15T07:00:00+00'::timestamptz),
    ('9006701', '2026-07-15T09:40:00+00'::timestamptz),
    ('9006701', '2026-07-15T09:50:00+00'::timestamptz),
    ('9006701', '2026-07-15T10:00:00+00'::timestamptz),
    ('9007101', '2026-07-14T17:50:00+00'::timestamptz),
    ('9007101', '2026-07-14T18:00:00+00'::timestamptz),
    ('9007101', '2026-07-14T21:40:00+00'::timestamptz),
    ('9007101', '2026-07-14T21:50:00+00'::timestamptz),
    ('9007101', '2026-07-14T22:00:00+00'::timestamptz),
    ('9007101', '2026-07-14T22:10:00+00'::timestamptz),
    ('9007101', '2026-07-14T22:20:00+00'::timestamptz),
    ('9007101', '2026-07-14T22:30:00+00'::timestamptz),
    ('9007101', '2026-07-14T22:40:00+00'::timestamptz),
    ('9007101', '2026-07-14T22:50:00+00'::timestamptz),
    ('9007101', '2026-07-15T03:20:00+00'::timestamptz),
    ('9007101', '2026-07-15T06:20:00+00'::timestamptz),
    ('9007101', '2026-07-15T06:30:00+00'::timestamptz),
    ('9007101', '2026-07-15T06:40:00+00'::timestamptz),
    ('9007101', '2026-07-15T09:40:00+00'::timestamptz),
    ('9007101', '2026-07-15T09:50:00+00'::timestamptz),
    ('9007101', '2026-07-15T10:00:00+00'::timestamptz)
  );

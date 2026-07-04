-- DKSS water-level forecast (DMI storm-surge model, weather-inclusive).
-- Replaces our home-grown surge extrapolation: the forecast now comes
-- straight from DMI's DKSS Wadden Sea model, which already includes wind
-- and air pressure. Values are cm relative to the same reference as the
-- gauge (aligned at read time to the latest observation).

create table public.water_level_forecast (
  id bigint generated always as identity primary key,
  forecast_at timestamptz not null,
  value_cm numeric not null,
  source text not null default 'dkss_ws',
  created_at timestamptz not null default now(),
  unique (source, forecast_at)
);

create index water_level_forecast_forecast_at_idx
  on public.water_level_forecast (forecast_at);

alter table public.water_level_forecast enable row level security;

create policy "public read forecast"
  on public.water_level_forecast for select using (true);

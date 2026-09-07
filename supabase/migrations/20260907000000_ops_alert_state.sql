-- Key/value state for operational alerts sent by the fetch-dmi-data edge
-- function — currently one kind: "no new readings for a station in N hours"
-- (see alertOnStaleObservations() in the function). The state makes a station
-- going stale produce one alert, a slow-cadence reminder and one recovery
-- message, instead of the 5-minute cron re-posting every run.
--
-- Written only by the edge function with the service role. RLS is enabled with
-- no policies, so the anon key (which ships in the frontend bundle) can neither
-- read nor reset alert state. Backward-compatible: nothing else references it,
-- and the function treats a missing table as a non-fatal error.

create table public.ops_alert_state (
  key text primary key check (char_length(key) <= 128),
  active boolean not null default false,
  first_stale_at timestamptz,
  last_notified_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.ops_alert_state enable row level security;

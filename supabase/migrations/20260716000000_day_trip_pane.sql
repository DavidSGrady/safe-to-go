-- Choose which planning pane shows under the verdict on the public page:
--   'daytrip' — the new "Planning a daytrip?" there-and-back planner
--   'return'  — the older "Heading back today?" last-departure banner
--   'off'     — neither
-- Defaults to 'daytrip' so the new pane goes live; flip it from /admin.

alter table public.safety_rules
  add column if not exists day_trip_mode text not null default 'daytrip';

alter table public.safety_rules
  add constraint safety_rules_day_trip_mode_check
    check (day_trip_mode in ('daytrip', 'return', 'off'));

-- Keep the audit trigger in sync with the new column.
create or replace function public.log_rule_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  insert into public.rule_change_log (changed_by, changed_by_email, old_values, new_values)
  values (
    auth.uid(),
    (select email from public.profiles where id = auth.uid()),
    jsonb_build_object(
      'flood_margin_cm', old.flood_margin_cm,
      'fall_margin_cm', old.fall_margin_cm,
      'caution_max_cm', old.caution_max_cm,
      'crossing_minutes', old.crossing_minutes,
      'buffer_minutes', old.buffer_minutes,
      'min_window_minutes', old.min_window_minutes,
      'wind_adjustment_enabled', old.wind_adjustment_enabled,
      'puddle_warning_enabled', old.puddle_warning_enabled,
      'puddle_warning_range_cm', old.puddle_warning_range_cm,
      'playback_speed_pct', old.playback_speed_pct,
      'day_trip_mode', old.day_trip_mode
    ),
    jsonb_build_object(
      'flood_margin_cm', new.flood_margin_cm,
      'fall_margin_cm', new.fall_margin_cm,
      'caution_max_cm', new.caution_max_cm,
      'crossing_minutes', new.crossing_minutes,
      'buffer_minutes', new.buffer_minutes,
      'min_window_minutes', new.min_window_minutes,
      'wind_adjustment_enabled', new.wind_adjustment_enabled,
      'puddle_warning_enabled', new.puddle_warning_enabled,
      'puddle_warning_range_cm', new.puddle_warning_range_cm,
      'playback_speed_pct', new.playback_speed_pct,
      'day_trip_mode', new.day_trip_mode
    )
  );
  return new;
end;
$$;

-- Refresh the Realtime publication so it picks up the new column.
alter publication supabase_realtime drop table public.safety_rules;
alter publication supabase_realtime add table public.safety_rules;

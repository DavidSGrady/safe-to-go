-- Minimum day-trip length: the shortest visit (minutes on the island) worth
-- suggesting a there-and-back daytrip for. The planner ignores windows that
-- leave less than this on Mandø, so it never proposes crossing over just to
-- turn straight around. Default 120 min (2 h); tune from /admin.

alter table public.safety_rules
  add column if not exists min_daytrip_minutes int not null default 120;

alter table public.safety_rules
  add constraint safety_rules_min_daytrip_minutes_check
    check (min_daytrip_minutes between 0 and 720);

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
      'day_trip_mode', old.day_trip_mode,
      'min_daytrip_minutes', old.min_daytrip_minutes
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
      'day_trip_mode', new.day_trip_mode,
      'min_daytrip_minutes', new.min_daytrip_minutes
    )
  );
  return new;
end;
$$;

-- Refresh the Realtime publication so it picks up the new column.
alter publication supabase_realtime drop table public.safety_rules;
alter publication supabase_realtime add table public.safety_rules;

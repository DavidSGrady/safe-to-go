-- Admin-tunable playback speed for the "situation at the road" animation.
-- playback_speed_pct scales how fast the road cross-section scrubs through the
-- forecast when Play is pressed: 100 = current speed, 50 = half, 33 = a third.
-- Default 100 keeps the existing behaviour until an admin dials it down.

alter table public.safety_rules
  add column if not exists playback_speed_pct int not null default 100;

alter table public.safety_rules
  add constraint safety_rules_playback_speed_check
    check (playback_speed_pct between 10 and 100);

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
      'playback_speed_pct', old.playback_speed_pct
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
      'playback_speed_pct', new.playback_speed_pct
    )
  );
  return new;
end;
$$;

-- Refresh the Realtime publication so it picks up the new column.
alter publication supabase_realtime drop table public.safety_rules;
alter publication supabase_realtime add table public.safety_rules;

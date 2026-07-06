-- Optional "puddles may remain" caution on the receding tide.
-- puddle_warning_enabled toggles a caution shown while the water is *falling*
-- and still within puddle_warning_range_cm below the flood point — for residual
-- flooding / puddles once the locals treat the road level itself as passable.

alter table public.safety_rules
  add column if not exists puddle_warning_enabled boolean not null default false,
  add column if not exists puddle_warning_range_cm int not null default 15;

alter table public.safety_rules
  add constraint safety_rules_puddle_range_check
    check (puddle_warning_range_cm between 0 and 100);

-- Keep the audit trigger in sync with the new columns.
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
      'puddle_warning_range_cm', old.puddle_warning_range_cm
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
      'puddle_warning_range_cm', new.puddle_warning_range_cm
    )
  );
  return new;
end;
$$;

-- Refresh the Realtime publication so it picks up the new columns.
alter publication supabase_realtime drop table public.safety_rules;
alter publication supabase_realtime add table public.safety_rules;

-- Wind/weather adjustment toggle.
-- When on (default), the current gap between the measured level and the
-- astronomical tide table is carried forward and added to the forecast.
-- When off, forecasts use the plain astronomical tide only.

alter table public.safety_rules
  add column if not exists wind_adjustment_enabled boolean not null default true;

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
      'safe_max_cm', old.safe_max_cm,
      'caution_max_cm', old.caution_max_cm,
      'crossing_minutes', old.crossing_minutes,
      'buffer_minutes', old.buffer_minutes,
      'min_window_minutes', old.min_window_minutes,
      'wind_adjustment_enabled', old.wind_adjustment_enabled
    ),
    jsonb_build_object(
      'safe_max_cm', new.safe_max_cm,
      'caution_max_cm', new.caution_max_cm,
      'crossing_minutes', new.crossing_minutes,
      'buffer_minutes', new.buffer_minutes,
      'min_window_minutes', new.min_window_minutes,
      'wind_adjustment_enabled', new.wind_adjustment_enabled
    )
  );
  return new;
end;
$$;

-- Refresh the Realtime publication for safety_rules. The previous migration
-- dropped margin_minutes, but Realtime cached the old column list, so
-- realtime.apply_rls kept erroring with "column margin_minutes does not
-- exist". Removing and re-adding the table forces Realtime to re-read the
-- current schema.
alter publication supabase_realtime drop table public.safety_rules;
alter publication supabase_realtime add table public.safety_rules;

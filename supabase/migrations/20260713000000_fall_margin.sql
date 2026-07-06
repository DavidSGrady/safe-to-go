-- Falling side as a margin below the flood point — symmetric with the rising
-- flood_margin_cm. `fall_margin_cm` = how many cm below cautionMaxCm the falling
-- water must reach before the road counts as safe. Backfilled from the old
-- absolute safe_max_falling_cm (caution − safe_max_falling). safe_max_falling_cm
-- is KEPT (nullable, its check dropped) so the currently-live frontend survives
-- the rollout; a later migration can drop it.

alter table public.safety_rules
  add column if not exists fall_margin_cm int;

update public.safety_rules
  set fall_margin_cm = greatest(0, caution_max_cm - safe_max_falling_cm)
  where fall_margin_cm is null and safe_max_falling_cm is not null;

alter table public.safety_rules
  alter column fall_margin_cm set default 5;

update public.safety_rules set fall_margin_cm = 5 where fall_margin_cm is null;

alter table public.safety_rules
  alter column fall_margin_cm set not null;

-- Retire the old absolute falling limit: drop its check + NOT NULL.
alter table public.safety_rules
  drop constraint if exists safety_rules_falling_le_caution,
  alter column safe_max_falling_cm drop not null;

alter table public.safety_rules
  add constraint safety_rules_fall_margin_range
    check (fall_margin_cm >= 0 and fall_margin_cm <= caution_max_cm);

-- Keep the audit trigger in sync with the new column set.
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
      'wind_adjustment_enabled', old.wind_adjustment_enabled
    ),
    jsonb_build_object(
      'flood_margin_cm', new.flood_margin_cm,
      'fall_margin_cm', new.fall_margin_cm,
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

-- Refresh the Realtime publication so it picks up the new column.
alter publication supabase_realtime drop table public.safety_rules;
alter publication supabase_realtime add table public.safety_rules;

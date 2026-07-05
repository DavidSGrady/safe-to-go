-- Flood safety margin on the rising limb (backward-compatible rollout).
--
-- Replaces the absolute rising passable limit (safe_max_rising_cm) with a
-- "stay this many cm below flooding for the whole crossing" margin. The last
-- safe departure while the water is rising is now timed so the crossing
-- finishes before the water reaches (caution_max_cm - flood_margin_cm); see
-- src/lib/tide.ts. Falling water is unchanged (safe at/below safe_max_falling_cm).
--
-- safe_max_rising_cm is KEPT (made nullable, its constraints dropped) so the
-- frontend build currently live in production keeps working during the Vercel
-- rollout. A later migration can drop it (and the older vestigial safe_max_cm).
--
-- Default 5 cm is applied to the existing configured row as well — this is a
-- deliberate, admin-approved value and is MORE permissive than the previous
-- effective margin (caution - safe_max_rising = 15 cm). It can be retuned in /admin.

alter table public.safety_rules
  add column if not exists flood_margin_cm int not null default 5;

-- Retire the old rising limit: drop its constraints and NOT NULL so it stops
-- constraining anything and the new UI (which no longer writes it) can save.
alter table public.safety_rules
  drop constraint if exists safety_rules_rising_le_caution,
  drop constraint if exists safety_rules_rising_le_falling,
  alter column safe_max_rising_cm drop not null;

alter table public.safety_rules
  add constraint safety_rules_flood_margin_range
    check (flood_margin_cm >= 0 and flood_margin_cm <= caution_max_cm);

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
      'safe_max_falling_cm', old.safe_max_falling_cm,
      'caution_max_cm', old.caution_max_cm,
      'crossing_minutes', old.crossing_minutes,
      'buffer_minutes', old.buffer_minutes,
      'min_window_minutes', old.min_window_minutes,
      'wind_adjustment_enabled', old.wind_adjustment_enabled
    ),
    jsonb_build_object(
      'flood_margin_cm', new.flood_margin_cm,
      'safe_max_falling_cm', new.safe_max_falling_cm,
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

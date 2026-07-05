-- Directional passable limits (backward-compatible rollout).
--
-- Split the single passable limit into a stricter "rising" limit and a more
-- lenient "falling" limit. A safe window opens when falling water drops below
-- safe_max_falling_cm and closes when rising water climbs above
-- safe_max_rising_cm — so crossings stop being allowed sooner while the water
-- is on its way back up (you need to be more cautious when it's rising).
--
-- The legacy safe_max_cm column is intentionally KEPT (made nullable, its old
-- check dropped) so the frontend build currently live in production keeps
-- working during the Vercel rollout — there is no ordering in which the site
-- breaks. A later migration can drop safe_max_cm once every client is on the
-- new build.

alter table public.safety_rules
  add column if not exists safe_max_rising_cm int,
  add column if not exists safe_max_falling_cm int;

-- Preserve any prior tuning: seed both directions from the old single limit.
update public.safety_rules
  set safe_max_falling_cm = coalesce(safe_max_falling_cm, safe_max_cm),
      safe_max_rising_cm = coalesce(safe_max_rising_cm, safe_max_cm)
  where safe_max_cm is not null;

alter table public.safety_rules
  alter column safe_max_rising_cm set default 45,
  alter column safe_max_falling_cm set default 50;

-- Any row still unseeded (fresh install) gets the approved defaults.
update public.safety_rules set safe_max_rising_cm = 45 where safe_max_rising_cm is null;
update public.safety_rules set safe_max_falling_cm = 50 where safe_max_falling_cm is null;

alter table public.safety_rules
  alter column safe_max_rising_cm set not null,
  alter column safe_max_falling_cm set not null;

-- Drop the old "caution_max_cm >= safe_max_cm" check (by definition, so we
-- don't depend on its auto-generated name), so the new UI can lower the flood
-- point below the now-vestigial safe_max_cm without the DB rejecting it.
do $$
declare c text;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.safety_rules'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%safe_max_cm%'
  loop
    execute format('alter table public.safety_rules drop constraint %I', c);
  end loop;
end $$;

alter table public.safety_rules
  alter column safe_max_cm drop not null,
  add constraint safety_rules_falling_le_caution check (caution_max_cm >= safe_max_falling_cm),
  add constraint safety_rules_rising_le_caution check (caution_max_cm >= safe_max_rising_cm),
  add constraint safety_rules_rising_le_falling check (safe_max_rising_cm <= safe_max_falling_cm);

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
      'safe_max_rising_cm', old.safe_max_rising_cm,
      'safe_max_falling_cm', old.safe_max_falling_cm,
      'caution_max_cm', old.caution_max_cm,
      'crossing_minutes', old.crossing_minutes,
      'buffer_minutes', old.buffer_minutes,
      'min_window_minutes', old.min_window_minutes,
      'wind_adjustment_enabled', old.wind_adjustment_enabled
    ),
    jsonb_build_object(
      'safe_max_rising_cm', new.safe_max_rising_cm,
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

-- Refresh the Realtime publication so it picks up the new columns (the same
-- stale column-list cache the wind_toggle migration had to clear).
alter publication supabase_realtime drop table public.safety_rules;
alter publication supabase_realtime add table public.safety_rules;

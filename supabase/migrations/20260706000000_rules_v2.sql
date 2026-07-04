-- Safety rules v2: replace the single symmetric "margin" with an explicit
-- crossing time + safety buffer, matching the redesigned deadline-based
-- window algorithm (deadline = window end - crossing time - buffer).
-- New defaults follow the approved design: safe <= 50 cm, road floods at
-- 60 cm, 30 min worst-case crossing, 10 min extra buffer.

alter table public.safety_rules
  add column if not exists crossing_minutes int not null default 30,
  add column if not exists buffer_minutes int not null default 10;

-- Migrate any existing margin_minutes value into the new buffer field so a
-- prior admin's tuning isn't silently discarded, then drop the old column.
update public.safety_rules
  set buffer_minutes = margin_minutes
  where margin_minutes is not null;

update public.safety_rules
  set safe_max_cm = 50, caution_max_cm = 60, min_window_minutes = 10
  where id = 1 and safe_max_cm = 20 and caution_max_cm = 50;

alter table public.safety_rules
  drop column if exists margin_minutes,
  add constraint safety_rules_crossing_minutes_check check (crossing_minutes between 0 and 120),
  add constraint safety_rules_buffer_minutes_check check (buffer_minutes between 0 and 60);

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
      'safe_max_cm', old.safe_max_cm,
      'caution_max_cm', old.caution_max_cm,
      'crossing_minutes', old.crossing_minutes,
      'buffer_minutes', old.buffer_minutes,
      'min_window_minutes', old.min_window_minutes
    ),
    jsonb_build_object(
      'safe_max_cm', new.safe_max_cm,
      'caution_max_cm', new.caution_max_cm,
      'crossing_minutes', new.crossing_minutes,
      'buffer_minutes', new.buffer_minutes,
      'min_window_minutes', new.min_window_minutes
    )
  );
  return new;
end;
$$;

-- Safe to Go — Mandø: initial schema
-- Water levels + tide predictions ingested from DMI, admin-tunable safety rules.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.station_readings (
  id bigint generated always as identity primary key,
  station_id text not null,
  parameter_id text not null default 'sea_reg',
  observed_at timestamptz not null,
  water_level_cm numeric not null,
  created_at timestamptz not null default now(),
  unique (station_id, parameter_id, observed_at)
);

create index station_readings_observed_at_idx
  on public.station_readings (observed_at desc);

create table public.tide_predictions (
  id bigint generated always as identity primary key,
  station_id text not null,
  prediction_type text not null check (prediction_type in ('minimum', 'maximum', '10minutes')),
  predicted_at timestamptz not null,
  value_cm numeric not null,
  created_at timestamptz not null default now(),
  unique (station_id, prediction_type, predicted_at)
);

create index tide_predictions_predicted_at_idx
  on public.tide_predictions (predicted_at);

-- Single-row config table: the admin panel's knobs and dials.
-- Defaults are deliberately conservative placeholders — calibrate with local
-- authorities before launch.
create table public.safety_rules (
  id int primary key default 1 check (id = 1),
  safe_max_cm int not null default 20,
  caution_max_cm int not null default 50,
  margin_minutes int not null default 30,
  min_window_minutes int not null default 45,
  updated_by uuid references auth.users (id),
  updated_at timestamptz not null default now(),
  check (caution_max_cm >= safe_max_cm),
  check (margin_minutes between 0 and 240),
  check (min_window_minutes between 0 and 720)
);

insert into public.safety_rules (id) values (1);

create table public.rule_change_log (
  id bigint generated always as identity primary key,
  changed_by uuid references auth.users (id),
  changed_by_email text,
  changed_at timestamptz not null default now(),
  old_values jsonb not null,
  new_values jsonb not null
);

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  role text not null default 'viewer' check (role in ('viewer', 'admin')),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

-- Auto-create a profile row for every new auth user (role 'viewer' until
-- promoted; see README "Adding admins").
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Audit every change to the safety rules.
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
      'margin_minutes', old.margin_minutes,
      'min_window_minutes', old.min_window_minutes
    ),
    jsonb_build_object(
      'safe_max_cm', new.safe_max_cm,
      'caution_max_cm', new.caution_max_cm,
      'margin_minutes', new.margin_minutes,
      'min_window_minutes', new.min_window_minutes
    )
  );
  return new;
end;
$$;

create trigger on_safety_rules_updated
  before update on public.safety_rules
  for each row execute function public.log_rule_change();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

alter table public.station_readings enable row level security;
alter table public.tide_predictions enable row level security;
alter table public.safety_rules enable row level security;
alter table public.rule_change_log enable row level security;
alter table public.profiles enable row level security;

-- Public data: anyone (including anonymous visitors) can read.
create policy "public read readings"
  on public.station_readings for select using (true);

create policy "public read predictions"
  on public.tide_predictions for select using (true);

create policy "public read rules"
  on public.safety_rules for select using (true);

-- Only admins may change the rules. Writes to readings/predictions happen
-- via the edge function with the service role key, which bypasses RLS.
create policy "admins update rules"
  on public.safety_rules for update
  using (public.is_admin())
  with check (public.is_admin());

create policy "admins read change log"
  on public.rule_change_log for select using (public.is_admin());

create policy "users read own profile"
  on public.profiles for select using (id = auth.uid() or public.is_admin());

-- ---------------------------------------------------------------------------
-- Realtime: push new readings and rule changes to connected clients.
-- ---------------------------------------------------------------------------

alter publication supabase_realtime add table public.station_readings;
alter publication supabase_realtime add table public.safety_rules;

-- Web push subscriptions for "notify me when the road is passable".
-- v1 supports one kind: 'one_shot_passable' — fires once when falling water
-- reaches the passable limit, then the row is deleted. The kind column leaves
-- room for a later 'live_status' (Android silently-updating notification).
--
-- Access model: RLS is enabled with NO policies. Anon clients reach the table
-- only through the security-definer RPCs below (an anon delete policy would
-- let anyone wipe all rows; the endpoint URL is the only secret a subscriber
-- holds). The edge function reads/deletes with the service role.

create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  station_id text not null check (char_length(station_id) <= 32),
  kind text not null default 'one_shot_passable' check (kind in ('one_shot_passable')),
  endpoint text not null unique check (char_length(endpoint) <= 1024),
  p256dh text not null check (char_length(p256dh) <= 256),
  auth text not null check (char_length(auth) <= 256),
  locale text not null default 'da' check (locale in ('da', 'en', 'de', 'nl', 'fr', 'es', 'zh')),
  consumed_at timestamptz
);

alter table public.push_subscriptions enable row level security;

-- Upsert on endpoint: re-tapping the button re-arms an existing subscription
-- (fresh created_at, cleared consumed_at) instead of erroring on the unique key.
create or replace function public.push_subscribe(
  _endpoint text,
  _p256dh text,
  _auth text,
  _station_id text,
  _locale text
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Backstop against anon-driven table growth; real usage is tens of rows.
  if (select count(*) from push_subscriptions) >= 10000 then
    raise exception 'subscription limit reached';
  end if;

  insert into push_subscriptions (endpoint, p256dh, auth, station_id, locale)
  values (_endpoint, _p256dh, _auth, _station_id, _locale)
  on conflict (endpoint) do update set
    p256dh = excluded.p256dh,
    auth = excluded.auth,
    station_id = excluded.station_id,
    locale = excluded.locale,
    created_at = now(),
    consumed_at = null;
end;
$$;

create or replace function public.push_unsubscribe(_endpoint text) returns void
language sql
security definer
set search_path = public
as $$
  delete from push_subscriptions where endpoint = _endpoint;
$$;

revoke execute on function public.push_subscribe(text, text, text, text, text) from public;
revoke execute on function public.push_unsubscribe(text) from public;
grant execute on function public.push_subscribe(text, text, text, text, text) to anon, authenticated;
grant execute on function public.push_unsubscribe(text) to anon, authenticated;

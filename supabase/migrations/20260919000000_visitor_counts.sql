-- Cookieless, first-party visitor counting.
--
-- WHY THIS SHAPE
--
-- Legal: consent under the Danish cookie order (ePrivacy art. 5(3)) attaches to
-- *storing or reading information on the visitor's device* -- not to counting.
-- The client stores nothing: no cookie, no localStorage, no sessionStorage.
-- That is the entire reason this site needs no consent banner. Do not add any
-- client-side storage to the beacon (src/lib/analytics.ts) without revisiting it.
--
-- Privacy: knowledge is split in two, on purpose.
--   * api/visit.ts sees the IP and user-agent, hashes them with VISIT_PEPPER
--     (a Vercel env var that is NOT in this database) and discards them. They
--     are never written anywhere.
--   * This database sees only that 64-hex digest, mixes in a per-day random
--     salt, and truncates the result to 64 bits.
-- So a full DB dump cannot re-link a hash to an IP: the pepper is not here. And
-- after ~48 h the salt and the hashes are both deleted, leaving only aggregates.
--
--   visitor_hash = sha256( daily_salt || sha256( PEPPER || ip || '|' || ua ) )[0:8]
--
-- 64 bits dedups a few thousand visitors/day with negligible collisions and is
-- deliberately too short to work as a durable identifier.
--
-- Caveat worth stating plainly: a DELETE in Postgres does not shred bytes -- the
-- dead tuple lives until autovacuum, and in the WAL for its retention window.
-- "Unrecoverable" here is guaranteed by composition, not by the delete: salt and
-- hashes purge together, the hash is truncated, and the pepper is not in the DB.
--
-- EGRESS (see the "Egress budget" section in CLAUDE.md -- it is load-bearing)
-- This is one Supabase request per pageview, which is unavoidable: the browser
-- cannot hash its own IP. But the 6.29 GB blowout was *amplification* (~190k
-- realtime messages x ~25 KB), not request count. visit_record returns void, so
-- the response is a ~4-byte body plus ~250 B of headers -- about 300 B of
-- egress per pageview. At 5,000 pageviews/day that is ~45 MB/month, i.e. 0.9%
-- of the 5 GB budget, and it scales with people rather than with dataset size.
-- Three rules keep it that way:
--   1. visit_record returns void. Never make it return rows.
--   2. Nothing ever SELECTs these tables from the browser.
--   3. NONE OF THESE TABLES GO IN THE supabase_realtime PUBLICATION. Realtime
--      fan-out is exactly what blew the budget the first time.
--
-- No extension dependency: sha256() is core Postgres (PG11+) and
-- gen_random_uuid() is core (PG13+, already used by push_subscriptions).
-- pgcrypto is NOT enabled on this project, so digest()/hmac()/gen_random_bytes()
-- are unavailable -- do not reach for them.

-- ---------------------------------------------------------------------------
-- Permanent aggregates. Kept forever; this is what answers "how many have we had".
-- ---------------------------------------------------------------------------

create table public.visit_daily (
  day        date primary key,
  pageviews  bigint  not null default 0,
  uniques    integer not null default 0,
  updated_at timestamptz not null default now()
);

comment on column public.visit_daily.uniques is
  'Distinct visitors on this day. Summing across days gives visitor-DAYS, not people: a local who checks the road every morning is ~30 of them.';

-- (dim, value) rows rather than columns, so adding a dimension needs no
-- migration. Cardinality is closed server-side (api/visit.ts clamps, and
-- visit_record re-clamps): route <= 3, country <= 250, locale <= 8.
-- 'device' is allowed by the CHECK but deliberately unpopulated in v1 -- adding
-- it later is a client + function change only.
create table public.visit_breakdown_daily (
  day       date   not null,
  dim       text   not null check (dim in ('route','country','referrer','locale','device')),
  value     text   not null check (char_length(value) between 1 and 64),
  pageviews bigint not null default 0,
  primary key (day, dim, value)
);

create index visit_breakdown_daily_dim_idx on public.visit_breakdown_daily (dim, day desc);

-- ---------------------------------------------------------------------------
-- Ephemeral privacy data. Purged after ~48 h; never read by any client, ever.
-- ---------------------------------------------------------------------------

create table public.visitor_day_hash (
  day          date    not null,
  visitor_hash bytea   not null,           -- 8 bytes: truncated sha256
  hits         integer not null default 1, -- per-visitor flood cap
  primary key (day, visitor_hash)
);

create table public.visitor_salt (
  day  date  primary key,
  salt bytea not null check (octet_length(salt) = 32)
);

-- The anon key ships inside the browser bundle, so it is public. Without a
-- second, server-only secret, anyone who read the JS could POST to visit_record
-- directly and inflate the numbers. Seeded random here so the value is not in
-- git; read it once and copy it into Vercel as VISIT_TOKEN (see CLAUDE.md).
create table public.visit_ingest_secret (
  id    int primary key default 1 check (id = 1),
  token text not null
);

insert into public.visit_ingest_secret (id, token)
values (1, replace(gen_random_uuid()::text, '-', ''))
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- RLS. Two established patterns from this codebase.
-- ---------------------------------------------------------------------------

-- Pattern 1 -- anon-write tables: RLS on, NO policies at all. Anon reaches them
-- only through the security-definer RPC below. Same as push_subscriptions and
-- ops_alert_state. visit_ingest_secret especially must never be readable.
alter table public.visitor_day_hash    enable row level security;
alter table public.visitor_salt        enable row level security;
alter table public.visit_ingest_secret enable row level security;

-- Pattern 2 -- admin reads, enforced in the DB. Same as rule_change_log.
-- Nothing in the app reads these today: the numbers are queried from the
-- Supabase SQL editor (supabase/visitor_queries.sql), which runs as postgres
-- and bypasses RLS entirely. These policies exist so that (a) the tables are
-- never readable with the public anon key, and (b) a future /admin dashboard
-- works without another migration. Note the /admin router guard checks
-- auth.session but NOT auth.isAdmin, so RLS is the only real authorization.
alter table public.visit_daily           enable row level security;
alter table public.visit_breakdown_daily enable row level security;

create policy "admins read visit_daily"
  on public.visit_daily for select using (public.is_admin());

create policy "admins read visit breakdowns"
  on public.visit_breakdown_daily for select using (public.is_admin());

-- ---------------------------------------------------------------------------
-- The purge. Shreds everything that could link a hash back to a person.
-- ---------------------------------------------------------------------------

-- Keeping >= today - 1 means yesterday's salt survives through today, so the
-- oldest live salt is ~48 h old. Aggregates are untouched.
create or replace function public.purge_visitor_privacy_data() returns void
language sql
security definer
set search_path = public
as $$
  delete from visitor_day_hash
   where day < (now() at time zone 'Europe/Copenhagen')::date - 1;
  delete from visitor_salt
   where day < (now() at time zone 'Europe/Copenhagen')::date - 1;
$$;

revoke execute on function public.purge_visitor_privacy_data() from public;

-- ---------------------------------------------------------------------------
-- The write path. The only way anything gets into these tables.
-- ---------------------------------------------------------------------------

-- Anon-callable by design: api/visit.ts holds the anon key, not a service-role
-- key. So every argument is treated as hostile and every write is bounded:
--   * only TODAY's rows can ever be touched (the day comes from the server clock)
--   * one row per day in visit_daily, forever
--   * <= 50k rows/day in visitor_day_hash, and they are purged after ~48 h
--   * <= ~260 + 500 rows/day in visit_breakdown_daily
-- Hammering this can therefore inflate the counters, but cannot grow the
-- database. Inflation is acceptable; unbounded growth is not.
--
-- Every plpgsql variable is _-prefixed so it cannot shadow a column name inside
-- ON CONFLICT -- the classic plpgsql trap.
create or replace function public.visit_record(
  _token    text,   -- shared ingest secret; Vercel env VISIT_TOKEN
  _pre      text,   -- 64 hex chars: sha256(PEPPER || ip || '|' || ua)
  _route    text,
  _country  text,
  _referrer text,
  _locale   text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  max_uniques_per_day   constant integer := 50000;
  max_hits_per_visitor  constant integer := 200;
  max_pageviews_per_day constant bigint  := 2000000;
  max_referrers_per_day constant integer := 500;
  -- Europe/Copenhagen, never current_date: the server clock is UTC and the whole
  -- app displays Danish local time (src/lib/format.ts). With current_date the
  -- owner's "yesterday" would split across two rows for two hours every day.
  _day     date := (now() at time zone 'Europe/Copenhagen')::date;
  _salt    bytea;
  _fresh   boolean := false;
  _vh      bytea;
  _hits    integer;
  _uniques integer;
  _new     boolean := false;
begin
  -- 1. Authorise. A bad token is a silent no-op, never an error: this endpoint
  --    must not become an oracle that says when an attacker guessed right.
  if _token is null
     or _token <> (select token from visit_ingest_secret where id = 1) then
    return;
  end if;

  -- 2. Input hygiene. api/visit.ts already normalises all of this; we redo it
  --    here because the RPC is reachable with the public anon key alone.
  if _pre is null or _pre !~ '^[0-9a-f]{64}$' then return; end if;

  _route   := case when _route in ('/', '/status') then _route else 'other' end;
  _country := case when _country ~ '^[A-Z]{2}$' then _country else 'ZZ' end;
  _locale  := case when _locale in ('da','en','de','nl','fr','es','zh')
                   then _locale else 'other' end;
  -- Referrer is a bare hostname by the time it gets here. Strip anything that
  -- is not host-shaped and cap the length, so a crafted value cannot bloat a row.
  _referrer := coalesce(
    nullif(lower(left(regexp_replace(coalesce(_referrer, ''), '[^a-zA-Z0-9.-]', '', 'g'), 64)), ''),
    'direct');

  -- 3. Today's salt, created lazily on the first hit of the day. Two UUIDs give
  --    32 bytes of CSPRNG without pgcrypto.
  select salt into _salt from visitor_salt where day = _day;
  if _salt is null then
    insert into visitor_salt (day, salt)
    values (_day, decode(replace(gen_random_uuid()::text, '-', '')
                      || replace(gen_random_uuid()::text, '-', ''), 'hex'))
    on conflict (day) do nothing;
    select salt into _salt from visitor_salt where day = _day;
    _fresh := true;
  end if;
  if _salt is null then return; end if;

  -- 4. Day rolled over, so shred anything older than ~48 h. Runs once a day and
  --    is free on the other ~5,000 calls. This is the PRIMARY purge trigger --
  --    it needs no pg_cron, no edge function and no dashboard integration.
  if _fresh then perform public.purge_visitor_privacy_data(); end if;

  -- 5. The pseudonym. substring(), not left(), which is text-only.
  _vh := substring(sha256(_salt || decode(_pre, 'hex')) from 1 for 8);

  -- 6. Dedup + per-visitor flood cap, under a hard daily row cap.
  select uniques into _uniques from visit_daily where day = _day;
  _uniques := coalesce(_uniques, 0);
  if _uniques < max_uniques_per_day then
    insert into visitor_day_hash (day, visitor_hash, hits) values (_day, _vh, 1)
    on conflict (day, visitor_hash)
      do update set hits = least(visitor_day_hash.hits + 1, 1000000)
    returning hits into _hits;
    -- hits = 1 means the row was just inserted: exact, and it avoids the
    -- xmax = 0 idiom for telling an insert from an update.
    _new := (_hits = 1);
    -- One IP+UA has been counted enough for one day. Stop counting it at all,
    -- pageviews included -- that is what makes a refresh loop harmless.
    if _hits > max_hits_per_visitor then return; end if;
  end if;

  -- 7. The permanent aggregate. One hot row per day; fine at this scale.
  insert into visit_daily (day, pageviews, uniques)
  values (_day, 1, case when _new then 1 else 0 end)
  on conflict (day) do update set
    pageviews  = visit_daily.pageviews
               + case when visit_daily.pageviews >= max_pageviews_per_day then 0 else 1 end,
    uniques    = visit_daily.uniques + case when _new then 1 else 0 end,
    updated_at = now();

  -- 8a. The three closed-cardinality dimensions: unconditional upsert.
  insert into visit_breakdown_daily as b (day, dim, value, pageviews)
  select _day, d.dim, d.value, 1
    from (values ('route', _route), ('country', _country), ('locale', _locale)) as d(dim, value)
  on conflict (day, dim, value) do update set pageviews = b.pageviews + 1;

  -- 8b. Referrer is the only open-ended value, so it is the only one that needs
  --     a row cap. The count() runs only when a genuinely new host shows up,
  --     which is a handful of times a day.
  update visit_breakdown_daily set pageviews = pageviews + 1
   where day = _day and dim = 'referrer' and value = _referrer;
  if not found
     and (select count(*) from visit_breakdown_daily
           where day = _day and dim = 'referrer') < max_referrers_per_day then
    insert into visit_breakdown_daily (day, dim, value, pageviews)
    values (_day, 'referrer', _referrer, 1)
    on conflict (day, dim, value) do update
      set pageviews = visit_breakdown_daily.pageviews + 1;
  end if;
end;
$$;

revoke execute on function public.visit_record(text, text, text, text, text, text) from public;
grant  execute on function public.visit_record(text, text, text, text, text, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Secondary purge trigger: pg_cron, if it happens to exist.
-- ---------------------------------------------------------------------------
-- Belt and braces only -- the primary trigger is inside visit_record above.
-- Guarded the same way as 20260712000000_cron_5min.sql, because pg_cron is NOT
-- installed by any migration (only by the manual supabase/setup_cron.sql) and
-- the schedule may instead live in the Supabase dashboard Cron integration.
-- Every step is non-fatal: a migration must never fail over an optional extra.
-- 03:17 avoids the minute-0 collisions with the */5 fetch-dmi-data job.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin
      perform cron.unschedule('purge-visitor-privacy');
    exception when others then null;  -- not scheduled yet; fine
    end;
    begin
      perform cron.schedule('purge-visitor-privacy', '17 3 * * *',
                            $q$ select public.purge_visitor_privacy_data(); $q$);
    exception when others then null;  -- no grant on cron; the primary path covers it
    end;
  end if;
end $$;

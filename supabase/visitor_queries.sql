-- Visitor numbers: paste any one of these into the Supabase SQL editor.
--
-- HOW TO USE. Supabase Dashboard -> SQL Editor -> paste one block -> Run.
-- Each block is standalone, so there is no need to run them in order or to run
-- the whole file. The SQL editor connects as `postgres`, which bypasses RLS, so
-- these work without any login or policy juggling.
--
-- This file is NOT a migration. It lives here the same way setup_cron.sql does:
-- a manual, run-when-you-need-it file. Never move it into migrations/.
--
-- WHAT THE NUMBERS MEAN, AND WHAT THEY DO NOT
--
--   pageviews    Every counted page load. A visitor who opens the site three
--                times in a day is 3 pageviews.
--
--   uniques      Distinct visitors on ONE day. Summing this across days gives
--                VISITOR-DAYS, not people -- a local who checks the road every
--                morning is about 30 visitor-days in a month, not 30 people.
--                The monthly query below labels the column honestly for that
--                reason. There is deliberately no way to count distinct people
--                across days: that would need a durable identifier on the
--                device, which is exactly what this design refuses to store.
--
--   Accuracy     These are a floor, not a census.
--                * Ad-blockers suppress some beacons, so real traffic is higher.
--                * Bots are filtered fairly aggressively, which also drops a few
--                  real visits. Under-counting is the deliberate choice.
--                * Two people on one home wifi with identical phones collapse
--                  into one visitor; one person who switches from wifi to mobile
--                  data mid-visit becomes two. These two errors partly cancel.
--                * Only "/" and "/status" are counted. /admin, /login and the
--                  /display shop kiosk never are.
--
-- Dates are Europe/Copenhagen throughout, matching the rest of the app. Do not
-- swap in current_date: the server clock is UTC, which would split "yesterday"
-- across two rows for two hours every day.


-- ===========================================================================
-- 1. HEADLINE TOTALS -- all time
-- ===========================================================================
select
  sum(pageviews)           as pageviews,
  sum(uniques)             as visitor_days,
  count(*)                 as days_with_data,
  min(day)                 as first_day,
  max(day)                 as last_day,
  round(avg(pageviews))    as avg_pageviews_per_day
from public.visit_daily;


-- ===========================================================================
-- 2. THE QUICK LOOK -- today, last 7 days, last 30 days, all time
-- ===========================================================================
with d as (select (now() at time zone 'Europe/Copenhagen')::date as today)
select
  'Today'        as period,
  coalesce(sum(v.pageviews), 0) as pageviews,
  coalesce(sum(v.uniques), 0)   as visitors
from d left join public.visit_daily v on v.day = d.today
union all
select 'Last 7 days',
  coalesce(sum(v.pageviews), 0), coalesce(sum(v.uniques), 0)
from d left join public.visit_daily v on v.day > d.today - 7
union all
select 'Last 30 days',
  coalesce(sum(v.pageviews), 0), coalesce(sum(v.uniques), 0)
from d left join public.visit_daily v on v.day > d.today - 30
union all
select 'All time',
  coalesce(sum(pageviews), 0), coalesce(sum(uniques), 0)
from public.visit_daily;
-- Note: "visitors" is exact for Today, and is visitor-DAYS for the longer
-- periods (see the header).


-- ===========================================================================
-- 3. BY MONTH -- the "how many have we had" view
-- ===========================================================================
select
  to_char(date_trunc('month', day), 'YYYY-MM') as month,
  sum(pageviews)  as pageviews,
  sum(uniques)    as visitor_days,
  count(*)        as days_with_data,
  round(avg(pageviews)) as avg_per_day
from public.visit_daily
group by 1
order by 1 desc;


-- ===========================================================================
-- 4. BY DAY -- last 30 days, newest first
-- ===========================================================================
select day, pageviews, uniques as visitors
from public.visit_daily
where day > (now() at time zone 'Europe/Copenhagen')::date - 30
order by day desc;


-- ===========================================================================
-- 5. BUSIEST DAYS EVER -- top 20
-- ===========================================================================
select day, pageviews, uniques as visitors
from public.visit_daily
order by pageviews desc
limit 20;


-- ===========================================================================
-- 6. WHERE VISITORS COME FROM -- countries, last 30 days
-- ===========================================================================
-- ZZ = country could not be determined. Change the interval to taste, or drop
-- the WHERE clause entirely for all time.
select value as country, sum(pageviews) as pageviews
from public.visit_breakdown_daily
where dim = 'country'
  and day > (now() at time zone 'Europe/Copenhagen')::date - 30
group by 1
order by 2 desc
limit 25;


-- ===========================================================================
-- 7. HOW THEY GOT HERE -- referrers, last 30 days
-- ===========================================================================
-- 'direct' covers typed URLs, bookmarks, QR scans, most app links, and anything
-- that strips the referrer -- which on mobile is a lot. Only the hostname is
-- ever stored, never the full referring URL.
select value as referrer, sum(pageviews) as pageviews
from public.visit_breakdown_daily
where dim = 'referrer'
  and day > (now() at time zone 'Europe/Copenhagen')::date - 30
group by 1
order by 2 desc
limit 25;


-- ===========================================================================
-- 8. WHICH LANGUAGE THEY USE -- last 30 days
-- ===========================================================================
-- Whether the 7 translations are earning their keep. This is the locale the app
-- actually rendered in, which is the browser's language unless the visitor
-- picked one from the switcher.
select value as locale, sum(pageviews) as pageviews,
  round(100.0 * sum(pageviews) / nullif(sum(sum(pageviews)) over (), 0), 1) as pct
from public.visit_breakdown_daily
where dim = 'locale'
  and day > (now() at time zone 'Europe/Copenhagen')::date - 30
group by 1
order by 2 desc;


-- ===========================================================================
-- 9. WHICH PAGE -- last 30 days
-- ===========================================================================
-- "/" is the public front page; "/status" is the parked verdict page.
select value as route, sum(pageviews) as pageviews
from public.visit_breakdown_daily
where dim = 'route'
  and day > (now() at time zone 'Europe/Copenhagen')::date - 30
group by 1
order by 2 desc;


-- ===========================================================================
-- 10. PRIVACY HEALTH CHECK -- run occasionally
-- ===========================================================================
-- The two tables below are the only ones that ever hold anything derived from a
-- person, and they must never contain more than today and yesterday. If either
-- shows an older date, the purge has stopped running: check that visit_record
-- is still being called (it purges on the first hit of each day), and look for
-- a 'purge-visitor-privacy' job in cron.job.
select 'visitor_salt' as tbl, min(day) as oldest, max(day) as newest, count(*) as rows
from public.visitor_salt
union all
select 'visitor_day_hash', min(day), max(day), count(*)
from public.visitor_day_hash;

-- Force a purge by hand if one is ever needed:
--   select public.purge_visitor_privacy_data();


-- ===========================================================================
-- 11. THE INGEST TOKEN -- only needed when setting up or rotating
-- ===========================================================================
-- This is the value that belongs in Vercel as VISIT_TOKEN. It is a shared
-- secret: the public anon key alone cannot forge counts without it.
--   select token from public.visit_ingest_secret;
--
-- To rotate it, update the row and then change the Vercel env var to match.
-- Counting stops in the gap between the two, so do them back to back:
--   update public.visit_ingest_secret
--      set token = replace(gen_random_uuid()::text, '-', '')
--    where id = 1
--   returning token;

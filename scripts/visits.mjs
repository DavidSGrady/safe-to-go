// Read the visitor numbers from the command line.
//
// WHY THIS EXISTS. The numbers live in Postgres and there is deliberately no
// dashboard and nothing on the site. The obvious way to read them is the
// Supabase SQL editor -- but that needs a dashboard login to the project, which
// not everyone on this project has. This script needs only a personal access
// token: it goes through the Management API's query endpoint, which is the same
// thing the dashboard's own SQL editor calls.
//
// USAGE
//   npm run visits                 the standard report
//   npm run visits -- --check      is counting actually working? + privacy check
//   npm run visits -- --sql "select ..."    any SQL you like
//
// THE TOKEN. Create one at https://supabase.com/dashboard/account/tokens (or ask
// someone who can). Then either:
//   * add  SUPABASE_ACCESS_TOKEN=sbp_...  to .env  (gitignored -- easiest), or
//   * set it in the environment for one command.
// It is a powerful credential: full Management API access to every project the
// issuing account can reach. Revoke it when you no longer need it.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Minimal .env reader -- we only need two keys and dotenv isn't a dependency. */
function fromEnvFile(key) {
  for (const file of ['.env.local', '.env']) {
    try {
      const line = readFileSync(resolve(root, file), 'utf8')
        .split('\n')
        .find((l) => l.trim().startsWith(`${key}=`))
      if (line) return line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')
    } catch {
      // file absent; try the next one
    }
  }
  return undefined
}

const TOKEN = process.env.SUPABASE_ACCESS_TOKEN ?? fromEnvFile('SUPABASE_ACCESS_TOKEN')

// The project ref is not a secret -- it is the subdomain of the public Supabase
// URL that already ships in the browser bundle.
const REF =
  process.env.SUPABASE_PROJECT_REF ??
  (fromEnvFile('VITE_SUPABASE_URL') ?? '').match(/https:\/\/([a-z0-9]+)\.supabase\.co/)?.[1] ??
  'eslsgbnrrpjrcqpupxhp'

if (!TOKEN) {
  console.error(
    'No access token.\n\n' +
      '  Add this line to .env (it is gitignored):\n' +
      '    SUPABASE_ACCESS_TOKEN=sbp_...\n\n' +
      '  Get one at https://supabase.com/dashboard/account/tokens\n' +
      '  (or ask whoever administers the Supabase project).',
  )
  process.exit(1)
}

async function q(sql) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  })
  const text = await res.text()
  if (res.status === 401 || res.status === 403) {
    console.error(
      `\nThe token was rejected (HTTP ${res.status}).\n` +
        'It is probably expired, revoked, or belongs to an account without access\n' +
        `to project ${REF}.\n`,
    )
    process.exit(1)
  }
  if (!res.ok) {
    console.error(`\nQuery failed (HTTP ${res.status}): ${text.slice(0, 400)}\n`)
    process.exit(1)
  }
  return JSON.parse(text)
}

const n = (v) => (v == null ? '0' : Number(v).toLocaleString('da-DK'))

function table(rows, cols) {
  if (!rows?.length) return '  (nothing yet)'
  const keys = cols ?? Object.keys(rows[0])
  const w = keys.map((k) => Math.max(k.length, ...rows.map((r) => String(r[k] ?? '').length)))
  const line = (cells) => '  ' + cells.map((c, i) => String(c).padEnd(w[i])).join('   ')
  return [line(keys), line(w.map((x) => '-'.repeat(x))), ...rows.map((r) => line(keys.map((k) => r[k] ?? '')))].join('\n')
}

const args = process.argv.slice(2)
const sqlFlag = args.indexOf('--sql')

if (sqlFlag !== -1) {
  const rows = await q(args[sqlFlag + 1])
  console.log(rows.length ? table(rows) : '(no rows)')
  process.exit(0)
}

if (args.includes('--check')) {
  const [{ pageviews, days }] = await q(
    'select coalesce(sum(pageviews),0) as pageviews, count(*) as days from public.visit_daily',
  )
  console.log('\nIs counting working?\n')
  if (Number(pageviews) === 0) {
    console.log('  NOTHING RECORDED YET.\n')
    console.log('  If the site has had traffic since this shipped, the most likely cause is')
    console.log('  a VISIT_TOKEN mismatch: the value in Vercel must match the database.')
    console.log('  Compare them:')
    console.log('    select token from public.visit_ingest_secret;')
    console.log('  against Vercel -> Settings -> Environment Variables -> VISIT_TOKEN.')
    console.log('  Remember env var changes need a redeploy to take effect.\n')
    console.log('  (A fresh deploy with no visitors yet would also look like this.)')
  } else {
    console.log(`  Yes -- ${n(pageviews)} pageviews recorded across ${n(days)} day(s).`)
  }

  const priv = await q(
    "select 'visitor_salt' as tbl, min(day)::text as oldest, count(*)::int as rows from public.visitor_salt" +
      " union all select 'visitor_day_hash', min(day)::text, count(*)::int from public.visitor_day_hash",
  )
  console.log('\nPrivacy data (must never be older than yesterday):\n')
  console.log(table(priv))
  console.log('')
  process.exit(0)
}

// ---- the standard report ----------------------------------------------------

const [totals] = await q(
  `select coalesce(sum(pageviews),0) as pageviews, coalesce(sum(uniques),0) as visitor_days,
          count(*) as days, min(day)::text as first_day, max(day)::text as last_day
     from public.visit_daily`,
)

const [recent] = await q(
  `with d as (select (now() at time zone 'Europe/Copenhagen')::date as today)
   select
     (select coalesce(sum(pageviews),0) from public.visit_daily, d where day = d.today) as today_pv,
     (select coalesce(sum(uniques),0)   from public.visit_daily, d where day = d.today) as today_v,
     (select coalesce(sum(pageviews),0) from public.visit_daily, d where day > d.today - 7)  as w_pv,
     (select coalesce(sum(uniques),0)   from public.visit_daily, d where day > d.today - 7)  as w_v,
     (select coalesce(sum(pageviews),0) from public.visit_daily, d where day > d.today - 30) as m_pv,
     (select coalesce(sum(uniques),0)   from public.visit_daily, d where day > d.today - 30) as m_v`,
)

console.log('\n=============================================')
console.log(' Kør til Mandø — visitors')
console.log('=============================================\n')

if (Number(totals.pageviews) === 0) {
  console.log('  Nothing recorded yet.')
  console.log('  Run  npm run visits -- --check  to find out whether that is expected.\n')
  process.exit(0)
}

console.log(`  Today          ${n(recent.today_pv).padStart(9)} views   ${n(recent.today_v).padStart(8)} visitors`)
console.log(`  Last 7 days    ${n(recent.w_pv).padStart(9)} views   ${n(recent.w_v).padStart(8)} visitor-days`)
console.log(`  Last 30 days   ${n(recent.m_pv).padStart(9)} views   ${n(recent.m_v).padStart(8)} visitor-days`)
console.log(`  All time       ${n(totals.pageviews).padStart(9)} views   ${n(totals.visitor_days).padStart(8)} visitor-days`)
console.log(`\n  ${totals.days} day(s) of data, ${totals.first_day} to ${totals.last_day}`)

const months = await q(
  `select to_char(date_trunc('month', day), 'YYYY-MM') as month,
          sum(pageviews)::int as views, sum(uniques)::int as visitor_days,
          count(*)::int as days, round(avg(pageviews))::int as avg_day
     from public.visit_daily group by 1 order by 1 desc limit 24`,
)
console.log('\nBy month\n')
console.log(table(months))

const days = await q(
  `select day::text as day, pageviews::int as views, uniques::int as visitors
     from public.visit_daily
    where day > (now() at time zone 'Europe/Copenhagen')::date - 14
    order by day desc`,
)
console.log('\nLast 14 days\n')
console.log(table(days))

for (const [dim, label] of [
  ['country', 'Countries'],
  ['referrer', 'Where they came from'],
  ['locale', 'Languages'],
  ['route', 'Pages'],
]) {
  const rows = await q(
    `select value, sum(pageviews)::int as views from public.visit_breakdown_daily
      where dim = '${dim}' and day > (now() at time zone 'Europe/Copenhagen')::date - 30
      group by 1 order by 2 desc limit 12`,
  )
  console.log(`\n${label} (last 30 days)\n`)
  console.log(table(rows))
}

console.log(
  '\nNote: "visitors" is exact for a single day. Summed over a longer period it is\n' +
    'visitor-DAYS -- someone checking the road every morning is ~30 of them, not 30\n' +
    'people. Counting distinct people across days would need a durable identifier on\n' +
    'the device, which is exactly what this design refuses to store.\n' +
    'Ad-blockers suppress some beacons, so treat every number as a floor.\n',
)

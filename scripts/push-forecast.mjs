// Fetch DMI's station prognosis from NinJo and push it to Supabase.
//
// WHY THIS EXISTS. www.dmi.dk's NinJo endpoint answers Supabase's edge IPs with
// "403 Access from your location is not allowed" (since 2026-10-22), so the
// fetch-dmi-data cron can no longer refresh the primary forecast. This script
// does the fetch from a machine with a Danish IP and hands the raw response to
// the `push-forecast` edge function, which validates and stores it.
//
// USAGE
//   npm run push-forecast            one run (what the scheduler calls)
//   npm run push-forecast -- --dry   fetch and validate only; push nothing
//
// SETUP (once per machine)
//   .env needs  VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY  (already there) and
//               FORECAST_PUSH_TOKEN=...   (the value of the Supabase secret of
//               the same name; nothing else on this machine can write to the DB)
//   Schedule it every 45 minutes (just under the site's 60-min stale-banner threshold;
//   it is only a fallback). Control it with `npm run pusher:on|off|status|now`. Windows (hidden window, no console flash):
//     schtasks or Register-ScheduledTask running
//       conhost.exe --headless "<path to node.exe>" "<repo>\scripts\push-forecast.mjs"
//   Every run appends one line to ~/.safe-to-go/push-forecast.log (last 300 kept).
//
// Exit code is non-zero if nothing could be fetched or the push failed, so a
// scheduler / monitor can see failures.

import { readFileSync, appendFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, join } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Minimal .env reader -- dotenv isn't a dependency. */
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
const env = (key) => process.env[key] ?? fromEnvFile(key)

const SUPABASE_URL = env('VITE_SUPABASE_URL')
const ANON_KEY = env('VITE_SUPABASE_ANON_KEY')
const PUSH_TOKEN = env('FORECAST_PUSH_TOKEN')
const NINJO = env('NINJO_BASE_URL') ?? 'https://www.dmi.dk/NinJo2DmiDk/ninjo2dmidk'
// NinJo/tidewater stationIds: Mandø, Ribe Kammersluse. Keep in sync with
// supabase/functions/push-forecast.
const STATIONS = [
  { name: 'Mandø', tideId: '25346' },
  { name: 'Ribe', tideId: '25343' },
]

const dry = process.argv.includes('--dry')

// ---- log: one line per run, kept short ---------------------------------------
const LOG_DIR = join(homedir(), '.safe-to-go')
const LOG_FILE = join(LOG_DIR, 'push-forecast.log')
function log(line) {
  const text = `${new Date().toISOString()} ${line}`
  console.log(text)
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    appendFileSync(LOG_FILE, text + '\n')
    const lines = readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean)
    if (lines.length > 400) writeFileSync(LOG_FILE, lines.slice(-300).join('\n') + '\n')
  } catch {
    // logging must never break a run
  }
}

function fail(msg) {
  log(`FAIL ${msg}`)
  process.exit(1)
}

if (!SUPABASE_URL || !ANON_KEY) fail('missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY in .env')
if (!dry && !PUSH_TOKEN) fail('missing FORECAST_PUSH_TOKEN in .env')

// ---- fetch from NinJo --------------------------------------------------------
const series = []
const fetchErrors = []
for (const s of STATIONS) {
  try {
    const res = await fetch(`${NINJO}?cmd=odj&stations=${s.tideId}&datatype=fcst`, {
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json = await res.json()
    const el = Array.isArray(json) ? json[0] : null
    if (!el || !Array.isArray(el.values) || !el.generatedTime) throw new Error('unexpected response shape')
    series.push({ stationId: String(el.stationId ?? s.tideId), generatedTime: el.generatedTime, values: el.values })
  } catch (err) {
    fetchErrors.push(`${s.name}: ${err.message ?? err}`)
  }
}
if (series.length === 0) fail(`NinJo fetch failed for every station (${fetchErrors.join('; ')})`)

if (dry) {
  log(`DRY ok ${series.map((x) => `${x.stationId}@${x.generatedTime} ${x.values.length}pts`).join(' ')}`)
  process.exit(0)
}

// ---- push --------------------------------------------------------------------
let res
try {
  res = await fetch(`${SUPABASE_URL}/functions/v1/push-forecast`, {
    method: 'POST',
    headers: {
      apikey: ANON_KEY,
      Authorization: `Bearer ${ANON_KEY}`,
      'x-ingest-token': PUSH_TOKEN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ series }),
    signal: AbortSignal.timeout(60_000),
  })
} catch (err) {
  fail(`push request failed: ${err.message ?? err}`)
}
const text = await res.text()
if (!res.ok) fail(`push HTTP ${res.status}: ${text.slice(0, 200)}`)

let results
try {
  results = JSON.parse(text).results
} catch {
  fail(`push returned non-JSON: ${text.slice(0, 200)}`)
}
const summary = results
  .map((r) => `${r.tideId}:${r.action}${r.rows ? `(${r.rows})` : ''}${r.reason ? `[${r.reason}]` : ''}`)
  .join(' ')
const rejected = results.filter((r) => r.action === 'rejected')
if (rejected.length > 0 || fetchErrors.length > 0) {
  fail(`${summary}${fetchErrors.length ? ` fetchErrors=${fetchErrors.join('; ')}` : ''}`)
}
log(`ok ${summary}`)

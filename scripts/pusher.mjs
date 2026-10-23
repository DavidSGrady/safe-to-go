// Start / stop / inspect the Windows scheduled task that runs push-forecast.mjs.
//
//   npm run pusher -- status    is it on? when did it last run, what is stored?
//   npm run pusher -- on        enable the schedule (and run once right away)
//   npm run pusher -- off       disable the schedule; nothing runs until `on`
//   npm run pusher -- now       run it once, now, without changing the schedule
//
// Shortcuts: `npm run pusher:on`, `pusher:off`, `pusher:status`, `pusher:now`.
//
// While it is off the forecast on the site stops being refreshed (the Supabase
// cron cannot fetch it -- see the geo-block note in CLAUDE.md), and the amber
// "forecast is old" banner appears once the stored run is over an hour old.
// Windows only; the task is created once by hand (see CLAUDE.md), this script
// just flips it.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const TASK = 'SafeToGo push-forecast'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function ps(command) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function taskInfo() {
  try {
    const out = ps(
      `$t = Get-ScheduledTask -TaskName '${TASK}' -ErrorAction Stop; ` +
        `$i = Get-ScheduledTaskInfo -TaskName '${TASK}'; ` +
        `[pscustomobject]@{ state = $t.State.ToString(); ` +
        `last = $i.LastRunTime.ToString('o'); result = $i.LastTaskResult; ` +
        `next = $i.NextRunTime.ToString('o'); ` +
        `every = $t.Triggers[0].Repetition.Interval } | ConvertTo-Json -Compress`,
    )
    return JSON.parse(out)
  } catch {
    return null
  }
}

const local = (iso) =>
  new Intl.DateTimeFormat('da-DK', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    timeZone: 'Europe/Copenhagen',
  }).format(new Date(iso))

function fromEnvFile(key) {
  for (const file of ['.env.local', '.env']) {
    try {
      const line = readFileSync(resolve(root, file), 'utf8').split('\n').find((l) => l.trim().startsWith(`${key}=`))
      if (line) return line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')
    } catch { /* next */ }
  }
  return undefined
}

/** Age of the forecast run stored in prod, from the public anon key (read-only). */
async function storedRun() {
  const url = fromEnvFile('VITE_SUPABASE_URL')
  const key = fromEnvFile('VITE_SUPABASE_ANON_KEY')
  if (!url || !key) return null
  try {
    const res = await fetch(
      `${url}/rest/v1/water_level_forecast?select=generated_at&station_id=eq.9006701&source=eq.dmi_station&order=generated_at.desc&limit=1`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) },
    )
    const rows = await res.json()
    return rows?.[0]?.generated_at ?? null
  } catch {
    return null
  }
}

async function status() {
  const t = taskInfo()
  if (!t) {
    console.log(`Scheduled task "${TASK}" not found on this machine.`)
    return
  }
  const on = t.state !== 'Disabled'
  console.log(`\n  Pusher:        ${on ? 'ON' : 'OFF'}${on && t.every ? `  (every ${t.every.replace('PT', '').toLowerCase()})` : ''}`)
  console.log(`  Last run:      ${local(t.last)}  ${t.result === 0 ? '(ok)' : `(exit code ${t.result})`}`)
  if (on) console.log(`  Next run:      ${local(t.next)}`)
  const run = await storedRun()
  if (run) {
    const min = Math.round((Date.now() - Date.parse(run)) / 60_000)
    console.log(`  Stored run:    ${local(run)}  (${min} min old${min > 60 ? ' -- banner is showing on the site' : ''})`)
  }
  try {
    const lines = readFileSync(join(homedir(), '.safe-to-go', 'push-forecast.log'), 'utf8').trim().split('\n')
    console.log(`  Last log line: ${lines[lines.length - 1]}`)
  } catch { /* no log yet */ }
  console.log('')
}

const cmd = process.argv[2] ?? 'status'

if (!taskInfo() && cmd !== 'status') {
  console.error(`Scheduled task "${TASK}" not found on this machine.`)
  process.exit(1)
}

try {
  if (cmd === 'on') {
    ps(`Enable-ScheduledTask -TaskName '${TASK}' | Out-Null; Start-ScheduledTask -TaskName '${TASK}'`)
    console.log('Pusher is ON -- ran once just now.')
    await new Promise((r) => setTimeout(r, 6000))
    await status()
  } else if (cmd === 'off') {
    ps(`Disable-ScheduledTask -TaskName '${TASK}' | Out-Null`)
    console.log('Pusher is OFF. Run  npm run pusher:on  to turn it back on.')
    await status()
  } else if (cmd === 'now') {
    ps(`Start-ScheduledTask -TaskName '${TASK}'`)
    console.log('Ran once.')
    await new Promise((r) => setTimeout(r, 6000))
    await status()
  } else if (cmd === 'status') {
    await status()
  } else {
    console.error('Usage: npm run pusher -- status | on | off | now')
    process.exit(1)
  }
} catch (err) {
  console.error(String(err.stderr || err.message || err).trim())
  process.exit(1)
}

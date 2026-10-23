// Supabase Edge Function: accept DMI's station prognosis pushed from a machine
// with a Danish IP, and store it as the `dmi_station` forecast.
//
// WHY THIS EXISTS. On 2026-10-22 www.dmi.dk started answering the NinJo
// endpoint with "403 Access from your location is not allowed" to Supabase's
// edge IPs (every region), so fetch-dmi-data could no longer refresh the
// primary forecast. The open-data API has no equivalent series (only raw DKSS
// grid models, ~10-25 cm off the gauge), so the fetch has to happen from
// inside Denmark. scripts/push-forecast.mjs does that on a schedule and posts
// the raw NinJo response here. fetch-dmi-data keeps trying NinJo itself, so if
// DMI ever lifts the block nothing needs undoing -- whichever run is younger
// wins (see the generated_at guard below).
//
// AUTH. The Supabase gateway wants a JWT (the public anon key, which the pusher
// sends), but that is not a secret. The real gate is the `x-ingest-token` header
// compared against the FORECAST_PUSH_TOKEN secret. The service-role key never
// leaves Supabase -- the pusher doesn't have it.
//
// Request:  POST  { series: [ <NinJo fcst element as served: { stationId,
//                    generatedTime, values: [{ time, value }] }> ] }
// Response: { results: [{ tideId, obsId, action, rows, ... }] }

import { createClient } from 'npm:@supabase/supabase-js@2'

const PUSH_TOKEN = Deno.env.get('FORECAST_PUSH_TOKEN') ?? ''
const SOURCE_STATION = 'dmi_station'

// NinJo/tidewater stationId -> observation stationId (how rows are keyed in
// Postgres). Keep in sync with STATIONS in fetch-dmi-data.
const STATIONS: Record<string, string> = {
  '25346': '9007101', // Mandø
  '25343': '9006701', // Ribe Kammersluse
}

/** A real run is ~700 points (5 days at 10 min); anything tiny is not one. */
const MIN_POINTS = 100
/** Plausible gauge range in cm; anything outside is garbage, not a surge. */
const LEVEL_MIN_CM = -500
const LEVEL_MAX_CM = 1000
/** Same shape filter as fetch-dmi-data's fetchStationPrognosis -- see there. */
const SPIKE_CM = 20

function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder()
  const x = enc.encode(a)
  const y = enc.encode(b)
  let diff = x.length ^ y.length
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0)
  return diff === 0
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

interface Result {
  tideId: string
  obsId?: string
  action: 'written' | 'skipped' | 'rejected'
  reason?: string
  rows?: number
  dropped?: number
  generatedAt?: string
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)
  if (!PUSH_TOKEN) return json({ error: 'FORECAST_PUSH_TOKEN is not set' }, 503)
  if (!safeEqual(req.headers.get('x-ingest-token') ?? '', PUSH_TOKEN)) {
    return json({ error: 'unauthorized' }, 401)
  }

  let body: { series?: unknown }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'invalid JSON' }, 400)
  }
  if (!Array.isArray(body.series)) return json({ error: 'expected { series: [...] }' }, 400)

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  )

  const now = Date.now()
  const results: Result[] = []

  for (const raw of body.series as Array<Record<string, unknown>>) {
    const tideId = String(raw?.stationId ?? '')
    const obsId = STATIONS[tideId]
    if (!obsId) {
      results.push({ tideId, action: 'rejected', reason: 'unknown station' })
      continue
    }

    try {
      const generatedMs = Date.parse(String(raw.generatedTime ?? ''))
      if (!Number.isFinite(generatedMs)) {
        results.push({ tideId, obsId, action: 'rejected', reason: 'bad generatedTime' })
        continue
      }
      // A run "generated" in the future means a broken clock or payload.
      if (generatedMs > now + 10 * 60_000) {
        results.push({ tideId, obsId, action: 'rejected', reason: 'generatedTime in the future' })
        continue
      }
      const generatedAt = new Date(generatedMs).toISOString()

      const values = Array.isArray(raw.values) ? (raw.values as Array<{ time?: unknown; value?: unknown }>) : []
      const pts: Array<{ t: number; v: number }> = []
      for (const v of values) {
        if (typeof v?.value !== 'number' || !Number.isFinite(v.value)) continue
        if (v.value < LEVEL_MIN_CM || v.value > LEVEL_MAX_CM) continue
        const t = Date.parse(String(v.time ?? ''))
        if (Number.isFinite(t)) pts.push({ t, v: v.value })
      }
      pts.sort((a, b) => a.t - b.t)
      if (pts.length < MIN_POINTS) {
        results.push({ tideId, obsId, action: 'rejected', reason: `only ${pts.length} usable points` })
        continue
      }

      // Never regress: if a younger-or-equal run is already stored (fetch-dmi-data
      // got through, or we already pushed this one), leave it alone. Equal means
      // "same run again" -- rewriting it would only churn the table.
      const { data: newest, error: readError } = await supabase
        .from('water_level_forecast')
        .select('generated_at')
        .eq('station_id', obsId)
        .eq('source', SOURCE_STATION)
        .order('generated_at', { ascending: false })
        .limit(1)
      if (readError) throw new Error(`read newest run: ${readError.message}`)
      const storedMs = newest?.[0]?.generated_at ? Date.parse(newest[0].generated_at) : NaN
      if (Number.isFinite(storedMs) && storedMs >= generatedMs) {
        results.push({
          tideId,
          obsId,
          action: 'skipped',
          reason: 'stored run is as new or newer',
          generatedAt: new Date(storedMs).toISOString(),
        })
        continue
      }

      // Shape filter, identical to fetch-dmi-data: reject points far off their
      // own run's curve (midpoint of neighbours, linear extrapolation at the
      // ends). No head skip -- youngest write wins; see fetch-dmi-data.
      const kept = pts.filter((p, i) => {
        const expected =
          i === 0
            ? 2 * pts[1].v - pts[2].v
            : i === pts.length - 1
              ? 2 * pts[i - 1].v - pts[i - 2].v
              : (pts[i - 1].v + pts[i + 1].v) / 2
        return Math.abs(p.v - expected) <= SPIKE_CM
      })

      const rows = kept.map((p) => ({
        station_id: obsId,
        forecast_at: new Date(p.t).toISOString(),
        value_cm: Math.round(p.v),
        source: SOURCE_STATION,
        generated_at: generatedAt,
      }))
      const { error } = await supabase
        .from('water_level_forecast')
        .upsert(rows, { onConflict: 'station_id,source,forecast_at' })
      if (error) throw new Error(`upsert: ${error.message}`)

      results.push({
        tideId,
        obsId,
        action: 'written',
        rows: rows.length,
        dropped: pts.length - kept.length,
        generatedAt,
      })
    } catch (err) {
      console.error(`push-forecast ${tideId} failed:`, err)
      results.push({ tideId, obsId, action: 'rejected', reason: String(err).slice(0, 300) })
    }
  }

  // 207-ish: still 200 so the pusher can read per-station outcomes; it decides
  // what counts as failure.
  return json({ results })
})

// Vercel serverless function: the public read path for all tide data.
//
// Why this exists: every browser used to query Supabase directly, so egress
// scaled with traffic and blew the free-tier 5 GB budget. The payload is
// byte-for-byte identical for every visitor, so it is fetched once here and
// served from Vercel's edge cache for CACHE_SECONDS. Supabase now sees roughly
// one read per cache period no matter how many people are on the site.
//
// This is intentionally a dumb proxy: it returns raw PostgREST rows and does no
// interpretation. All snake_case -> camelCase mapping and the entire safety
// algorithm stay in src/lib (api.ts, tide.ts) so there is exactly one
// implementation of the logic that tells people whether the road is passable.
//
// The selected columns must stay in step with the fallback queries in
// src/lib/api.ts — in particular the forecast needs `source` and `generated_at`,
// which tide.ts uses to choose between the station prognosis and DKSS.

const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY

/** Stations to bundle. Must stay in sync with STATIONS in src/lib/stations.ts. */
const STATION_IDS = ['9007101', '9006701']

/**
 * How long the edge cache serves a response before revalidating. DMI publishes
 * observations every 10 minutes, so 5 minutes never hides fresh data. A
 * user-initiated refresh (pull-to-refresh, the freshness chip) bypasses this —
 * see fetchConditions() in src/lib/api.ts.
 */
const CACHE_SECONDS = 300

// Query windows, mirroring src/lib/api.ts. Widen one, widen both.
const READINGS_BACK_MS = 24 * 60 * 60 * 1000
const PREDICTIONS_BACK_MS = 12 * 60 * 60 * 1000
const PREDICTIONS_AHEAD_MS = 8 * 24 * 60 * 60 * 1000
const FORECAST_BACK_MS = 2 * 60 * 60 * 1000
const FORECAST_AHEAD_MS = 6 * 24 * 60 * 60 * 1000

/** PostgREST caps a single response at 1000 rows regardless of `limit`. */
const PAGE_SIZE = 1000
/** Safety stop so a misbehaving upstream can't page forever. */
const MAX_PAGES = 6

async function pgGet(path: string, query: string): Promise<unknown[]> {
  // Page explicitly: the 8-day 10-minute tide series is ~1250 rows, so a single
  // request silently truncated it to 1000 (~7 days) before this existed.
  const out: unknown[] = []
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/${path}?${query}&limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`,
      {
        headers: {
          apikey: SUPABASE_ANON_KEY as string,
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
          Accept: 'application/json',
        },
      },
    )
    if (!res.ok) {
      throw new Error(`${path} ${res.status}: ${(await res.text()).slice(0, 200)}`)
    }
    const rows = (await res.json()) as unknown[]
    out.push(...rows)
    if (rows.length < PAGE_SIZE) break
  }
  return out
}

async function buildBundle() {
  const now = Date.now()
  const iso = (ms: number) => new Date(ms).toISOString()

  const rulesRows = await pgGet(
    'safety_rules',
    'select=flood_margin_cm,fall_margin_cm,caution_max_cm,crossing_minutes,buffer_minutes,' +
      'min_window_minutes,wind_adjustment_enabled,puddle_warning_enabled,puddle_warning_range_cm,' +
      'playback_speed_pct,day_trip_mode,min_daytrip_minutes,absolute_min_daytrip_minutes,' +
      'daytrip_rollover_hour,table_granularity_minutes,updated_at&id=eq.1',
  )

  const stations: Record<string, unknown> = {}
  await Promise.all(
    STATION_IDS.map(async (id) => {
      const [readings, predictions, forecast] = await Promise.all([
        pgGet(
          'station_readings',
          `select=observed_at,water_level_cm&station_id=eq.${id}` +
            `&observed_at=gte.${iso(now - READINGS_BACK_MS)}&order=observed_at.asc`,
        ),
        pgGet(
          'tide_predictions',
          `select=predicted_at,prediction_type,value_cm&station_id=eq.${id}` +
            `&predicted_at=gte.${iso(now - PREDICTIONS_BACK_MS)}` +
            `&predicted_at=lte.${iso(now + PREDICTIONS_AHEAD_MS)}&order=predicted_at.asc`,
        ),
        // Both forecast sources come back together; tide.ts picks per source.
        pgGet(
          'water_level_forecast',
          `select=forecast_at,value_cm,source,generated_at&station_id=eq.${id}` +
            `&forecast_at=gte.${iso(now - FORECAST_BACK_MS)}` +
            `&forecast_at=lte.${iso(now + FORECAST_AHEAD_MS)}&order=forecast_at.asc`,
        ),
      ])
      stations[id] = { readings, predictions, forecast }
    }),
  )

  return { rules: rulesRows[0] ?? null, stations, generatedAt: iso(now) }
}

// Classic Node signature — this project is a Vite SPA, not Next.js. `res` is
// typed loosely so the function needs no @vercel/node dependency.
/* eslint-disable @typescript-eslint/no-explicit-any */
export default async function handler(_req: any, res: any) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    res.status(503).json({ error: 'Supabase env vars are not configured' })
    return
  }

  try {
    const bundle = await buildBundle()
    // s-maxage caches at Vercel's edge; max-age=0 keeps browsers revalidating so
    // a client never pins a stale verdict locally. stale-while-revalidate lets
    // the edge serve the last good copy while refreshing in the background,
    // which also shields the site from a brief Supabase outage.
    res.setHeader(
      'Cache-Control',
      `public, max-age=0, s-maxage=${CACHE_SECONDS}, stale-while-revalidate=1800`,
    )
    res.status(200).json(bundle)
  } catch (err) {
    console.error('conditions bundle failed:', err)
    // Never cache an error — the client falls back to querying Supabase directly.
    res.setHeader('Cache-Control', 'no-store')
    res.status(502).json({ error: String(err) })
  }
}

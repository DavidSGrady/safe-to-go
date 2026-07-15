// Supabase Edge Function: fetch water-level observations and tide predictions
// from DMI's oceanObs API and store them in Postgres.
//
// Invoked every 10 minutes by pg_cron (see supabase/setup_cron.sql) or the
// Supabase Cron dashboard integration. Can also be invoked manually.
//
// Discovery mode: GET .../fetch-dmi-data?discover=ribe returns all DMI
// observation + tidewater stations whose name matches, in case the station
// IDs ever change. See README.
//
// The DMI open data API requires no API key. Optional overrides
// (supabase secrets set KEY=value):
//   DMI_STATION_ID_OBS        observation station (default 9007101, "Mandø I")
//   DMI_STATION_ID_TIDE       tidewater station (default 25346, "Mandø")
//   DMI_BASE_URL              API gateway base URL
//   DMI_PARAMETER_ID          water level parameter (default 'sea_reg', cm)
//   DKSS_COLLECTION           DMI surge-model collection (default dkss_ws, Wadden Sea)
//   DKSS_LON / DKSS_LAT       wet grid point near Mandø (default 8.50 / 55.28)
//   NINJO_BASE_URL            dmi.dk station-prognosis endpoint override
//   DMI_API_KEY               only if DMI ever reintroduces keys
//
// Four things are ingested each run:
//   observation  — measured water level (gauge, includes real weather)
//   tidewater    — astronomical tide table (no weather; used when the wind
//                  toggle is OFF and as a fallback beyond the forecast horizon)
//   station prognosis — DMI's per-station water-level prognosis (ARIMA + DKSS,
//                  calibrated to the gauge), the exact 10-minute series dmi.dk
//                  shows for the station. Primary forecast when the wind
//                  toggle is ON. Comes from www.dmi.dk's internal ninjo2dmidk
//                  endpoint (undocumented, keyless) — hence the DKSS fallback.
//   DKSS         — DMI's storm-surge model at a nearby wet grid point.
//                  Fallback only: the grid cell dries at low tide (clamps
//                  around −20 cm) and is hourly, so it diverges from dmi.dk.

import { createClient } from 'npm:@supabase/supabase-js@2'

const DMI_BASE_URL =
  Deno.env.get('DMI_BASE_URL') ?? 'https://dmigw.govcloud.dk/v2/oceanObs'
const DMI_API_KEY = Deno.env.get('DMI_API_KEY') ?? ''
const STATION_OBS = Deno.env.get('DMI_STATION_ID_OBS') ?? '9007101'
const STATION_TIDE = Deno.env.get('DMI_STATION_ID_TIDE') ?? '25346'
const PARAMETER_ID = Deno.env.get('DMI_PARAMETER_ID') ?? 'sea_reg'
const DKSS_BASE_URL =
  Deno.env.get('DKSS_BASE_URL') ?? 'https://dmigw.govcloud.dk/v1/forecastedr'
const DKSS_COLLECTION = Deno.env.get('DKSS_COLLECTION') ?? 'dkss_ws'
const DKSS_LON = Deno.env.get('DKSS_LON') ?? '8.50'
const DKSS_LAT = Deno.env.get('DKSS_LAT') ?? '55.28'
const NINJO_BASE_URL =
  Deno.env.get('NINJO_BASE_URL') ?? 'https://www.dmi.dk/NinJo2DmiDk/ninjo2dmidk'
/** `source` value for station-prognosis rows in water_level_forecast. */
const SOURCE_STATION = 'dmi_station'

interface StationConfig {
  /** DMI observation stationId — also how rows are keyed in Postgres. */
  obsId: string
  /** DMI tidewater stationId (astronomical predictions). */
  tideId: string
  /** DKSS grid point (storm-surge forecast). */
  dkssLon: string
  dkssLat: string
}

// Stations to ingest. Mandø stays overridable via the existing secrets; Ribe
// Kammersluse is added as a second gauge locals cross-reference. If a station's
// fetch fails, the others still run (see ingest()).
const STATIONS: StationConfig[] = [
  { obsId: STATION_OBS, tideId: STATION_TIDE, dkssLon: DKSS_LON, dkssLat: DKSS_LAT },
  { obsId: '9006701', tideId: '25343', dkssLon: '8.66', dkssLat: '55.31' },
]

interface DmiFeature {
  properties: Record<string, unknown>
}

async function dmiGet(path: string, params: Record<string, string>): Promise<DmiFeature[]> {
  const url = new URL(`${DMI_BASE_URL}/collections/${path}/items`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  if (DMI_API_KEY) url.searchParams.set('api-key', DMI_API_KEY)

  const res = await fetch(url, {
    headers: DMI_API_KEY ? { 'X-Gravitee-Api-Key': DMI_API_KEY } : {},
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`DMI ${path} ${res.status}: ${body.slice(0, 300)}`)
  }
  const json = await res.json()
  return (json.features ?? []) as DmiFeature[]
}

async function discoverStations(query: string) {
  const match = (features: DmiFeature[]) =>
    features
      .map((f) => f.properties)
      .filter((p) =>
        String(p.name ?? '')
          .toLowerCase()
          .includes(query.toLowerCase()),
      )
      .map((p) => ({
        stationId: p.stationId,
        name: p.name,
        status: p.status,
        parameterId: p.parameterId,
        type: p.type ?? p.stationType,
      }))

  const [obs, tide] = await Promise.all([
    dmiGet('station', { limit: '1000' }),
    dmiGet('tidewaterstation', { limit: '1000' }).catch(() => [] as DmiFeature[]),
  ])
  return { observationStations: match(obs), tidewaterStations: match(tide) }
}

// deno-lint-ignore no-explicit-any
type Supa = any

interface ForecastRow {
  station_id: string
  forecast_at: string
  value_cm: number
  source: string
  /** Model run time (station prognosis) or fetch time (DKSS). */
  generated_at: string
}

/** Ingest observations, tide predictions and the DKSS forecast for one station. */
async function ingestStation(supabase: Supa, now: number, station: StationConfig) {
  const iso = (ms: number) => new Date(ms).toISOString()

  // --- Observations: last 24 h of water levels ---
  const obsFeatures = await dmiGet('observation', {
    stationId: station.obsId,
    parameterId: PARAMETER_ID,
    datetime: `${iso(now - 24 * 3600_000)}/${iso(now)}`,
    limit: '300',
    sortorder: 'observed,DESC',
  })

  const readings = obsFeatures
    .map((f) => f.properties)
    .filter((p) => p.observed && typeof p.value === 'number')
    .map((p) => ({
      station_id: String(p.stationId ?? station.obsId),
      parameter_id: String(p.parameterId ?? PARAMETER_ID),
      observed_at: String(p.observed),
      water_level_cm: p.value as number,
    }))

  if (readings.length > 0) {
    const { error } = await supabase
      .from('station_readings')
      .upsert(readings, { onConflict: 'station_id,parameter_id,observed_at' })
    if (error) throw new Error(`upsert readings: ${error.message}`)
  }

  // --- Tide predictions: -12 h to +8 days (covers the "see further ahead" 7-day view) ---
  const tideFeatures = await dmiGet('tidewater', {
    stationId: station.tideId,
    datetime: `${iso(now - 12 * 3600_000)}/${iso(now + 8 * 24 * 3600_000)}`,
    limit: '3000',
  })

  const predictions = tideFeatures
    .map((f) => f.properties)
    .filter(
      (p) =>
        (p.predictionTime || p.predicted) &&
        typeof p.value === 'number' &&
        typeof p.predictionType === 'string',
    )
    .map((p) => ({
      // Store under the observation stationId so the app keys everything by one id.
      station_id: station.obsId,
      prediction_type: String(p.predictionType),
      predicted_at: String(p.predictionTime ?? p.predicted),
      value_cm: p.value as number,
    }))

  if (predictions.length > 0) {
    const { error } = await supabase
      .from('tide_predictions')
      .upsert(predictions, { onConflict: 'station_id,prediction_type,predicted_at' })
    if (error) throw new Error(`upsert predictions: ${error.message}`)
  }

  // --- DMI station prognosis (primary forecast; the series dmi.dk shows) ---
  // Non-fatal: it comes from dmi.dk's internal endpoint, which can change or
  // be unavailable — the app then falls back to the DKSS rows below.
  let stationForecast: ForecastRow[] = []
  let stationForecastError: string | null = null
  try {
    stationForecast = await fetchStationPrognosis(station)
    if (stationForecast.length > 0) {
      const { error } = await supabase
        .from('water_level_forecast')
        .upsert(stationForecast, { onConflict: 'station_id,source,forecast_at' })
      if (error) throw new Error(error.message)
    }
  } catch (err) {
    stationForecastError = String(err)
    console.error(
      `station prognosis fetch failed for ${station.obsId} (non-fatal):`,
      stationForecastError,
    )
  }

  // --- DKSS storm-surge forecast (fallback when the station prognosis is out) ---
  // Non-fatal: if DMI's forecast API is briefly unavailable (or the grid point
  // is dry), keep the observations/tide we already stored. The app falls back
  // to the astronomical table until the next run refreshes the forecast.
  let forecast: ForecastRow[] = []
  let forecastError: string | null = null
  try {
    forecast = await fetchDkss(station)
    if (forecast.length > 0) {
      const { error } = await supabase
        .from('water_level_forecast')
        .upsert(forecast, { onConflict: 'station_id,source,forecast_at' })
      if (error) throw new Error(error.message)
    }
  } catch (err) {
    forecastError = String(err)
    console.error(`DKSS forecast fetch failed for ${station.obsId} (non-fatal):`, forecastError)
  }

  return {
    stationId: station.obsId,
    readingsUpserted: readings.length,
    predictionsUpserted: predictions.length,
    stationForecastUpserted: stationForecast.length,
    stationForecastError,
    forecastUpserted: forecast.length,
    forecastError,
    newestReading: readings[0]?.observed_at ?? null,
  }
}

async function ingest() {
  if (!STATION_OBS) throw new Error('DMI_STATION_ID_OBS is not set')

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  const now = Date.now()
  const iso = (ms: number) => new Date(ms).toISOString()

  // Ingest stations sequentially so we don't fire concurrent DKSS requests at
  // DMI's forecast API (which returns 429). One station failing must not block
  // the others.
  const perStation: unknown[] = []
  for (const station of STATIONS) {
    try {
      perStation.push(await ingestStation(supabase, now, station))
    } catch (err) {
      console.error(`ingest failed for ${station.obsId}:`, err)
      perStation.push({ stationId: station.obsId, error: String(err) })
    }
  }

  // --- Prune: keep 30 days of readings, drop old predictions/forecast ---
  await supabase
    .from('station_readings')
    .delete()
    .lt('observed_at', iso(now - 30 * 24 * 3600_000))
  await supabase
    .from('tide_predictions')
    .delete()
    .lt('predicted_at', iso(now - 2 * 24 * 3600_000))
  await supabase
    .from('water_level_forecast')
    .delete()
    .lt('forecast_at', iso(now - 1 * 24 * 3600_000))

  return { stations: perStation }
}

/**
 * Fetch DMI's per-station water-level prognosis — the exact 10-minute series
 * dmi.dk's location pages show ("model data for arima and dkss": the DKSS
 * model statistically calibrated to the gauge). Keyed by the *tidewater*
 * stationId. Values are already cm relative to DVR90 and gauge-aligned, so
 * tide.ts applies no datum shift to this source.
 *
 * This is www.dmi.dk's internal website API, not the documented open-data
 * gateway — it can change without notice, which is why the DKSS grid ingest
 * below stays as a fallback.
 */
async function fetchStationPrognosis(station: StationConfig): Promise<ForecastRow[]> {
  const url = `${NINJO_BASE_URL}?cmd=odj&stations=${station.tideId}&datatype=fcst`
  const res = await fetch(url)
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200)
    throw new Error(`ninjo fcst ${station.tideId} ${res.status}: ${body}`)
  }
  const json = await res.json()
  const series = Array.isArray(json) ? json[0] : null
  const values: Array<{ time?: string; value?: unknown }> = series?.values ?? []
  const generatedAt = series?.generatedTime
    ? new Date(series.generatedTime).toISOString()
    : new Date().toISOString()

  // No head skip — deliberately. A run's youngest points are nudged toward
  // the live observation, making them the MOST accurate value a timestamp
  // ever receives; its 25-30-minute-out points are pure model, which lags
  // reality by up to ~30 cm in fast tide phases. Two rounds of head-skipping
  // (12 min on 2026-07-13, 25 min on 2026-07-14) each froze those stale
  // model values as the timestamps' permanent rows and produced MORE delta
  // spikes (25/day) than the original problem (14/day). Youngest write wins.
  const pts: Array<{ t: number; v: number }> = []
  for (const v of values) {
    if (v?.time && typeof v.value === 'number' && Number.isFinite(v.value)) {
      const t = Date.parse(String(v.time))
      if (!Number.isFinite(t)) continue
      pts.push({ t, v: v.value })
    }
  }
  pts.sort((a, b) => a.t - b.t)

  // The original problem — an intermittently corrupt point near the head of
  // a run (e.g. +1 cm between neighbours at +39/+45) — is caught by shape,
  // not by age: reject any point far off its own run's curve (midpoint of
  // its neighbours inside the run, linear extrapolation at the ends).
  // 20 cm passes the smooth observation-nudge blend and genuine tide
  // movement (≤ ~10 cm per 10-minute step, bending a few cm per step²)
  // while the glitches seen so far sit 30-44 cm off. Judged against the
  // unfiltered array, so a corrupt point cannot get its neighbour rejected.
  const SPIKE_CM = 20
  const kept =
    pts.length < 3
      ? pts
      : pts.filter((p, i) => {
          const expected =
            i === 0
              ? 2 * pts[1].v - pts[2].v
              : i === pts.length - 1
                ? 2 * pts[i - 1].v - pts[i - 2].v
                : (pts[i - 1].v + pts[i + 1].v) / 2
          return Math.abs(p.v - expected) <= SPIKE_CM
        })

  return kept.map((p) => ({
    station_id: station.obsId,
    forecast_at: new Date(p.t).toISOString(),
    value_cm: Math.round(p.v),
    source: SOURCE_STATION,
    generated_at: generatedAt,
  }))
}

/**
 * Fetch the DKSS storm-surge forecast (sea-mean-deviation) at a wet grid
 * point next to Mandø via DMI's OGC EDR forecast API. Values are metres of
 * deviation from mean sea level; we store them as cm. The datum is aligned
 * to the gauge at read time (see tide.ts), so a small constant offset here
 * does not matter. Fallback only — the grid cell dries around low tide, so
 * the station prognosis above is preferred whenever it's available.
 */
async function fetchDkss(station: StationConfig): Promise<ForecastRow[]> {
  const coords = `POINT(${station.dkssLon} ${station.dkssLat})`
  const url =
    `${DKSS_BASE_URL}/collections/${DKSS_COLLECTION}/position` +
    `?coords=${encodeURIComponent(coords)}` +
    `&parameter-name=sea-mean-deviation&crs=crs84`
  const headers = DMI_API_KEY ? { 'X-Gravitee-Api-Key': DMI_API_KEY } : {}
  // Retry on 429 / 5xx with backoff — DMI's forecast API is easily rate-limited.
  let res: Response | null = null
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await fetch(url, { headers })
    if (res.ok) break
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)))
      continue
    }
    break
  }
  if (!res || !res.ok) {
    const body = res ? (await res.text()).slice(0, 200) : 'no response'
    throw new Error(`DKSS ${DKSS_COLLECTION} ${res?.status}: ${body}`)
  }
  const json = await res.json()
  const times: string[] = json?.domain?.axes?.t?.values ?? []
  const values: Array<number | null> = json?.ranges?.['sea-mean-deviation']?.values ?? []
  const fetchedAt = new Date().toISOString()

  const rows: ForecastRow[] = []
  for (let i = 0; i < times.length; i++) {
    const v = values[i]
    if (typeof v === 'number' && Number.isFinite(v)) {
      rows.push({
        station_id: station.obsId,
        forecast_at: new Date(times[i]).toISOString(),
        value_cm: Math.round(v * 100),
        source: DKSS_COLLECTION,
        generated_at: fetchedAt,
      })
    }
  }
  return rows
}

Deno.serve(async (req) => {
  try {
    const discover = new URL(req.url).searchParams.get('discover')
    const result = discover ? await discoverStations(discover) : await ingest()

    return new Response(JSON.stringify(result, null, 2), {
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (err) {
    console.error(err)
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
})

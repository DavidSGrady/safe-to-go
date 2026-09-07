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
//   ALERT_WEBHOOK_URL         ops alerts (Slack incoming-webhook payload `{text}`);
//                             unset = alerts off. See alertOnStaleObservations().
//   STALE_ALERT_HOURS         alert when a station's newest reading is older (default 3)
//   STALE_ALERT_REPEAT_HOURS  reminder cadence while it stays stale (default 6)
//   ALERT_SITE_URL            link in alert messages (default the prod domain)
//
// Four things are ingested each run:
//   observation  — measured water level (gauge, includes real weather).
//                  Primary: the open-data gateway. Fallback: dmi.dk's NinJo
//                  feed (same values; see fetchNinjoObservations).
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
import webpush from 'npm:web-push@3.6.7'

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
  /** Human name, for ops alerts only. */
  name: string
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
  { name: 'Mandø', obsId: STATION_OBS, tideId: STATION_TIDE, dkssLon: DKSS_LON, dkssLat: DKSS_LAT },
  { name: 'Ribe Kammersluse', obsId: '9006701', tideId: '25343', dkssLon: '8.66', dkssLat: '55.31' },
]

interface ReadingRow {
  station_id: string
  parameter_id: string
  observed_at: string
  water_level_cm: number
}

/** Observation window fetched each run. DMI republishes all of it every time. */
const OBS_WINDOW_MS = 24 * 3600_000

/** Observations from the open-data gateway, newest first. */
async function fetchGatewayObservations(station: StationConfig, now: number): Promise<ReadingRow[]> {
  const iso = (ms: number) => new Date(ms).toISOString()
  const features = await dmiGet('observation', {
    stationId: station.obsId,
    parameterId: PARAMETER_ID,
    datetime: `${iso(now - OBS_WINDOW_MS)}/${iso(now)}`,
    limit: '300',
    sortorder: 'observed,DESC',
  })
  const rows = features
    .map((f) => f.properties)
    .filter((p) => p.observed && typeof p.value === 'number')
    .map((p) => ({
      station_id: String(p.stationId ?? station.obsId),
      parameter_id: String(p.parameterId ?? PARAMETER_ID),
      observed_at: String(p.observed),
      water_level_cm: p.value as number,
    }))
  // An empty window from a healthy gateway is as useless as a dead one — let
  // the caller try the fallback rather than silently recording nothing.
  if (rows.length === 0) throw new Error('gateway returned no observations')
  return rows
}

/**
 * Fallback observation source: the www.dmi.dk NinJo endpoint that serves the
 * station prognosis also serves the gauge observations dmi.dk's location pages
 * show (`datatype=obs`, ~48 h of 10-minute values, keyed by the *tidewater*
 * stationId like the prognosis). Checked 2026-09-07 against the gateway rows
 * already in Postgres: identical at every shared timestamp once rounded (NinJo
 * carries float noise such as 66.00000762939453).
 *
 * Fallback only, because it is undocumented and can change without notice. It
 * exists because on 2026-09-07 the gateway's DNS record vanished for hours
 * while dmi.dk kept updating — the app showed a 13 h old reading for nothing.
 */
async function fetchNinjoObservations(station: StationConfig, now: number): Promise<ReadingRow[]> {
  const url = `${NINJO_BASE_URL}?cmd=odj&stations=${station.tideId}&datatype=obs`
  const res = await fetch(url)
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200)
    throw new Error(`ninjo obs ${station.tideId} ${res.status}: ${body}`)
  }
  const json = await res.json()
  const series = Array.isArray(json) ? json[0] : null
  const values: Array<{ time?: string; value?: unknown }> = series?.values ?? []

  const rows: ReadingRow[] = []
  for (const v of values) {
    if (!v?.time || typeof v.value !== 'number' || !Number.isFinite(v.value)) continue
    const t = Date.parse(String(v.time))
    // Same window as the gateway query, so the diff/upsert below behaves identically.
    if (!Number.isFinite(t) || t < now - OBS_WINDOW_MS || t > now) continue
    rows.push({
      station_id: station.obsId,
      parameter_id: PARAMETER_ID,
      observed_at: new Date(t).toISOString(),
      water_level_cm: Math.round(v.value),
    })
  }
  if (rows.length === 0) throw new Error(`ninjo obs ${station.tideId}: no observations in window`)
  rows.sort((a, b) => Date.parse(b.observed_at) - Date.parse(a.observed_at)) // newest first
  return rows
}

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

/**
 * How far ahead the stored tide table must reach before the fetch is skipped.
 * See the tide block in ingestStation() for why the values are immutable.
 */
const TIDE_HORIZON_MS = 7.5 * 24 * 3600_000

/** Ingest observations, tide predictions and the DKSS forecast for one station. */
async function ingestStation(supabase: Supa, now: number, station: StationConfig) {
  const iso = (ms: number) => new Date(ms).toISOString()

  // --- Observations: last 24 h of water levels ---
  // Gateway first, NinJo if it fails. Non-fatal: a dead observation source must
  // not stop the forecasts below from refreshing. Before 2026-09-07 this fetch
  // threw and aborted the station, so when the gateway's DNS record vanished
  // the station prognosis — served by a host that was up the whole time —
  // froze along with the readings.
  let readings: ReadingRow[] = []
  let readingsSource: 'dmi_gateway' | 'ninjo' | null = null
  let gatewayError: string | null = null
  let readingsError: string | null = null
  try {
    readings = await fetchGatewayObservations(station, now)
    readingsSource = 'dmi_gateway'
  } catch (err) {
    gatewayError = String(err)
    console.error(`gateway observations failed for ${station.obsId}, trying NinJo:`, gatewayError)
    try {
      readings = await fetchNinjoObservations(station, now)
      readingsSource = 'ninjo'
    } catch (ninjoErr) {
      readingsError = `gateway: ${gatewayError}; ninjo: ${String(ninjoErr)}`
      console.error(`all observation sources failed for ${station.obsId}:`, readingsError)
    }
  }

  // Write only observations we don't already have. DMI republishes the whole
  // 24 h window every run, but `station_readings` is the one data table in the
  // Realtime publication, so a blind upsert of all ~144 rows fired ~144 change
  // events per station per run — and every connected browser refetched the full
  // dataset on each one. That amplification, not traffic, is what blew the
  // free-tier egress budget. Diffing keeps the fan-out proportional to
  // genuinely new data (~1 row per run).
  //
  // Note this is the opposite of the station-prognosis policy below, where
  // re-writing every run is deliberate ("youngest write wins"). Observations
  // are immutable measurements, so a rewrite carries no new information.
  let newReadings = readings
  if (readings.length > 0) {
    const oldest = readings.reduce(
      (min, r) => (r.observed_at < min ? r.observed_at : min),
      readings[0].observed_at,
    )
    const { data: existing, error: existingError } = await supabase
      .from('station_readings')
      .select('observed_at')
      .eq('station_id', station.obsId)
      // Match the unique constraint (station_id, parameter_id, observed_at) so a
      // row for another parameter can't mask a genuinely new observation.
      .eq('parameter_id', PARAMETER_ID)
      .gte('observed_at', oldest)
    if (existingError) throw new Error(`read existing readings: ${existingError.message}`)

    // Compare as epoch ms: Postgres renders timestamptz differently from DMI's
    // ISO strings, so raw string equality would never match and we'd rewrite
    // everything anyway.
    const seen = new Set(
      ((existing ?? []) as Array<{ observed_at: string }>).map((r) => Date.parse(r.observed_at)),
    )
    newReadings = readings.filter((r) => !seen.has(Date.parse(r.observed_at)))
  }

  if (newReadings.length > 0) {
    const { error } = await supabase
      .from('station_readings')
      .upsert(newReadings, { onConflict: 'station_id,parameter_id,observed_at' })
    if (error) throw new Error(`upsert readings: ${error.message}`)
  }

  // --- Tide predictions: -12 h to +8 days (covers the "see further ahead" 7-day view) ---
  // Re-fetched only when the stored table stops reaching TIDE_HORIZON_MS ahead,
  // which lands about once a day. DMI's `tidewater` product is a pre-computed
  // harmonic table: every row for Aug 2026 carries `created: 2026-03-23`, i.e.
  // the values are generated months ahead and never revised, so re-fetching
  // ~1250 rows per station every 10 minutes bought nothing.
  const { data: tideHead } = await supabase
    .from('tide_predictions')
    .select('predicted_at')
    .eq('station_id', station.obsId)
    .order('predicted_at', { ascending: false })
    .limit(1)
  const tideReachMs = (tideHead ?? []).length
    ? Date.parse((tideHead as Array<{ predicted_at: string }>)[0].predicted_at) - now
    : -1
  const tideFresh = tideReachMs >= TIDE_HORIZON_MS

  let predictions: Array<{
    station_id: string
    prediction_type: string
    predicted_at: string
    value_cm: number
  }> = []
  let tideError: string | null = null

  // Non-fatal like the observations: the tide table is on the same gateway, and
  // the stored table reaches ~7.5 days ahead, so a day-long outage costs nothing.
  if (!tideFresh) {
    try {
      const tideFeatures = await dmiGet('tidewater', {
        stationId: station.tideId,
        datetime: `${iso(now - 12 * 3600_000)}/${iso(now + 8 * 24 * 3600_000)}`,
        limit: '3000',
      })

      predictions = tideFeatures
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
    } catch (err) {
      tideError = String(err)
      console.error(`tide predictions failed for ${station.obsId} (non-fatal):`, tideError)
    }
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
    readingsSource,
    readingsFetched: readings.length,
    readingsUpserted: newReadings.length,
    gatewayError,
    readingsError,
    predictionsUpserted: predictions.length,
    tideSkipped: tideFresh,
    tideError,
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

  // --- Ops alert: readings stale for hours → webhook. Fault-isolated. ---
  let staleAlert: unknown = null
  try {
    staleAlert = await alertOnStaleObservations(supabase, now, perStation)
  } catch (err) {
    console.error('alertOnStaleObservations failed (non-fatal):', err)
    staleAlert = { error: String(err) }
  }

  // --- Push notifications: fault-isolated, must never break ingestion ---
  let notify: unknown = null
  try {
    notify = await notifyPassable(supabase, now)
  } catch (err) {
    console.error('notifyPassable failed (non-fatal):', err)
    notify = { error: String(err) }
  }

  return { stations: perStation, staleAlert, notify }
}

// ---------------------------------------------------------------------------
// Ops alert: "no new readings for N hours". Posts to ALERT_WEBHOOK_URL as a
// Slack incoming-webhook payload (`{ text }`; Discord accepts the same on a
// webhook URL suffixed `/slack`). State lives in `ops_alert_state` so a
// station going stale produces one alert, a reminder every
// STALE_ALERT_REPEAT_HOURS, and one recovery message — not a post per cron
// run. See supabase/migrations/20260907000000_ops_alert_state.sql.
//
// Limitation: this runs inside the cron. If the cron itself stops, nothing
// fires — that needs an external check, e.g. an uptime monitor on
// /api/conditions that asserts on the newest observed_at.
// ---------------------------------------------------------------------------

const ALERT_WEBHOOK_URL = Deno.env.get('ALERT_WEBHOOK_URL') ?? ''
const STALE_ALERT_MS = Number(Deno.env.get('STALE_ALERT_HOURS') ?? '3') * 3600_000
const STALE_ALERT_REPEAT_MS = Number(Deno.env.get('STALE_ALERT_REPEAT_HOURS') ?? '6') * 3600_000
const ALERT_SITE_URL = Deno.env.get('ALERT_SITE_URL') ?? 'https://www.xn--krtilmand-l8ai.dk'

interface AlertStateRow {
  key: string
  active: boolean
  first_stale_at: string | null
  last_notified_at: string | null
}

/** Shape of the per-station ingest results this run, as far as alerting cares. */
interface StationRunResult {
  stationId: string
  error?: string
  readingsError?: string | null
  gatewayError?: string | null
  readingsSource?: string | null
}

async function postAlert(text: string): Promise<void> {
  const res = await fetch(ALERT_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  })
  if (!res.ok) throw new Error(`alert webhook ${res.status}: ${(await res.text()).slice(0, 200)}`)
}

function formatCopenhagen(ms: number): string {
  return new Intl.DateTimeFormat('da-DK', {
    timeZone: 'Europe/Copenhagen',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(ms))
}

function formatAge(ms: number): string {
  if (!Number.isFinite(ms)) return 'ever'
  const h = Math.floor(ms / 3600_000)
  const m = Math.floor((ms % 3600_000) / 60_000)
  return h > 0 ? `${h} h ${m} min` : `${m} min`
}

/**
 * Compare each station's newest stored reading against STALE_ALERT_MS and
 * post/refresh/clear an alert accordingly. Reads the *stored* newest row, not
 * this run's fetch, so it also covers "DMI serves data but nothing new in it"
 * (a gauge outage) and a broken write path.
 */
async function alertOnStaleObservations(supabase: Supa, now: number, runResults: unknown[]) {
  if (!ALERT_WEBHOOK_URL) return { skipped: 'no ALERT_WEBHOOK_URL' }
  const iso = (ms: number) => new Date(ms).toISOString()

  const { data: stateRows, error: stateError } = await supabase
    .from('ops_alert_state')
    .select('key,active,first_stale_at,last_notified_at')
  if (stateError) {
    throw new Error(
      `read ops_alert_state: ${stateError.message} (is migration 20260907000000_ops_alert_state applied?)`,
    )
  }
  const state = new Map<string, AlertStateRow>(
    ((stateRows ?? []) as AlertStateRow[]).map((r) => [r.key, r]),
  )
  const reasons = new Map<string, string>()
  for (const r of runResults as StationRunResult[]) {
    const reason = r.error ?? r.readingsError ?? (r.readingsSource === 'ninjo' ? r.gatewayError : null)
    if (reason) reasons.set(r.stationId, reason)
  }

  const out: Array<{ stationId: string; ageMinutes: number | null; stale: boolean; action: string }> = []
  for (const station of STATIONS) {
    const { data: latest, error } = await supabase
      .from('station_readings')
      .select('observed_at')
      .eq('station_id', station.obsId)
      .eq('parameter_id', PARAMETER_ID)
      .order('observed_at', { ascending: false })
      .limit(1)
    if (error) throw new Error(`read newest reading ${station.obsId}: ${error.message}`)

    const newestMs = latest?.[0]?.observed_at ? Date.parse(latest[0].observed_at) : NaN
    const ageMs = Number.isFinite(newestMs) ? now - newestMs : Infinity
    const stale = ageMs > STALE_ALERT_MS

    const key = `stale_observations:${station.obsId}`
    const prev = state.get(key)
    const active = prev?.active ?? false
    const lastNotifiedMs = prev?.last_notified_at ? Date.parse(prev.last_notified_at) : 0
    const label = `${station.name} (${station.obsId})`
    let action = 'none'

    if (stale && (!active || now - lastNotifiedMs >= STALE_ALERT_REPEAT_MS)) {
      const firstStaleAt = active && prev?.first_stale_at ? prev.first_stale_at : iso(now)
      const lines = [
        `⚠️ Kør til Mandø: no new water-level readings for ${label} in ${formatAge(ageMs)}.`,
        Number.isFinite(newestMs)
          ? `Newest reading: ${formatCopenhagen(newestMs)} (Europe/Copenhagen). The site is showing forecast only.`
          : 'No readings stored at all for this station.',
      ]
      const reason = reasons.get(station.obsId)
      if (reason) lines.push(`Last ingest error: ${reason.slice(0, 400)}`)
      if (active) lines.push(`Stale since ${formatCopenhagen(Date.parse(firstStaleAt))}; reminders every ${formatAge(STALE_ALERT_REPEAT_MS)}.`)
      lines.push(`${ALERT_SITE_URL}/admin`)
      await postAlert(lines.join('\n'))
      const { error: writeError } = await supabase.from('ops_alert_state').upsert(
        { key, active: true, first_stale_at: firstStaleAt, last_notified_at: iso(now), updated_at: iso(now) },
        { onConflict: 'key' },
      )
      if (writeError) throw new Error(`write ops_alert_state: ${writeError.message}`)
      action = active ? 'reminded' : 'alerted'
    } else if (!stale && active) {
      const sinceMs = prev?.first_stale_at ? Date.parse(prev.first_stale_at) : NaN
      const gap = Number.isFinite(sinceMs) ? ` after ${formatAge(now - sinceMs)}` : ''
      await postAlert(
        `✅ Kør til Mandø: readings for ${label} are flowing again${gap}. ` +
          `Newest reading: ${formatCopenhagen(newestMs)} (Europe/Copenhagen).`,
      )
      const { error: writeError } = await supabase.from('ops_alert_state').upsert(
        { key, active: false, first_stale_at: null, last_notified_at: iso(now), updated_at: iso(now) },
        { onConflict: 'key' },
      )
      if (writeError) throw new Error(`write ops_alert_state: ${writeError.message}`)
      action = 'recovered'
    }

    out.push({
      stationId: station.obsId,
      ageMinutes: Number.isFinite(ageMs) ? Math.round(ageMs / 60_000) : null,
      stale,
      action,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Web push: "notify me when the road is passable" (one-shot subscriptions).
// The frontend subscribes via the push_subscribe RPC; this step fires the
// notification when falling water reaches the passable limit and deletes the
// subscription. See supabase/migrations/20260726000000_push_subscriptions.sql.
// ---------------------------------------------------------------------------

const VAPID_PUBLIC_KEY = Deno.env.get('VAPID_PUBLIC_KEY') ?? ''
const VAPID_PRIVATE_KEY = Deno.env.get('VAPID_PRIVATE_KEY') ?? ''
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') ?? 'mailto:michael@kollekt.dk'

/** Readings older than this never trigger a push — better silent than wrong. */
const PUSH_MAX_READING_AGE_MS = 30 * 60_000
/** Undeliverable-after TTL: a "passable now" push is stale within hours. */
const PUSH_TTL_SECONDS = 3 * 3600
/** Pending subscriptions older than this are dropped (a tide cycle is ~6 h). */
const PUSH_SUB_MAX_AGE_MS = 24 * 3600_000

interface PushSubRow {
  id: string
  station_id: string
  endpoint: string
  p256dh: string
  auth: string
  locale: string
  created_at: string
}

// The copy is deliberately factual (measurement + limit, "indicative"), never
// an instruction to drive — the app's liability framing applies to pushes too.
const PUSH_STRINGS: Record<string, { title: string; body: (level: string, limit: number) => string }> = {
  da: {
    title: 'Vandstanden er under grænseværdien',
    body: (level, limit) => `${level} cm og faldende (grænseværdi ${limit} cm). Vejledende — se aktuel status i appen.`,
  },
  en: {
    title: 'Water level is below the limit',
    body: (level, limit) => `${level} cm and falling (limit ${limit} cm). Indicative — check the app for current status.`,
  },
  de: {
    title: 'Wasserstand unter dem Grenzwert',
    body: (level, limit) => `${level} cm und fallend (Grenzwert ${limit} cm). Richtwert — aktuellen Status in der App prüfen.`,
  },
  nl: {
    title: 'Waterstand onder de grenswaarde',
    body: (level, limit) => `${level} cm en dalend (grenswaarde ${limit} cm). Indicatief — bekijk de actuele status in de app.`,
  },
  fr: {
    title: "Le niveau d'eau est sous le seuil",
    body: (level, limit) => `${level} cm et en baisse (seuil ${limit} cm). Indicatif — consultez l'appli pour l'état actuel.`,
  },
  es: {
    title: 'El nivel del agua está por debajo del límite',
    body: (level, limit) => `${level} cm y bajando (límite ${limit} cm). Orientativo — consulta el estado actual en la app.`,
  },
  zh: {
    title: '水位已低于限值',
    body: (level, limit) => `${level} 厘米，正在下降（限值 ${limit} 厘米）。仅供参考——请在应用中查看当前状态。`,
  },
}

function signedCm(v: number): string {
  return v > 0 ? `+${v}` : String(v)
}

async function sendPush(sub: PushSubRow, title: string, body: string): Promise<'ok' | 'gone' | 'error'> {
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify({ title, body, tag: 'passable', url: '/' }),
      { TTL: PUSH_TTL_SECONDS, urgency: 'high' },
    )
    return 'ok'
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode
    if (status === 404 || status === 410) return 'gone' // subscription expired/revoked
    console.error(`push send failed for ${sub.id} (${status}):`, err)
    return 'error'
  }
}

/**
 * Fire pending one-shot subscriptions whose station is passable right now.
 * Passable mirrors passableLimitAt() in src/lib/tide.ts: the falling limit
 * while water falls, the stricter rising limit otherwise (equal readings
 * count as rising, the cautious side). Only fresh readings (< 30 min) newer
 * than the subscription itself can trigger — stale data stays silent.
 */
async function notifyPassable(supabase: Supa, now: number) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return { skipped: 'no VAPID keys' }
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY)

  // Housekeeping: pending subs beyond a tide cycle are stale intent.
  await supabase
    .from('push_subscriptions')
    .delete()
    .lt('created_at', new Date(now - PUSH_SUB_MAX_AGE_MS).toISOString())

  const { data: subs, error: subsError } = await supabase
    .from('push_subscriptions')
    .select('id,station_id,endpoint,p256dh,auth,locale,created_at')
    .eq('kind', 'one_shot_passable')
    .is('consumed_at', null)
  if (subsError) throw new Error(`read subscriptions: ${subsError.message}`)
  if (!subs || subs.length === 0) return { pending: 0, sent: 0 }

  const { data: rules, error: rulesError } = await supabase
    .from('safety_rules')
    .select('safe_max_rising_cm,safe_max_falling_cm')
    .eq('id', 1)
    .single()
  if (rulesError) throw new Error(`read rules: ${rulesError.message}`)

  let sent = 0
  let dropped = 0
  for (const stationId of [...new Set((subs as PushSubRow[]).map((s) => s.station_id))]) {
    const { data: readings, error: readError } = await supabase
      .from('station_readings')
      .select('observed_at,water_level_cm')
      .eq('station_id', stationId)
      .eq('parameter_id', PARAMETER_ID)
      .order('observed_at', { ascending: false })
      .limit(2)
    if (readError || !readings || readings.length < 2) continue

    const [latest, prev] = readings
    const observedAt = Date.parse(latest.observed_at)
    if (!Number.isFinite(observedAt) || now - observedAt > PUSH_MAX_READING_AGE_MS) continue

    const rising = latest.water_level_cm >= prev.water_level_cm
    const limit = rising ? rules.safe_max_rising_cm : rules.safe_max_falling_cm
    if (latest.water_level_cm > limit) continue

    for (const sub of (subs as PushSubRow[]).filter((s) => s.station_id === stationId)) {
      // The triggering reading must postdate the subscription, so a sub
      // created moments ago can't fire off data from before the tap.
      if (observedAt <= Date.parse(sub.created_at)) continue
      const strings = PUSH_STRINGS[sub.locale] ?? PUSH_STRINGS.da
      const result = await sendPush(sub, strings.title, strings.body(signedCm(latest.water_level_cm), limit))
      if (result === 'ok' || result === 'gone') {
        await supabase.from('push_subscriptions').delete().eq('id', sub.id)
        if (result === 'ok') sent++
        else dropped++
      }
      // 'error' → row stays; the next cron run retries.
    }
  }
  return { pending: subs.length, sent, dropped }
}

/** Manual test: send a test push to every pending subscription (no cleanup). */
async function pushTest(supabase: Supa) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return { skipped: 'no VAPID keys' }
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY)

  const { data: subs, error } = await supabase
    .from('push_subscriptions')
    .select('id,station_id,endpoint,p256dh,auth,locale,created_at')
    .is('consumed_at', null)
  if (error) throw new Error(`read subscriptions: ${error.message}`)

  const results: Array<{ id: string; result: string }> = []
  for (const sub of (subs ?? []) as PushSubRow[]) {
    const result = await sendPush(sub, 'Kør til Mandø — test', 'Push virker. / Push works.')
    results.push({ id: sub.id, result })
  }
  return { pending: results.length, results }
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
    const params = new URL(req.url).searchParams

    // Test hooks, gated on the service-role key — the anon key ships in the
    // frontend bundle, so it must not be enough to make every subscriber's
    // phone buzz or to spam the ops channel.
    const isServiceRole =
      (req.headers.get('authorization') ?? '') ===
      `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`
    const forbidden = () =>
      new Response(JSON.stringify({ error: 'forbidden' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      })

    // Posts one test message to ALERT_WEBHOOK_URL so the wiring can be verified
    // without waiting for an outage.
    if (params.get('alert_test') === '1') {
      if (!isServiceRole) return forbidden()
      if (!ALERT_WEBHOOK_URL) {
        return new Response(JSON.stringify({ skipped: 'no ALERT_WEBHOOK_URL' }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      await postAlert(
        `🔔 Kør til Mandø: test alert from fetch-dmi-data. Stale threshold ${formatAge(STALE_ALERT_MS)}, ` +
          `reminders every ${formatAge(STALE_ALERT_REPEAT_MS)}.`,
      )
      return new Response(JSON.stringify({ sent: true }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // Sends a test push to all pending subscriptions.
    if (params.get('push_test') === '1') {
      if (!isServiceRole) return forbidden()
      const supabase = createClient(
        Deno.env.get('SUPABASE_URL')!,
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      )
      return new Response(JSON.stringify(await pushTest(supabase), null, 2), {
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const discover = params.get('discover')
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

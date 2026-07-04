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
//   DMI_API_KEY               only if DMI ever reintroduces keys

import { createClient } from 'npm:@supabase/supabase-js@2'

const DMI_BASE_URL =
  Deno.env.get('DMI_BASE_URL') ?? 'https://dmigw.govcloud.dk/v2/oceanObs'
const DMI_API_KEY = Deno.env.get('DMI_API_KEY') ?? ''
const STATION_OBS = Deno.env.get('DMI_STATION_ID_OBS') ?? '9007101'
const STATION_TIDE = Deno.env.get('DMI_STATION_ID_TIDE') ?? '25346'
const PARAMETER_ID = Deno.env.get('DMI_PARAMETER_ID') ?? 'sea_reg'

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

async function ingest() {
  if (!STATION_OBS) throw new Error('DMI_STATION_ID_OBS is not set')

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  const now = Date.now()
  const iso = (ms: number) => new Date(ms).toISOString()

  // --- Observations: last 24 h of water levels ---
  const obsFeatures = await dmiGet('observation', {
    stationId: STATION_OBS,
    parameterId: PARAMETER_ID,
    datetime: `${iso(now - 24 * 3600_000)}/${iso(now)}`,
    limit: '300',
    sortorder: 'observed,DESC',
  })

  const readings = obsFeatures
    .map((f) => f.properties)
    .filter((p) => p.observed && typeof p.value === 'number')
    .map((p) => ({
      station_id: String(p.stationId),
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
    stationId: STATION_TIDE,
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
      station_id: String(p.stationId),
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

  // --- Prune: keep 30 days of readings, drop predictions older than 2 days ---
  await supabase
    .from('station_readings')
    .delete()
    .lt('observed_at', iso(now - 30 * 24 * 3600_000))
  await supabase
    .from('tide_predictions')
    .delete()
    .lt('predicted_at', iso(now - 2 * 24 * 3600_000))

  return {
    readingsUpserted: readings.length,
    predictionsUpserted: predictions.length,
    newestReading: readings[0]?.observed_at ?? null,
  }
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

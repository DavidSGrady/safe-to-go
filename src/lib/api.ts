import { getSupabase, isDemoMode } from './supabase'
import { demoForecast, demoPredictions, demoReadings, demoRules } from './demo'
import type {
  ForecastPoint,
  Prediction,
  Reading,
  RuleChangeLogEntry,
  SafetyRules,
} from './types'

interface ReadingRow {
  observed_at: string
  water_level_cm: number
}

interface PredictionRow {
  predicted_at: string
  prediction_type: 'minimum' | 'maximum' | '10minutes'
  value_cm: number
}

interface RulesRow {
  flood_margin_cm: number
  fall_margin_cm: number
  caution_max_cm: number
  crossing_minutes: number
  buffer_minutes: number
  min_window_minutes: number
  wind_adjustment_enabled: boolean
  puddle_warning_enabled: boolean
  puddle_warning_range_cm: number
  playback_speed_pct: number
  day_trip_mode: 'daytrip' | 'return' | 'off'
  min_daytrip_minutes: number
  absolute_min_daytrip_minutes: number
  daytrip_rollover_hour: number
  table_granularity_minutes: number
  updated_at: string
}

/** Raw rows for one station, exactly as `/api/conditions` returns them. */
interface StationRows {
  readings: ReadingRow[]
  predictions: PredictionRow[]
  forecast: ForecastRow[]
}

interface ConditionsBundle {
  rules: RulesRow | null
  stations: Record<string, StationRows>
  generatedAt: string
}

/** Everything the app needs for one render pass, keyed by station id. */
export interface ConditionsSnapshot {
  rules: SafetyRules
  readings: Record<string, Reading[]>
  predictions: Record<string, Prediction[]>
  forecast: Record<string, ForecastPoint[]>
}

/**
 * Fetch the whole dataset from the edge-cached Vercel route (`api/conditions.ts`).
 *
 * This is the normal public read path. It exists because querying Supabase from
 * every browser made egress scale with traffic; the payload is identical for all
 * visitors, so it is cached at the edge instead. Returns null when the route is
 * unavailable (demo mode, or a plain `vite dev` session with no serverless
 * function running) so the caller can fall back to querying Supabase directly.
 *
 * Pass `bypassCache` for a user-initiated refresh — pull-to-refresh and the
 * freshness chip promise "the latest", and would otherwise report
 * "nothing new" when the truth is "the cache hasn't rolled over yet".
 */
export async function fetchConditions(bypassCache = false): Promise<ConditionsSnapshot | null> {
  if (isDemoMode) return null
  try {
    const url = bypassCache ? `/api/conditions?t=${Date.now()}` : '/api/conditions'
    const res = await fetch(url, { headers: { Accept: 'application/json' } })
    if (!res.ok) return null
    const bundle = (await res.json()) as ConditionsBundle
    if (!bundle?.rules || !bundle?.stations) return null

    const readings: Record<string, Reading[]> = {}
    const predictions: Record<string, Prediction[]> = {}
    const forecast: Record<string, ForecastPoint[]> = {}
    for (const [id, rows] of Object.entries(bundle.stations)) {
      readings[id] = (rows.readings ?? []).map(mapReading)
      predictions[id] = (rows.predictions ?? []).map(mapPrediction)
      forecast[id] = (rows.forecast ?? []).map(mapForecast)
    }
    return { rules: mapRules(bundle.rules), readings, predictions, forecast }
  } catch {
    // Network error, or the SPA fallback handing back index.html instead of
    // JSON — either way, treat it as "no cached route available".
    return null
  }
}

// Shared by the cached-bundle path and the direct-Supabase fallback so the two
// can never drift apart.
const mapReading = (r: ReadingRow): Reading => ({
  observedAt: r.observed_at,
  levelCm: Number(r.water_level_cm),
})

const mapPrediction = (p: PredictionRow): Prediction => ({
  predictedAt: p.predicted_at,
  predictionType: p.prediction_type,
  levelCm: Number(p.value_cm),
})

const mapForecast = (r: ForecastRow): ForecastPoint => ({
  forecastAt: r.forecast_at,
  levelCm: Number(r.value_cm),
  source: r.source,
  generatedAt: r.generated_at,
})

export async function fetchReadings(stationId: string): Promise<Reading[]> {
  if (isDemoMode) return demoReadings(Date.now())
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const { data, error } = await getSupabase()
    .from('station_readings')
    .select('observed_at, water_level_cm')
    .eq('station_id', stationId)
    .gte('observed_at', since)
    .order('observed_at', { ascending: true })
    .limit(500)
  if (error) throw error
  return (data as ReadingRow[]).map(mapReading)
}

export async function fetchPredictions(stationId: string): Promise<Prediction[]> {
  if (isDemoMode) return demoPredictions(Date.now())
  // Fetch far enough ahead to cover the "see further ahead" 7-day toggle.
  const from = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString()
  const to = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000).toISOString()
  const { data, error } = await getSupabase()
    .from('tide_predictions')
    .select('predicted_at, prediction_type, value_cm')
    .eq('station_id', stationId)
    .gte('predicted_at', from)
    .lte('predicted_at', to)
    .order('predicted_at', { ascending: true })
    .limit(3000)
  if (error) throw error
  return (data as PredictionRow[]).map(mapPrediction)
}

interface ForecastRow {
  forecast_at: string
  value_cm: number
  source: string
  generated_at: string | null
}

export async function fetchForecast(stationId: string): Promise<ForecastPoint[]> {
  if (isDemoMode) return demoForecast(Date.now())
  const from = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
  const to = new Date(Date.now() + 6 * 24 * 60 * 60 * 1000).toISOString()
  // Both sources come back together (station prognosis is 10-minute rows,
  // DKSS hourly — ~900 rows over the 6-day window); tide.ts picks per source.
  const { data, error } = await getSupabase()
    .from('water_level_forecast')
    .select('forecast_at, value_cm, source, generated_at')
    .eq('station_id', stationId)
    .gte('forecast_at', from)
    .lte('forecast_at', to)
    .order('forecast_at', { ascending: true })
    .limit(2000)
  if (error) throw error
  return (data as ForecastRow[]).map(mapForecast)
}

export async function fetchRules(): Promise<SafetyRules> {
  if (isDemoMode) return demoRules
  const { data, error } = await getSupabase()
    .from('safety_rules')
    .select('flood_margin_cm, fall_margin_cm, caution_max_cm, crossing_minutes, buffer_minutes, min_window_minutes, wind_adjustment_enabled, puddle_warning_enabled, puddle_warning_range_cm, playback_speed_pct, day_trip_mode, min_daytrip_minutes, absolute_min_daytrip_minutes, daytrip_rollover_hour, table_granularity_minutes, updated_at')
    .eq('id', 1)
    .single()
  if (error) throw error
  return mapRules(data as RulesRow)
}

function mapRules(row: RulesRow): SafetyRules {
  return {
    floodMarginCm: row.flood_margin_cm,
    fallMarginCm: row.fall_margin_cm,
    cautionMaxCm: row.caution_max_cm,
    crossingMinutes: row.crossing_minutes,
    bufferMinutes: row.buffer_minutes,
    minWindowMinutes: row.min_window_minutes,
    windAdjustmentEnabled: row.wind_adjustment_enabled,
    puddleWarningEnabled: row.puddle_warning_enabled,
    puddleWarningRangeCm: row.puddle_warning_range_cm,
    playbackSpeedPct: row.playback_speed_pct,
    dayTripMode: row.day_trip_mode,
    minDaytripMinutes: row.min_daytrip_minutes,
    absoluteMinDaytripMinutes: row.absolute_min_daytrip_minutes,
    daytripRolloverHour: row.daytrip_rollover_hour,
    tableGranularityMinutes: row.table_granularity_minutes,
    updatedAt: row.updated_at,
  }
}

export async function saveRules(rules: SafetyRules): Promise<void> {
  const { error } = await getSupabase()
    .from('safety_rules')
    .update({
      flood_margin_cm: rules.floodMarginCm,
      fall_margin_cm: rules.fallMarginCm,
      caution_max_cm: rules.cautionMaxCm,
      crossing_minutes: rules.crossingMinutes,
      buffer_minutes: rules.bufferMinutes,
      min_window_minutes: rules.minWindowMinutes,
      wind_adjustment_enabled: rules.windAdjustmentEnabled,
      puddle_warning_enabled: rules.puddleWarningEnabled,
      puddle_warning_range_cm: rules.puddleWarningRangeCm,
      playback_speed_pct: rules.playbackSpeedPct,
      day_trip_mode: rules.dayTripMode,
      min_daytrip_minutes: rules.minDaytripMinutes,
      absolute_min_daytrip_minutes: rules.absoluteMinDaytripMinutes,
      daytrip_rollover_hour: rules.daytripRolloverHour,
      table_granularity_minutes: rules.tableGranularityMinutes,
    })
    .eq('id', 1)
  if (error) throw error
}

export async function fetchRuleChangeLog(): Promise<RuleChangeLogEntry[]> {
  const { data, error } = await getSupabase()
    .from('rule_change_log')
    .select('id, changed_at, changed_by_email, old_values, new_values')
    .order('changed_at', { ascending: false })
    .limit(50)
  if (error) throw error
  return (data as Array<Record<string, unknown>>).map((r) => ({
    id: r.id as number,
    changedAt: r.changed_at as string,
    changedByEmail: (r.changed_by_email as string | null) ?? null,
    oldValues: (r.old_values as Record<string, unknown>) ?? {},
    newValues: (r.new_values as Record<string, unknown>) ?? {},
  }))
}

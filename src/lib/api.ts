import { getSupabase, isDemoMode } from './supabase'
import { demoPredictions, demoReadings, demoRules } from './demo'
import type { Prediction, Reading, RuleChangeLogEntry, SafetyRules } from './types'

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
  safe_max_cm: number
  caution_max_cm: number
  crossing_minutes: number
  buffer_minutes: number
  min_window_minutes: number
  updated_at: string
}

export async function fetchReadings(): Promise<Reading[]> {
  if (isDemoMode) return demoReadings(Date.now())
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const { data, error } = await getSupabase()
    .from('station_readings')
    .select('observed_at, water_level_cm')
    .gte('observed_at', since)
    .order('observed_at', { ascending: true })
    .limit(500)
  if (error) throw error
  return (data as ReadingRow[]).map((r) => ({
    observedAt: r.observed_at,
    levelCm: Number(r.water_level_cm),
  }))
}

export async function fetchPredictions(): Promise<Prediction[]> {
  if (isDemoMode) return demoPredictions(Date.now())
  // Fetch far enough ahead to cover the "see further ahead" 7-day toggle.
  const from = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString()
  const to = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000).toISOString()
  const { data, error } = await getSupabase()
    .from('tide_predictions')
    .select('predicted_at, prediction_type, value_cm')
    .gte('predicted_at', from)
    .lte('predicted_at', to)
    .order('predicted_at', { ascending: true })
    .limit(3000)
  if (error) throw error
  return (data as PredictionRow[]).map((p) => ({
    predictedAt: p.predicted_at,
    predictionType: p.prediction_type,
    levelCm: Number(p.value_cm),
  }))
}

export async function fetchRules(): Promise<SafetyRules> {
  if (isDemoMode) return demoRules
  const { data, error } = await getSupabase()
    .from('safety_rules')
    .select('safe_max_cm, caution_max_cm, crossing_minutes, buffer_minutes, min_window_minutes, updated_at')
    .eq('id', 1)
    .single()
  if (error) throw error
  const row = data as RulesRow
  return {
    safeMaxCm: row.safe_max_cm,
    cautionMaxCm: row.caution_max_cm,
    crossingMinutes: row.crossing_minutes,
    bufferMinutes: row.buffer_minutes,
    minWindowMinutes: row.min_window_minutes,
    updatedAt: row.updated_at,
  }
}

export async function saveRules(rules: SafetyRules): Promise<void> {
  const { error } = await getSupabase()
    .from('safety_rules')
    .update({
      safe_max_cm: rules.safeMaxCm,
      caution_max_cm: rules.cautionMaxCm,
      crossing_minutes: rules.crossingMinutes,
      buffer_minutes: rules.bufferMinutes,
      min_window_minutes: rules.minWindowMinutes,
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

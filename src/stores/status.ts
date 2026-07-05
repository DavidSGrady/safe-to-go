import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { fetchForecast, fetchPredictions, fetchReadings, fetchRules } from '@/lib/api'
import { computeStatus, DEFAULT_HORIZON_HOURS, EXTENDED_HORIZON_HOURS } from '@/lib/tide'
import { isDemoMode, getSupabase } from '@/lib/supabase'
import type { ForecastPoint, Prediction, Reading, SafetyRules } from '@/lib/types'

const RECOMPUTE_MS = 30 * 1000
const REFRESH_MS = 5 * 60 * 1000

export const useStatusStore = defineStore('status', () => {
  const readings = ref<Reading[]>([])
  const predictions = ref<Prediction[]>([])
  const forecast = ref<ForecastPoint[]>([])
  const rules = ref<SafetyRules | null>(null)
  const loading = ref(true)
  const error = ref<string | null>(null)
  const realNow = ref(Date.now())
  const extended = ref(false)

  // Admin preview: when non-null, the whole page is rendered as if it were
  // this many minutes into the future. null = live. The offset (rather than an
  // absolute timestamp) keeps the simulated clock advancing with real time.
  const previewOffsetMin = ref<number | null>(null)

  /** Effective "now" driving every computed on the page — real time, or the
   *  simulated time when an admin is previewing a future moment. */
  const now = computed(() => realNow.value + (previewOffsetMin.value ?? 0) * 60_000)

  let timersStarted = false

  const status = computed(() => {
    if (!rules.value) return null
    const horizon = extended.value ? EXTENDED_HORIZON_HOURS : DEFAULT_HORIZON_HOURS
    return computeStatus(
      readings.value,
      predictions.value,
      forecast.value,
      rules.value,
      now.value,
      horizon,
    )
  })

  function toggleExtended(): void {
    extended.value = !extended.value
  }

  /** Enter/leave admin preview. Pass minutes ahead of now, or null for live. */
  function setPreviewOffset(min: number | null): void {
    previewOffsetMin.value = min
  }

  async function refresh(): Promise<void> {
    try {
      const [r, p, f, ru] = await Promise.all([
        fetchReadings(),
        fetchPredictions(),
        fetchForecast(),
        fetchRules(),
      ])
      readings.value = r
      predictions.value = p
      forecast.value = f
      rules.value = ru
      error.value = null
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    } finally {
      loading.value = false
      realNow.value = Date.now()
    }
  }

  function start(): void {
    if (timersStarted) return
    timersStarted = true
    void refresh()
    setInterval(() => {
      realNow.value = Date.now()
    }, RECOMPUTE_MS)
    setInterval(() => void refresh(), REFRESH_MS)

    if (!isDemoMode) {
      // Live-update when the cron job writes new readings or an admin
      // changes the rules; polling remains as fallback.
      getSupabase()
        .channel('public-data')
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'station_readings' },
          () => void refresh(),
        )
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'safety_rules' },
          () => void refresh(),
        )
        .subscribe()
    }
  }

  return {
    readings,
    predictions,
    forecast,
    rules,
    loading,
    error,
    realNow,
    now,
    extended,
    previewOffsetMin,
    status,
    refresh,
    start,
    toggleExtended,
    setPreviewOffset,
  }
})

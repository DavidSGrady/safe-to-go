import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { fetchPredictions, fetchReadings, fetchRules } from '@/lib/api'
import { computeStatus } from '@/lib/tide'
import { isDemoMode, getSupabase } from '@/lib/supabase'
import type { Prediction, Reading, SafetyRules } from '@/lib/types'

const RECOMPUTE_MS = 30 * 1000
const REFRESH_MS = 5 * 60 * 1000

export const useStatusStore = defineStore('status', () => {
  const readings = ref<Reading[]>([])
  const predictions = ref<Prediction[]>([])
  const rules = ref<SafetyRules | null>(null)
  const loading = ref(true)
  const error = ref<string | null>(null)
  const now = ref(Date.now())

  let timersStarted = false

  const status = computed(() => {
    if (!rules.value) return null
    return computeStatus(readings.value, predictions.value, rules.value, now.value)
  })

  async function refresh(): Promise<void> {
    try {
      const [r, p, ru] = await Promise.all([
        fetchReadings(),
        fetchPredictions(),
        fetchRules(),
      ])
      readings.value = r
      predictions.value = p
      rules.value = ru
      error.value = null
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    } finally {
      loading.value = false
      now.value = Date.now()
    }
  }

  function start(): void {
    if (timersStarted) return
    timersStarted = true
    void refresh()
    setInterval(() => {
      now.value = Date.now()
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

  return { readings, predictions, rules, loading, error, now, status, refresh, start }
})

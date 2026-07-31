import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import {
  fetchConditions,
  fetchForecast,
  fetchPredictions,
  fetchReadings,
  fetchRules,
} from '@/lib/api'
import { computeStatus, DEFAULT_HORIZON_HOURS, EXTENDED_HORIZON_HOURS } from '@/lib/tide'
import { isDemoMode, getSupabase } from '@/lib/supabase'
import { DEFAULT_STATION_ID, STATIONS, stationName } from '@/lib/stations'
import type { ForecastPoint, Prediction, Reading, SafetyRules, StatusResult } from '@/lib/types'

const RECOMPUTE_MS = 30 * 1000
const REFRESH_MS = 5 * 60 * 1000
const SELECTION_KEY = 'stations'

/** Higher = more restrictive. Used to pick the "worst case" when comparing. */
const SEVERITY: Record<StatusResult['state'], number> = {
  unknown: 0,
  safe: 1,
  approaching: 2,
  caution: 3,
  unsafe: 4,
}

// Exactly one station is selected at a time. Accepts the legacy array form
// stored by earlier builds and coerces it to a single id.
function loadSelection(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(SELECTION_KEY) ?? 'null') as unknown
    const candidate = Array.isArray(raw) ? raw[0] : raw
    if (typeof candidate === 'string' && STATIONS.some((s) => s.id === candidate)) {
      return [candidate]
    }
  } catch {
    // ignore malformed storage
  }
  return [DEFAULT_STATION_ID]
}

export const useStatusStore = defineStore('status', () => {
  const readingsByStation = ref<Record<string, Reading[]>>({})
  const predictionsByStation = ref<Record<string, Prediction[]>>({})
  const forecastByStation = ref<Record<string, ForecastPoint[]>>({})
  const rules = ref<SafetyRules | null>(null)
  const loading = ref(true)
  const error = ref<string | null>(null)
  const realNow = ref(Date.now())
  const extended = ref(false)

  const selectedStationIds = ref<string[]>(loadSelection())

  // Admin preview: when non-null, the whole page is rendered as if it were
  // this many minutes into the future. null = live. The offset (rather than an
  // absolute timestamp) keeps the simulated clock advancing with real time.
  const previewOffsetMin = ref<number | null>(null)

  /** Effective "now" driving every computed on the page — real time, or the
   *  simulated time when an admin is previewing a future moment. */
  const now = computed(() => realNow.value + (previewOffsetMin.value ?? 0) * 60_000)

  let timersStarted = false
  let lastRefreshAt = 0

  /** Full status per station, from that station's own readings/forecast. */
  const statusByStation = computed<Record<string, StatusResult | null>>(() => {
    const out: Record<string, StatusResult | null> = {}
    if (!rules.value) return out
    const horizon = extended.value ? EXTENDED_HORIZON_HOURS : DEFAULT_HORIZON_HOURS
    for (const s of STATIONS) {
      out[s.id] = computeStatus(
        readingsByStation.value[s.id] ?? [],
        predictionsByStation.value[s.id] ?? [],
        forecastByStation.value[s.id] ?? [],
        rules.value,
        now.value,
        horizon,
        realNow.value,
      )
    }
    return out
  })

  /** Is `a` a more cautious (more restrictive) verdict than `b`? */
  function moreCautious(a: StatusResult | null, b: StatusResult | null): boolean {
    if (!a) return false
    if (!b) return true
    const sa = SEVERITY[a.state]
    const sb = SEVERITY[b.state]
    if (sa !== sb) return sa > sb
    // Tie on state → the one with more water (closer to flooding) is worse.
    return (a.currentLevelCm ?? -Infinity) > (b.currentLevelCm ?? -Infinity)
  }

  /**
   * The station whose verdict drives the page. One selected → that one.
   * Several → the most cautious, so we never under-warn.
   */
  const primaryStationId = computed(() => {
    const sel = selectedStationIds.value
    if (sel.length <= 1) return sel[0] ?? DEFAULT_STATION_ID
    let bestId = sel[0]
    for (const id of sel.slice(1)) {
      if (moreCautious(statusByStation.value[id], statusByStation.value[bestId])) bestId = id
    }
    return bestId
  })

  const status = computed(() => statusByStation.value[primaryStationId.value] ?? null)

  /** Display name of the station currently driving the page. */
  const primaryStationName = computed(() => stationName(primaryStationId.value))

  /** Selected stations with their individual status, for the comparison row. */
  const selectedStations = computed(() =>
    selectedStationIds.value.map((id) => ({
      id,
      name: stationName(id),
      status: statusByStation.value[id] ?? null,
      primary: id === primaryStationId.value,
    })),
  )

  // Primary station's raw series — used by the admin threshold preview.
  const readings = computed(() => readingsByStation.value[primaryStationId.value] ?? [])
  const predictions = computed(() => predictionsByStation.value[primaryStationId.value] ?? [])
  const forecast = computed(() => forecastByStation.value[primaryStationId.value] ?? [])

  function toggleExtended(): void {
    extended.value = !extended.value
  }

  /** Select the station shown (exactly one). Persisted across visits. */
  function setSelectedStations(ids: string[]): void {
    const first = ids.find((id) => STATIONS.some((s) => s.id === id))
    if (!first) return
    selectedStationIds.value = [first]
    try {
      localStorage.setItem(SELECTION_KEY, JSON.stringify([first]))
    } catch {
      // ignore storage failures
    }
  }

  /** Enter/leave admin preview. Pass minutes ahead of now, or null for live. */
  function setPreviewOffset(min: number | null): void {
    previewOffsetMin.value = min
  }

  /**
   * Load every station's data straight from Supabase. Fallback for when the
   * cached `/api/conditions` route is unavailable — demo mode, a plain
   * `vite dev` session, or the Vercel function failing. This is the original
   * behaviour, kept so the site degrades rather than breaks.
   */
  async function refreshDirect(): Promise<void> {
    const ru = await fetchRules()
    const perStation = await Promise.all(
      STATIONS.map(async (s) => {
        const [r, p, f] = await Promise.all([
          fetchReadings(s.id),
          fetchPredictions(s.id),
          fetchForecast(s.id),
        ])
        return { id: s.id, r, p, f }
      }),
    )
    const rMap: Record<string, Reading[]> = {}
    const pMap: Record<string, Prediction[]> = {}
    const fMap: Record<string, ForecastPoint[]> = {}
    for (const x of perStation) {
      rMap[x.id] = x.r
      pMap[x.id] = x.p
      fMap[x.id] = x.f
    }
    readingsByStation.value = rMap
    predictionsByStation.value = pMap
    forecastByStation.value = fMap
    rules.value = ru
  }

  /**
   * Reload everything.
   *
   * Pass `{ fresh: true }` for anything the user explicitly asked for
   * (pull-to-refresh, the freshness chip, an admin saving thresholds) so it
   * skips the 5-minute edge cache. Automatic polling should leave it off — that
   * is what keeps Supabase egress independent of how many people are on the site.
   */
  async function refresh(opts: { fresh?: boolean } = {}): Promise<void> {
    try {
      const snapshot = await fetchConditions(opts.fresh ?? false)
      if (snapshot) {
        readingsByStation.value = snapshot.readings
        predictionsByStation.value = snapshot.predictions
        forecastByStation.value = snapshot.forecast
        rules.value = snapshot.rules
      } else {
        await refreshDirect()
      }
      error.value = null
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    } finally {
      loading.value = false
      realNow.value = Date.now()
      lastRefreshAt = Date.now()
    }
  }

  function start(): void {
    if (timersStarted) return
    timersStarted = true
    void refresh()
    setInterval(() => {
      realNow.value = Date.now()
    }, RECOMPUTE_MS)
    // Don't poll a tab nobody is looking at. A forgotten open tab used to keep
    // refetching the whole dataset indefinitely; the visibilitychange handler
    // below catches it up the moment it returns.
    setInterval(() => {
      if (document.visibilityState !== 'visible') return
      void refresh()
    }, REFRESH_MS)

    // Browsers throttle timers in hidden tabs, so a phone waking from the
    // pocket could sit on stale data until the next poll. Snap the clock
    // forward immediately and refetch (unless a refresh just ran).
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return
      realNow.value = Date.now()
      if (Date.now() - lastRefreshAt > RECOMPUTE_MS) void refresh()
    })

    if (!isDemoMode) {
      // Live-update when an admin changes the rules. Deliberately NOT subscribed
      // to `station_readings`: it is the one data table in the Realtime
      // publication, the ingest cron writes observations in bulk, and refreshing
      // on every row event made a single cron run trigger dozens of full
      // refetches per open tab — the amplification that blew the egress budget.
      // New observations arrive via the poll above, which is already inside
      // DMI's 10-minute publish cadence.
      getSupabase()
        .channel('public-data')
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'safety_rules' },
          // An admin just changed the thresholds, so skip the cache.
          () => void refresh({ fresh: true }),
        )
        .subscribe()
    }
  }

  return {
    readings,
    readingsByStation,
    predictions,
    predictionsByStation,
    forecast,
    forecastByStation,
    rules,
    loading,
    error,
    realNow,
    now,
    extended,
    previewOffsetMin,
    status,
    statusByStation,
    selectedStationIds,
    selectedStations,
    primaryStationId,
    primaryStationName,
    refresh,
    start,
    toggleExtended,
    setSelectedStations,
    setPreviewOffset,
  }
})

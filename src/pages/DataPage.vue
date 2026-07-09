<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { storeToRefs } from 'pinia'
import { useStatusStore } from '@/stores/status'
import { fmtTime, localTimeMs, startOfNextLocalDay } from '@/lib/format'
import { STATIONS, stationName } from '@/lib/stations'

const { t, locale } = useI18n()
const store = useStatusStore()
const { status, statusByStation, readingsByStation, predictionsByStation, forecastByStation, rules, loading, now } =
  storeToRefs(store)

onMounted(() => store.start())

// Which station's data is shown — page-local so it doesn't change the
// station driving the verdict on the rest of the site. Per tab, like the
// day/scroll below.
const STATION_KEY = 'dataPage.station'
const savedStation = sessionStorage.getItem(STATION_KEY)
const stationId = ref(
  STATIONS.some((s) => s.id === savedStation) ? (savedStation as string) : store.primaryStationId,
)
watch(stationId, (v) => sessionStorage.setItem(STATION_KEY, v))

const viewStatus = computed(() => statusByStation.value[stationId.value] ?? null)
const viewStationName = computed(() => stationName(stationId.value))

// Observations as a sortable curve we can sample at arbitrary ticks.
const observedPoints = computed(() =>
  (readingsByStation.value[stationId.value] ?? [])
    .map((r) => ({ t: Date.parse(r.observedAt), level: r.levelCm }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.level))
    .sort((a, b) => a.t - b.t),
)

function sampleObserved(t: number): number | null {
  const pts = observedPoints.value
  if (pts.length === 0 || t < pts[0].t || t > pts[pts.length - 1].t) return null
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]
    const b = pts[i + 1]
    if (t >= a.t && t <= b.t) {
      const f = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t)
      return a.level + (b.level - a.level) * f
    }
  }
  return pts[pts.length - 1].level
}

// Day picker: yesterday (−1) through five days ahead.
// Selected day and scroll position survive a refresh (per tab), so the page
// reopens where it was left — the async load means the browser's own scroll
// restoration never kicks in.
const DAY_OFFSETS = [-1, 0, 1, 2, 3, 4, 5]
const DAY_KEY = 'dataPage.day'
const SCROLL_KEY = 'dataPage.scroll'

const savedDay = Number(sessionStorage.getItem(DAY_KEY))
const selectedOffset = ref(DAY_OFFSETS.includes(savedDay) ? savedDay : 0)
watch(selectedOffset, (v) => sessionStorage.setItem(DAY_KEY, String(v)))

// Capture the saved position before any scroll listener runs — the browser
// fires a scroll event at 0 during boot, which would clobber it.
const initialScroll = sessionStorage.getItem(SCROLL_KEY)

function saveScroll() {
  sessionStorage.setItem(SCROLL_KEY, String(Math.round(window.scrollY)))
}
onMounted(() => {
  history.scrollRestoration = 'manual'
})
onBeforeUnmount(() => {
  window.removeEventListener('scroll', saveScroll)
  history.scrollRestoration = 'auto'
})

function dayLabelFor(offset: number): string {
  const anchor = now.value + offset * 24 * 60 * 60_000
  const date = new Intl.DateTimeFormat(locale.value, {
    weekday: 'long',
    day: 'numeric',
    month: 'short',
    timeZone: 'Europe/Copenhagen',
  }).format(anchor)
  if (offset === 0) return `${t('common.today')} · ${date}`
  if (offset === 1) return `${t('common.tomorrow')} · ${date}`
  return date
}

const dayOptions = computed(() => DAY_OFFSETS.map((o) => ({ value: o, label: dayLabelFor(o) })))

const roadLevel = computed(() => rules.value?.cautionMaxCm ?? 60)
const granularity = computed(() => rules.value?.tableGranularityMinutes ?? 10)

interface Row {
  t: number
  time: string
  observed: number | null
  forecast: number | null
  drift: number | null
}

const rows = computed<Row[]>(() => {
  if (!viewStatus.value) return []
  const anchor = now.value + selectedOffset.value * 24 * 60 * 60_000
  const dayStart = localTimeMs(anchor, 0)
  const dayEnd = startOfNextLocalDay(anchor)
  const step = granularity.value * 60_000
  const out: Row[] = []
  for (let t = dayStart; t < dayEnd; t += step) {
    const observed = sampleObserved(t)
    const forecast = viewStatus.value.levelAt(t)
    if (observed === null && forecast === null) continue
    out.push({
      t,
      time: fmtTime(t, locale.value),
      observed: observed === null ? null : Math.round(observed),
      forecast: forecast === null ? null : Math.round(forecast),
      drift: observed !== null && forecast !== null ? Math.round(observed - forecast) : null,
    })
  }
  return out
})

// Bar scale from the day's values, padded, always including the road line.
const scale = computed(() => {
  const vals: number[] = [roadLevel.value]
  for (const r of rows.value) {
    if (r.observed !== null) vals.push(r.observed)
    if (r.forecast !== null) vals.push(r.forecast)
  }
  let lo = Math.min(...vals)
  let hi = Math.max(...vals)
  const pad = Math.max(10, (hi - lo) * 0.08)
  lo -= pad
  hi += pad
  return { lo, hi, span: hi - lo || 1 }
})

function pct(v: number): number {
  return Math.min(100, Math.max(0, ((v - scale.value.lo) / scale.value.span) * 100))
}
const roadPct = computed(() => pct(roadLevel.value))

function signed(v: number): string {
  return `${v > 0 ? '+' : ''}${v}`
}

// Δ explainer: user testing showed "Δ" alone reads as jargon. Tapping a
// drift chip opens a popover that says in words what the number means for
// that row (forecast expected more/less water than was measured).
const driftOpenT = ref<number | null>(null)
function toggleDrift(rowT: number) {
  driftOpenT.value = driftOpenT.value === rowT ? null : rowT
}
function driftText(r: Row): string {
  if (r.drift === null) return ''
  const params = { time: r.time, cm: Math.abs(r.drift) }
  if (r.drift > 0) return t('data.drift.higher', params)
  if (r.drift < 0) return t('data.drift.lower', params)
  return t('data.drift.exact', params)
}
function onDocClick(e: MouseEvent) {
  if (!(e.target as HTMLElement).closest?.('.drift-wrap')) driftOpenT.value = null
}
function onDocKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') driftOpenT.value = null
}
onMounted(() => {
  document.addEventListener('click', onDocClick)
  document.addEventListener('keydown', onDocKeydown)
})
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick)
  document.removeEventListener('keydown', onDocKeydown)
})

// The row whose time slot contains "now" (only meaningful on today's view).
const nowRowT = computed(() => {
  if (selectedOffset.value !== 0) return null
  const step = granularity.value * 60_000
  const row = rows.value.find((r) => now.value >= r.t && now.value < r.t + step)
  return row?.t ?? null
})

function jumpToNow(smooth = true) {
  selectedOffset.value = 0
  nextTick(() => {
    document
      .getElementById('now-row')
      ?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'center' })
  })
}

// --- Provenance footer: where each series comes from, when DMI generated
// it and how far it reaches — so a mismatch with dmi.dk can be debugged at
// a glance (stale run, fallback in use, source missing). ---
function fmtStamp(ms: number): string {
  return new Intl.DateTimeFormat(locale.value, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Copenhagen',
  }).format(ms)
}

const observedLine = computed(() => {
  const last = viewStatus.value?.lastObservedAt ?? null
  const params = { station: viewStationName.value, id: stationId.value }
  return last === null
    ? t('data.sources.observedNone', params)
    : t('data.sources.observed', { ...params, time: fmtStamp(last) })
})

interface SourceLine {
  key: string
  text: string
  inUse: boolean
}

const forecastLines = computed<SourceLine[]>(() => {
  const fc = forecastByStation.value[stationId.value] ?? []
  const active = viewStatus.value?.forecastSource ?? 'none'

  // Latest run time + coverage end per source group.
  const agg: Record<'station' | 'dkss', { updated: number; until: number } | null> = {
    station: null,
    dkss: null,
  }
  for (const p of fc) {
    const key = p.source === 'dmi_station' ? 'station' : 'dkss'
    const until = Date.parse(p.forecastAt)
    if (!Number.isFinite(until)) continue
    const gen = Date.parse(p.generatedAt ?? '')
    const cur = agg[key] ?? { updated: -Infinity, until: -Infinity }
    cur.until = Math.max(cur.until, until)
    if (Number.isFinite(gen)) cur.updated = Math.max(cur.updated, gen)
    agg[key] = cur
  }
  let astroUntil = -Infinity
  for (const p of predictionsByStation.value[stationId.value] ?? []) {
    const ts = Date.parse(p.predictedAt)
    if (Number.isFinite(ts)) astroUntil = Math.max(astroUntil, ts)
  }

  const line = (
    key: 'station' | 'dkss' | 'astro',
    info: { updated: number; until: number } | null,
    inUse: boolean,
  ): SourceLine => {
    const parts = [t(`data.sources.${key}`)]
    if (info === null) parts.push(t('data.sources.missing'))
    else {
      if (info.updated > -Infinity) parts.push(t('data.sources.updated', { time: fmtStamp(info.updated) }))
      if (info.until > -Infinity) parts.push(t('data.sources.until', { time: fmtStamp(info.until) }))
    }
    return { key, text: parts.join(' · '), inUse }
  }

  return [
    line('station', agg.station, active === 'station'),
    line('dkss', agg.dkss, active === 'dkss'),
    line('astro', astroUntil > -Infinity ? { updated: -Infinity, until: astroUntil } : null, active === 'astronomical'),
  ]
})

// Position the view once the first non-empty day renders: restore the saved
// scroll if there is one, otherwise center on "now". Only then start
// recording scroll, so boot-time scroll events can't overwrite the position.
let positioned = false
watch(
  rows,
  async (rs) => {
    if (positioned || rs.length === 0) return
    positioned = true
    await nextTick()
    if (initialScroll !== null) window.scrollTo(0, Number(initialScroll))
    else jumpToNow(false)
    window.addEventListener('scroll', saveScroll, { passive: true })
  },
  { immediate: true },
)
</script>

<template>
  <div class="page">
    <header class="top">
      <h1>{{ t('data.title') }}</h1>
      <RouterLink to="/" class="muted">{{ t('data.back') }}</RouterLink>
    </header>

    <p class="secondary intro">{{ t('data.intro', { station: viewStationName }) }}</p>

    <div v-if="loading && !status" class="card skeleton" aria-busy="true"></div>

    <template v-else>
      <div class="controls">
        <span class="day-label">{{ t('data.stationLabel') }}</span>
        <div class="seg" role="group" :aria-label="t('data.stationLabel')">
          <button
            v-for="s in STATIONS"
            :key="s.id"
            type="button"
            class="seg-btn"
            :class="{ active: s.id === stationId }"
            :aria-pressed="s.id === stationId"
            @click="stationId = s.id"
          >
            {{ s.name }}
          </button>
        </div>
        <label for="day" class="day-label">{{ t('data.selectDay') }}</label>
        <select id="day" v-model.number="selectedOffset" class="select">
          <option v-for="d in dayOptions" :key="d.value" :value="d.value">{{ d.label }}</option>
        </select>
        <button type="button" class="now-btn" @click="jumpToNow()">{{ t('data.jumpToNow') }}</button>
      </div>

      <p class="legend">
        {{ t('data.legend', { road: roadLevel }) }}
        <span class="legend-key"><span class="dot under"></span>{{ t('data.belowRoad') }}</span>
        <span class="legend-key"><span class="dot over"></span>{{ t('data.aboveRoad') }}</span>
        <span class="legend-key"><span class="drift-key">Δ</span>{{ t('data.driftKey') }}</span>
      </p>

      <p v-if="rows.length === 0" class="card none">{{ t('data.noData') }}</p>

      <ol v-else class="rows" :aria-label="t('data.title')">
        <li
          v-for="r in rows"
          :key="r.t"
          class="row"
          :class="{ 'is-now': r.t === nowRowT }"
          :id="r.t === nowRowT ? 'now-row' : undefined"
          :aria-current="r.t === nowRowT ? 'time' : undefined"
          :title="r.t === nowRowT ? t('data.nowTag') : undefined"
        >
          <span class="time mono">{{ r.time }}</span>
          <div class="bar-track">
            <div
              class="bar-fill"
              :class="[
                (r.observed ?? r.forecast ?? 0) > roadLevel ? 'over' : 'under',
                r.observed === null ? 'is-forecast' : '',
              ]"
              :style="{ width: pct(r.observed ?? r.forecast ?? 0) + '%' }"
            ></div>
            <div class="road-marker" :style="{ left: roadPct + '%' }" :title="t('data.roadMarker')"></div>
          </div>
          <span class="val mono" :class="{ muted: r.observed === null }">
            {{ signed(r.observed ?? r.forecast ?? 0) }}
          </span>
          <div v-if="r.drift !== null" class="drift-wrap">
            <button
              type="button"
              class="drift mono"
              :aria-expanded="driftOpenT === r.t"
              :aria-label="t('data.drift.title')"
              @click="toggleDrift(r.t)"
            >
              Δ{{ signed(r.drift) }}
            </button>
            <div v-if="driftOpenT === r.t" class="drift-pop" role="note">
              <strong>{{ t('data.drift.title') }}</strong>
              <p>{{ driftText(r) }}</p>
              <p class="drift-pop-generic">{{ t('data.drift.generic') }}</p>
            </div>
          </div>
          <span v-else-if="r.observed === null" class="tag">{{ t('data.forecastTag') }}</span>
          <span v-else class="tag spacer"></span>
        </li>
      </ol>

      <footer class="datasrc">
        <h2 class="datasrc-title">{{ t('data.sources.title') }}</h2>
        <ul class="datasrc-list">
          <li>{{ observedLine }}</li>
          <li v-for="l in forecastLines" :key="l.key" :class="{ 'is-active': l.inUse }">
            {{ l.text }}
            <span v-if="l.inUse" class="in-use">{{ t('data.sources.inUse') }}</span>
          </li>
        </ul>
      </footer>
    </template>
  </div>
</template>

<style scoped>
.top {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 12px;
  margin-bottom: 8px;
  flex-wrap: wrap;
}
.top h1 {
  font-size: 1.3rem;
  margin: 0;
}

.intro {
  font-size: 0.9rem;
  margin: 0 0 14px;
}

/* Sticky so day/station/now controls stay reachable while scrolling the
   long table (the page is mobile-first; the column is phone-width anyway).
   Negative margins bleed the background to the page edges. */
.controls {
  position: sticky;
  top: 0;
  z-index: 10;
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 8px 10px;
  margin: 0 -16px 12px;
  padding: 10px 16px;
  background: var(--page);
  border-bottom: 1px solid var(--border);
}
.seg {
  grid-column: 2 / -1;
  display: flex;
  min-width: 0;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  overflow: hidden;
}
.seg-btn {
  flex: 1;
  min-width: 0;
  padding: 8px 4px;
  border: none;
  background: none;
  color: var(--text-secondary);
  font: inherit;
  font-size: 0.8rem;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.seg-btn + .seg-btn {
  border-left: 1px solid var(--border);
}
.seg-btn.active {
  background: var(--accent);
  color: #fff;
  font-weight: 600;
}
.day-label {
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--text-secondary);
  flex: none;
}
.select {
  flex: 1;
  min-width: 0;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text-primary);
  font: inherit;
  accent-color: var(--accent);
}
.now-btn {
  flex: none;
  padding: 8px 12px;
  border: 1px solid var(--accent);
  border-radius: 8px;
  background: var(--surface);
  color: var(--accent);
  font: inherit;
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
}

.legend {
  font-size: 0.72rem;
  color: var(--text-muted);
  line-height: 1.7;
  margin: 0 0 12px;
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  align-items: center;
}
.legend-key {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.dot {
  width: 10px;
  height: 10px;
  border-radius: 3px;
  display: inline-block;
}
.dot.under {
  background: var(--verdict-safe-accent);
}
.dot.over {
  background: var(--verdict-unsafe-accent);
}
.drift-key {
  font-weight: 700;
  color: var(--text-secondary);
}

.rows {
  list-style: none;
  margin: 0;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 12px;
  /* No overflow:hidden — it would clip the Δ explainer popover. The row
     backgrounds get their own corner rounding instead. */
  background: var(--surface);
}
.row:first-child {
  border-radius: 11px 11px 0 0;
}
.row:last-child {
  border-radius: 0 0 11px 11px;
}

.row {
  display: grid;
  grid-template-columns: 3.4em 1fr 3em 3.2em;
  align-items: center;
  gap: 8px;
  padding: 5px 12px;
  font-size: 12.5px;
}
.row:nth-child(even) {
  background: var(--page);
}
.row.is-now {
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  box-shadow: inset 3px 0 0 var(--accent);
}
.row.is-now .time {
  color: var(--accent);
  font-weight: 700;
}

.time {
  color: var(--text-secondary);
  font-size: 12px;
}

.bar-track {
  position: relative;
  height: 14px;
  background: var(--grid);
  border-radius: 4px;
  overflow: hidden;
}
.bar-fill {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  border-radius: 4px 0 0 4px;
}
.bar-fill.under {
  background: var(--verdict-safe-accent);
}
.bar-fill.over {
  background: var(--verdict-unsafe-accent);
}
.bar-fill.is-forecast {
  opacity: 0.45;
}
.road-marker {
  position: absolute;
  top: -1px;
  bottom: -1px;
  width: 2px;
  background: var(--text-primary);
  transform: translateX(-1px);
}

.val {
  text-align: right;
  font-weight: 600;
}
.val.muted {
  color: var(--text-muted);
  font-weight: 500;
}

.drift-wrap {
  position: relative;
  text-align: right;
}
.drift {
  padding: 1px 2px;
  border: none;
  border-bottom: 1px dotted var(--text-muted);
  background: none;
  font: inherit;
  font-size: 11px;
  color: var(--text-secondary);
  cursor: pointer;
}
.drift-pop {
  position: absolute;
  right: 0;
  top: calc(100% + 6px);
  width: min(270px, 76vw);
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
  z-index: 30;
  text-align: left;
  white-space: normal;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-secondary);
}
.drift-pop strong {
  display: block;
  margin-bottom: 4px;
  color: var(--text-primary);
  font-size: 12px;
}
.drift-pop p {
  margin: 0;
}
.drift-pop-generic {
  margin-top: 6px !important;
  color: var(--text-muted);
  font-size: 11px;
}
.tag {
  text-align: right;
  font-size: 10px;
  color: var(--text-muted);
}

.none {
  color: var(--text-muted);
}

.datasrc {
  margin-top: 14px;
  font-size: 0.72rem;
  color: var(--text-muted);
  line-height: 1.6;
}
.datasrc-title {
  font-size: 0.72rem;
  font-weight: 600;
  color: var(--text-secondary);
  margin: 0 0 4px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.datasrc-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.datasrc-list li.is-active {
  color: var(--text-secondary);
}
.in-use {
  display: inline-block;
  margin-left: 4px;
  padding: 0 6px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  color: var(--accent);
  font-weight: 600;
}
.skeleton {
  height: 300px;
  animation: pulse 1.2s ease-in-out infinite;
}
@keyframes pulse {
  50% {
    opacity: 0.5;
  }
}
</style>

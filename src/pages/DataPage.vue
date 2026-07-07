<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { storeToRefs } from 'pinia'
import { useStatusStore } from '@/stores/status'
import { fmtTime, localTimeMs, startOfNextLocalDay } from '@/lib/format'

const { t, locale } = useI18n()
const store = useStatusStore()
const { status, readings, rules, loading, now, primaryStationName } = storeToRefs(store)

onMounted(() => store.start())

// Observations as a sortable curve we can sample at arbitrary ticks.
const observedPoints = computed(() =>
  readings.value
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
const DAY_OFFSETS = [-1, 0, 1, 2, 3, 4, 5]
const selectedOffset = ref(0)

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
  if (!status.value) return []
  const anchor = now.value + selectedOffset.value * 24 * 60 * 60_000
  const dayStart = localTimeMs(anchor, 0)
  const dayEnd = startOfNextLocalDay(anchor)
  const step = granularity.value * 60_000
  const out: Row[] = []
  for (let t = dayStart; t < dayEnd; t += step) {
    const observed = sampleObserved(t)
    const forecast = status.value.levelAt(t)
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
</script>

<template>
  <div class="page">
    <header class="top">
      <h1>{{ t('data.title') }}</h1>
      <RouterLink to="/" class="muted">{{ t('data.back') }}</RouterLink>
    </header>

    <p class="secondary intro">{{ t('data.intro', { station: primaryStationName }) }}</p>

    <div v-if="loading && !status" class="card skeleton" aria-busy="true"></div>

    <template v-else>
      <div class="controls">
        <label for="day" class="day-label">{{ t('data.selectDay') }}</label>
        <select id="day" v-model.number="selectedOffset" class="select">
          <option v-for="d in dayOptions" :key="d.value" :value="d.value">{{ d.label }}</option>
        </select>
      </div>

      <p class="legend">
        {{ t('data.legend', { road: roadLevel }) }}
        <span class="legend-key"><span class="dot under"></span>{{ t('data.belowRoad') }}</span>
        <span class="legend-key"><span class="dot over"></span>{{ t('data.aboveRoad') }}</span>
        <span class="legend-key"><span class="drift-key">Δ</span>{{ t('data.driftKey') }}</span>
      </p>

      <p v-if="rows.length === 0" class="card none">{{ t('data.noData') }}</p>

      <ol v-else class="rows" :aria-label="t('data.title')">
        <li v-for="r in rows" :key="r.t" class="row">
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
          <span v-if="r.drift !== null" class="drift mono" :title="t('data.driftKey')">Δ{{ signed(r.drift) }}</span>
          <span v-else-if="r.observed === null" class="tag">{{ t('data.forecastTag') }}</span>
          <span v-else class="tag spacer"></span>
        </li>
      </ol>
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

.controls {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
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
  overflow: hidden;
  background: var(--surface);
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

.drift {
  text-align: right;
  font-size: 11px;
  color: var(--text-secondary);
}
.tag {
  text-align: right;
  font-size: 10px;
  color: var(--text-muted);
}

.none {
  color: var(--text-muted);
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

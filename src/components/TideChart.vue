<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { fmtDateTime, fmtTime } from '@/lib/format'
import type { CurvePoint, SafetyRules } from '@/lib/types'

const props = defineProps<{
  curve: CurvePoint[]
  rules: SafetyRules
  now: number
}>()

const { t, locale } = useI18n()

const W = 640
const H = 260
const PAD = { top: 12, right: 12, bottom: 28, left: 40 }
const plotW = W - PAD.left - PAD.right
const plotH = H - PAD.top - PAD.bottom

const tMin = computed(() => (props.curve.length ? props.curve[0].t : props.now))
const tMax = computed(() =>
  props.curve.length ? props.curve[props.curve.length - 1].t : props.now + 1,
)

const yDomain = computed(() => {
  const levels = props.curve.map((p) => p.level)
  levels.push(props.rules.safeMaxCm, props.rules.cautionMaxCm)
  let lo = Math.min(...levels)
  let hi = Math.max(...levels)
  const pad = Math.max(15, (hi - lo) * 0.12)
  lo = Math.floor((lo - pad) / 25) * 25
  hi = Math.ceil((hi + pad) / 25) * 25
  return { lo, hi }
})

function x(tms: number): number {
  return PAD.left + ((tms - tMin.value) / (tMax.value - tMin.value)) * plotW
}

function y(level: number): number {
  const { lo, hi } = yDomain.value
  return PAD.top + (1 - (level - lo) / (hi - lo)) * plotH
}

const observedPoints = computed(() => props.curve.filter((p) => p.observed))
const forecastPoints = computed(() => props.curve.filter((p) => !p.observed))

function toPath(points: CurvePoint[]): string {
  return points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.t).toFixed(1)},${y(p.level).toFixed(1)}`)
    .join(' ')
}

const observedPath = computed(() => toPath(observedPoints.value))
const forecastPath = computed(() => toPath(forecastPoints.value))

const yTicks = computed(() => {
  const { lo, hi } = yDomain.value
  const span = hi - lo
  const step = span > 300 ? 100 : span > 150 ? 50 : 25
  const ticks: number[] = []
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) ticks.push(v)
  return ticks
})

const hourFmt = new Intl.DateTimeFormat('en-GB', {
  hour: 'numeric',
  hour12: false,
  timeZone: 'Europe/Copenhagen',
})

const xTicks = computed(() => {
  // A tick every 6 hours, snapped to whole hours in Danish local time
  const ticks: number[] = []
  const start = Math.ceil(tMin.value / 3600_000) * 3600_000
  for (let tms = start; tms <= tMax.value; tms += 3600_000) {
    if (Number(hourFmt.format(tms)) % 6 === 0) ticks.push(tms)
  }
  return ticks
})

// Threshold band geometry (safe wash below safeMax, danger wash above cautionMax)
const safeBand = computed(() => {
  const top = y(props.rules.safeMaxCm)
  return { y: top, h: Math.max(0, PAD.top + plotH - top) }
})
const dangerBand = computed(() => {
  const bottom = y(props.rules.cautionMaxCm)
  return { y: PAD.top, h: Math.max(0, bottom - PAD.top) }
})

// --- Hover / touch crosshair ---
const svgEl = ref<SVGSVGElement | null>(null)
const hover = ref<{ t: number; level: number; px: number; py: number } | null>(null)

function onPointerMove(e: PointerEvent): void {
  if (!svgEl.value || props.curve.length === 0) return
  const rect = svgEl.value.getBoundingClientRect()
  const relX = ((e.clientX - rect.left) / rect.width) * W
  const tms = tMin.value + ((relX - PAD.left) / plotW) * (tMax.value - tMin.value)
  let best = props.curve[0]
  for (const p of props.curve) {
    if (Math.abs(p.t - tms) < Math.abs(best.t - tms)) best = p
  }
  hover.value = { t: best.t, level: best.level, px: x(best.t), py: y(best.level) }
}

function onPointerLeave(): void {
  hover.value = null
}

const showTable = ref(false)

const tableRows = computed(() => {
  // Hourly rows keep the table skimmable
  const rows: CurvePoint[] = []
  let lastHour = -1
  for (const p of props.curve) {
    const h = Math.floor(p.t / 3600_000)
    if (h !== lastHour) {
      rows.push(p)
      lastHour = h
    }
  }
  return rows
})
</script>

<template>
  <div>
    <svg
      ref="svgEl"
      :viewBox="`0 0 ${W} ${H}`"
      class="chart"
      role="img"
      :aria-label="t('chart.title')"
      @pointermove="onPointerMove"
      @pointerleave="onPointerLeave"
    >
      <!-- threshold washes -->
      <rect :x="PAD.left" :y="safeBand.y" :width="plotW" :height="safeBand.h" class="band-safe" />
      <rect :x="PAD.left" :y="dangerBand.y" :width="plotW" :height="dangerBand.h" class="band-danger" />

      <!-- gridlines + y labels -->
      <g v-for="v in yTicks" :key="'y' + v">
        <line :x1="PAD.left" :x2="PAD.left + plotW" :y1="y(v)" :y2="y(v)" class="grid" />
        <text :x="PAD.left - 6" :y="y(v) + 4" class="tick" text-anchor="end">{{ v }}</text>
      </g>

      <!-- x labels -->
      <g v-for="tms in xTicks" :key="'x' + tms">
        <text :x="x(tms)" :y="H - 8" class="tick" text-anchor="middle">
          {{ fmtTime(tms, locale) }}
        </text>
      </g>

      <!-- threshold lines -->
      <line
        :x1="PAD.left" :x2="PAD.left + plotW"
        :y1="y(rules.safeMaxCm)" :y2="y(rules.safeMaxCm)"
        class="threshold threshold-safe"
      />
      <line
        :x1="PAD.left" :x2="PAD.left + plotW"
        :y1="y(rules.cautionMaxCm)" :y2="y(rules.cautionMaxCm)"
        class="threshold threshold-danger"
      />

      <!-- now marker -->
      <line :x1="x(now)" :x2="x(now)" :y1="PAD.top" :y2="PAD.top + plotH" class="now-line" />
      <text :x="x(now)" :y="PAD.top + 10" class="now-label" text-anchor="middle">
        {{ t('chart.now') }}
      </text>

      <!-- data -->
      <path :d="observedPath" class="line observed" />
      <path :d="forecastPath" class="line forecast" />

      <!-- crosshair tooltip -->
      <g v-if="hover">
        <line :x1="hover.px" :x2="hover.px" :y1="PAD.top" :y2="PAD.top + plotH" class="crosshair" />
        <circle :cx="hover.px" :cy="hover.py" r="5" class="hover-dot" />
        <g :transform="`translate(${Math.min(Math.max(hover.px - 60, PAD.left), W - 132)}, ${PAD.top + 14})`">
          <rect width="120" height="40" rx="8" class="tooltip-bg" />
          <text x="10" y="17" class="tooltip-text">{{ fmtDateTime(hover.t, locale) }}</text>
          <text x="10" y="33" class="tooltip-text strong">{{ Math.round(hover.level) }} {{ t('chart.unit') }}</text>
        </g>
      </g>
    </svg>

    <div class="legend">
      <span class="key"><svg width="22" height="8"><line x1="1" y1="4" x2="21" y2="4" class="line observed" /></svg>{{ t('chart.observed') }}</span>
      <span class="key"><svg width="22" height="8"><line x1="1" y1="4" x2="21" y2="4" class="line forecast" /></svg>{{ t('chart.forecast') }}</span>
      <span class="key"><span class="swatch swatch-safe"></span>{{ t('chart.safeLimit') }}: {{ rules.safeMaxCm }} {{ t('chart.unit') }}</span>
      <span class="key"><span class="swatch swatch-danger"></span>{{ t('chart.unsafeLimit') }}: {{ rules.cautionMaxCm }} {{ t('chart.unit') }}</span>
    </div>

    <button class="btn-link" type="button" @click="showTable = !showTable">
      {{ t('chart.tableView') }}
    </button>
    <div v-if="showTable" class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>{{ t('chart.time') }}</th>
            <th>{{ t('chart.level') }}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in tableRows" :key="row.t">
            <td>{{ fmtDateTime(row.t, locale) }}</td>
            <td>{{ Math.round(row.level) }}</td>
            <td class="muted">{{ row.observed ? t('chart.observed') : t('chart.forecast') }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.chart {
  width: 100%;
  height: auto;
  display: block;
  touch-action: pan-y;
}

.band-safe {
  fill: var(--verdict-safe-accent);
  opacity: 0.08;
}

.band-danger {
  fill: var(--verdict-unsafe-accent);
  opacity: 0.08;
}

.grid {
  stroke: var(--grid);
  stroke-width: 1;
}

.tick {
  fill: var(--text-muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.threshold {
  stroke-width: 1;
}

.threshold-safe {
  stroke: var(--verdict-safe-accent);
}

.threshold-danger {
  stroke: var(--verdict-unsafe-accent);
}

.now-line {
  stroke: var(--baseline);
  stroke-width: 1;
}

.now-label {
  fill: var(--text-muted);
  font-size: 11px;
}

.line {
  fill: none;
  stroke: var(--series-observed);
  stroke-width: 2;
  stroke-linejoin: round;
  stroke-linecap: round;
}

.line.forecast {
  stroke-dasharray: 5 5;
}

.crosshair {
  stroke: var(--baseline);
  stroke-width: 1;
}

.hover-dot {
  fill: var(--series-observed);
  stroke: var(--surface);
  stroke-width: 2;
}

.tooltip-bg {
  fill: var(--surface);
  stroke: var(--border);
}

.tooltip-text {
  fill: var(--text-secondary);
  font-size: 11px;
}

.tooltip-text.strong {
  fill: var(--text-primary);
  font-weight: 600;
  font-size: 13px;
}

.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
  margin-top: 8px;
  font-size: 0.82rem;
  color: var(--text-secondary);
}

.key {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.swatch {
  width: 10px;
  height: 10px;
  border-radius: 3px;
  display: inline-block;
}

.swatch-safe {
  background: var(--verdict-safe-accent);
}

.swatch-danger {
  background: var(--verdict-unsafe-accent);
}

.btn-link {
  background: none;
  border: none;
  color: var(--accent);
  padding: 8px 0 0;
  cursor: pointer;
  font-size: 0.85rem;
  text-decoration: underline;
}

.table-wrap {
  overflow-x: auto;
  margin-top: 8px;
  max-height: 320px;
  overflow-y: auto;
}
</style>

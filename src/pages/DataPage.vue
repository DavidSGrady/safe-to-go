<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { storeToRefs } from 'pinia'
import { useStatusStore } from '@/stores/status'
import { fmtTime, localTimeMs, splitDuration, startOfNextLocalDay } from '@/lib/format'
import { findWindows } from '@/lib/tide'
import type { SafeWindow } from '@/lib/types'
import { STATIONS, stationName } from '@/lib/stations'
import LangSwitcher from '@/components/LangSwitcher.vue'
import FirstVisitNotice from '@/components/FirstVisitNotice.vue'
import { usePullToRefresh } from '@/composables/usePullToRefresh'

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

// Freshness chip in the sticky controls: how old the newest measurement for
// the viewed station is. Ticks with the 30 s clock, flips to the stale style
// past the app-wide freshness window (same logic as the status hero).
const freshness = computed(() => {
  const s = viewStatus.value
  if (!s || s.lastObservedAt === null) return null
  const { hours, minutes } = splitDuration(Math.max(0, now.value - s.lastObservedAt))
  const duration =
    hours > 0 ? t('common.agoHoursMinutes', { hours, minutes }) : t('common.agoMinutes', { minutes })
  return {
    fresh: s.dataFresh,
    text: s.dataFresh ? t('verdict.freshFresh', { duration }) : t('verdict.freshStale', { duration }),
    // Narrow screens: just the age, so the chip leaves room for the now-strip.
    short:
      hours > 0
        ? t('common.agoHoursMinutesShort', { hours, minutes })
        : t('common.agoMinutesShort', { minutes }),
  }
})

// The now-strip in the sticky controls: current level + trend for the viewed
// station. Rising vs falling is the heart of the safety model, and this is
// the only place the raw-data page states it.
const nowInfo = computed(() => {
  const s = viewStatus.value
  if (!s || s.currentLevelCm === null) return null
  return { level: Math.round(s.currentLevelCm), rising: s.rising }
})

// Pull-to-refresh for phones (incl. installed standalone PWA, where there is
// no browser reload UI). Refetches data — no page reload. Shares the
// "checked, nothing new" feedback with the chip below.
const { pullPx, ready, refreshing } = usePullToRefresh(checkForNew)

// After a refresh that found nothing newer, the chip's age text wouldn't
// change — indistinguishable from a refresh that silently failed. Show
// "checked just now · nothing new" for a few seconds so the outcome is
// visible either way (new data updates the age text by itself).
const checkedNoNew = ref(false)
let checkedTimer: ReturnType<typeof setTimeout> | undefined
async function checkForNew(): Promise<void> {
  const before = viewStatus.value?.lastObservedAt ?? null
  await store.refresh()
  const after = viewStatus.value?.lastObservedAt ?? null
  if (before !== null && after === before) {
    checkedNoNew.value = true
    clearTimeout(checkedTimer)
    checkedTimer = setTimeout(() => (checkedNoNew.value = false), 6000)
  }
}
onBeforeUnmount(() => clearTimeout(checkedTimer))

// The freshness chip doubles as a refresh button — pull-to-refresh only
// works from the very top of the page, and the chip is what stays in view
// (sticky) when someone is deep in the day table.
const chipRefreshing = ref(false)
async function refreshNow(): Promise<void> {
  if (chipRefreshing.value) return
  chipRefreshing.value = true
  const started = Date.now()
  try {
    await checkForNew()
  } finally {
    // Keep the spin visible long enough to register as feedback.
    setTimeout(() => (chipRefreshing.value = false), Math.max(0, 400 - (Date.now() - started)))
  }
}

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

// --- Row safety state ---
// The bars reuse the same window engine as the frontpage verdict (fall
// margin, min window length, deadline = flood time − crossing − buffer), so
// /data can never show green at a moment the frontpage would call "do not
// start": a brief dip below the road level stays amber (never a valid
// window), and rising water turns amber at the deadline, well before it
// reaches the road. The curve is observed-first — the same series the bars
// display — falling back to the chosen forecast.
const DAY_MS = 24 * 60 * 60_000
const dayWindows = computed<SafeWindow[]>(() => {
  const st = viewStatus.value
  const r = rules.value
  if (!st || !r) return []
  const anchor = now.value + selectedOffset.value * DAY_MS
  const dayStart = localTimeMs(anchor, 0)
  const dayEnd = startOfNextLocalDay(anchor)
  const levelFn = (t: number) => sampleObserved(t) ?? st.levelAt(t)
  // Scan well past dayEnd so a window spanning midnight gets its real flood
  // time (and thus deadline); findWindows itself looks back before dayStart
  // for a window already open at midnight.
  return findWindows(levelFn, r, dayStart, dayEnd + 8 * 60 * 60_000)
})

type RowSafety = 'safe' | 'caution' | 'flooded'
function safetyFor(t: number, level: number): RowSafety {
  if (level > roadLevel.value) return 'flooded'
  const w = dayWindows.value.find((w) => w.start <= t && t < w.end)
  return w && t <= w.deadline ? 'safe' : 'caution'
}

interface Row {
  t: number
  time: string
  observed: number | null
  forecast: number | null
  drift: number | null
  safety: RowSafety
}

// Time range covered by the weather-inclusive forecast rows loaded for this
// station (station prognosis + DKSS). Outside it, levelAt() silently falls
// back to the astronomical tide — comparing a measurement against that is
// mostly just the wind surge, so Δ is hidden there (misleading, not useful).
const weatherCoverage = computed<{ from: number; to: number } | null>(() => {
  let from = Infinity
  let to = -Infinity
  for (const p of forecastByStation.value[stationId.value] ?? []) {
    const ts = Date.parse(p.forecastAt)
    if (!Number.isFinite(ts)) continue
    if (ts < from) from = ts
    if (ts > to) to = ts
  }
  return from < to ? { from, to } : null
})

const rows = computed<Row[]>(() => {
  if (!viewStatus.value) return []
  const anchor = now.value + selectedOffset.value * 24 * 60 * 60_000
  const dayStart = localTimeMs(anchor, 0)
  const dayEnd = startOfNextLocalDay(anchor)
  const step = granularity.value * 60_000
  // With the wind toggle off, the astronomical curve IS the chosen forecast —
  // Δ against it is intended, not a fallback, so it stays visible.
  const usingWeather =
    viewStatus.value.forecastSource === 'station' || viewStatus.value.forecastSource === 'dkss'
  const cover = weatherCoverage.value
  const out: Row[] = []
  for (let t = dayStart; t < dayEnd; t += step) {
    const observed = sampleObserved(t)
    const forecast = viewStatus.value.levelAt(t)
    if (observed === null && forecast === null) continue
    const weatherCovered = !usingWeather || (cover !== null && t >= cover.from && t <= cover.to)
    const shown = Math.round((observed ?? forecast) as number)
    out.push({
      t,
      time: fmtTime(t, locale.value),
      observed: observed === null ? null : Math.round(observed),
      forecast: forecast === null ? null : Math.round(forecast),
      drift:
        observed !== null && forecast !== null && weatherCovered
          ? Math.round(observed - forecast)
          : null,
      // Judged on the rounded value the row displays, so number and color
      // can never disagree.
      safety: safetyFor(t, shown),
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
  roadOpen.value = false
  cautionOpenT.value = null
}

// "Last safe start" boundary: a marker rendered between the last green row
// and the first amber row of each window, carrying the exact deadline time
// (the rows themselves are only slot-aligned).
const deadlineByRowT = computed<Map<number, string>>(() => {
  const map = new Map<number, string>()
  const rs = rows.value
  if (rs.length === 0) return map
  const step = granularity.value * 60_000
  for (const w of dayWindows.value) {
    if (w.deadline <= w.start) continue
    const row = rs.find((r) => w.deadline >= r.t && w.deadline < r.t + step)
    if (row) map.set(row.t, fmtTime(w.deadline, locale.value))
  }
  return map
})

// Amber-row explainer: tapping an amber bar says *why* starting a crossing
// is unsafe at that time (same popover pattern as the Δ chips).
const cautionOpenT = ref<number | null>(null)
function toggleCaution(rowT: number) {
  cautionOpenT.value = cautionOpenT.value === rowT ? null : rowT
  driftOpenT.value = null
  roadOpen.value = false
}
function cautionText(r: Row): string {
  const minutes = (rules.value?.crossingMinutes ?? 0) + (rules.value?.bufferMinutes ?? 0)
  const w = dayWindows.value.find((w) => w.start <= r.t && r.t < w.end)
  if (w) {
    // Inside a window but past its deadline — passable, no time to cross.
    return w.floodsAt !== null
      ? t('data.caution.late', {
          road: roadLevel.value,
          time: fmtTime(w.floodsAt, locale.value),
          minutes,
        })
      : t('data.caution.lateNoTime', { minutes })
  }
  const next = dayWindows.value.find((w) => w.start > r.t)
  if (next) return t('data.caution.early', { time: fmtTime(next.start, locale.value) })
  return t('data.caution.brief')
}

// Road-line explainer: same user testing — "what is the line on all the
// rows?". A sticky axis strip labels the line once, right above it, and the
// label opens a popover (same interaction as the Δ chips).
const roadOpen = ref(false)
function toggleRoad() {
  roadOpen.value = !roadOpen.value
  driftOpenT.value = null
  cautionOpenT.value = null
}

// The axis strip sticks directly below the sticky controls bar, whose height
// varies with wrapping — track it so the strip's `top` always matches.
const controlsEl = ref<HTMLElement | null>(null)
const controlsH = ref(0)
let controlsRo: ResizeObserver | null = null
watch(controlsEl, (el) => {
  controlsRo?.disconnect()
  if (el) {
    controlsRo = new ResizeObserver(() => {
      controlsH.value = el.offsetHeight
    })
    controlsRo.observe(el)
    controlsH.value = el.offsetHeight
  }
})
onBeforeUnmount(() => controlsRo?.disconnect())
function driftText(r: Row): string {
  if (r.drift === null) return ''
  const params = { time: r.time, cm: Math.abs(r.drift) }
  if (r.drift > 0) return t('data.drift.higher', params)
  if (r.drift < 0) return t('data.drift.lower', params)
  return t('data.drift.exact', params)
}
function onDocClick(e: MouseEvent) {
  const el = e.target as HTMLElement
  if (!el.closest?.('.drift-wrap')) driftOpenT.value = null
  if (!el.closest?.('.axis')) roadOpen.value = false
  if (!el.closest?.('.caution-hit') && !el.closest?.('.caution-pop')) cautionOpenT.value = null
}
function onDocKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    driftOpenT.value = null
    roadOpen.value = false
    cautionOpenT.value = null
  }
}
onMounted(() => {
  document.addEventListener('click', onDocClick)
  document.addEventListener('keydown', onDocKeydown)
})
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick)
  document.removeEventListener('keydown', onDocKeydown)
})

// Where measurements hand over to forecast: the last observed row, provided
// forecast rows follow it. One divider in the list marks the boundary; the
// hatched bars + hourly tags carry "forecast" the rest of the way down.
const fcBoundaryT = computed<number | null>(() => {
  let lastObs: number | null = null
  let forecastAfter = false
  for (const r of rows.value) {
    if (r.observed !== null) {
      lastObs = r.t
      forecastAfter = false
    } else if (lastObs !== null) {
      forecastAfter = true
    }
  }
  return forecastAfter ? lastObs : null
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
    hourCycle: 'h23',
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
    <div
      v-if="pullPx > 0 || refreshing"
      class="ptr"
      :style="{ height: pullPx + 'px' }"
      role="status"
      :aria-label="t('common.refreshing')"
    >
      <span class="ptr-icon" :class="{ spin: refreshing, ready }" aria-hidden="true">⟳</span>
    </div>

    <header class="top">
      <div>
        <h1 class="brand">{{ t('app.title') }}</h1>
        <span class="brand-sub">{{ t('app.subtitle') }}</span>
      </div>
      <LangSwitcher />
    </header>

    <p class="secondary intro">{{ t('data.intro', { station: viewStationName }) }}</p>

    <FirstVisitNotice />

    <div v-if="loading && !status" class="card skeleton" aria-busy="true"></div>

    <template v-else>
      <div ref="controlsEl" class="controls">
        <div class="ctl-row">
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
          <select v-model.number="selectedOffset" class="select" :aria-label="t('data.selectDay')">
            <option v-for="d in dayOptions" :key="d.value" :value="d.value">{{ d.label }}</option>
          </select>
        </div>
        <div class="ctl-row">
          <button v-if="nowInfo" type="button" class="now-strip" @click="jumpToNow()">
            <span class="now-dot" aria-hidden="true"></span>
            <span class="now-lbl">{{ t('data.nowLabel') }}</span>
            <span class="now-val mono">{{ signed(nowInfo.level) }} cm</span>
            <span class="now-trend">
              <template v-if="nowInfo.rising !== null">
                {{ nowInfo.rising ? '↗' : '↘' }}
                {{ t(nowInfo.rising ? 'data.trendRising' : 'data.trendFalling') }}
              </template>
            </span>
            <span class="now-jump">{{ t('data.jumpToNowShort') }}</span>
          </button>
          <button v-else type="button" class="now-btn" @click="jumpToNow()">
            {{ t('data.jumpToNow') }}
          </button>
          <button
            v-if="freshness"
            type="button"
            class="fresh"
            :class="{ stale: !freshness.fresh }"
            :title="t('common.refresh')"
            @click="refreshNow()"
          >
            <span class="fresh-dot" aria-hidden="true"></span>
            <template v-if="checkedNoNew && !chipRefreshing">
              <span role="status" class="fresh-long">{{ t('data.checkedNoNew') }}</span>
              <span class="fresh-short" aria-hidden="true">{{ t('data.checkedNoNewShort') }}</span>
            </template>
            <template v-else>
              <span role="status" class="fresh-long">{{ freshness.text }}</span>
              <span class="fresh-short" aria-hidden="true">{{ freshness.short }}</span>
            </template>
            <span class="fresh-icon" :class="{ spin: chipRefreshing }" aria-hidden="true">
              {{ checkedNoNew && !chipRefreshing ? '✓' : '⟳' }}
            </span>
            <span class="visually-hidden">{{ t('common.refresh') }}</span>
          </button>
        </div>
      </div>

      <p class="legend">
        <span class="legend-lead">{{ t('data.legend', { road: roadLevel }) }}</span>
        <span class="chip"><span class="dot safe"></span>{{ t('data.legendSafe') }}</span>
        <span class="chip"><span class="dot caution"></span>{{ t('data.legendCaution') }}</span>
        <span class="chip"><span class="dot flooded"></span>{{ t('data.legendFlooded') }}</span>
        <span class="chip"><span class="swatch" aria-hidden="true"></span>{{ t('data.forecastTag') }}</span>
        <span class="chip"><span class="drift-key">Δ</span>{{ t('data.drift.title') }}</span>
      </p>

      <p v-if="rows.length === 0" class="card none">{{ t('data.noData') }}</p>

      <div v-if="rows.length > 0" class="axis" :style="{ top: controlsH + 'px' }">
        <span></span>
        <div class="axis-track">
          <div class="axis-tag-wrap" :style="{ left: roadPct + '%' }">
            <button
              type="button"
              class="axis-tag"
              :aria-expanded="roadOpen"
              :aria-label="t('data.road.title')"
              @click="toggleRoad()"
            >
              {{ t('data.road.tag', { road: roadLevel }) }}
            </button>
          </div>
        </div>
        <span></span>
        <span></span>
        <Transition name="pop">
          <div v-if="roadOpen" class="drift-pop road-pop" role="note">
            <strong>{{ t('data.road.title') }}</strong>
            <p>{{ t('data.road.body', { road: roadLevel }) }}</p>
            <p class="drift-pop-generic">{{ t('data.estimateNote') }}</p>
          </div>
        </Transition>
      </div>

      <ol v-if="rows.length > 0" class="rows" :aria-label="t('data.title')">
        <template v-for="r in rows" :key="r.t">
          <li
            class="row"
            :class="{ 'is-now': r.t === nowRowT, hour: r.time.endsWith('00') }"
            :id="r.t === nowRowT ? 'now-row' : undefined"
            :aria-current="r.t === nowRowT ? 'time' : undefined"
            :title="r.t === nowRowT ? t('data.nowTag') : undefined"
          >
            <span class="time mono">
              <span class="time-h">{{ r.time.slice(0, 2) }}</span><span class="time-m">{{ r.time.slice(2) }}</span>
            </span>
            <div class="bar-cell">
              <div class="bar-track">
                <div
                  class="bar-fill"
                  :class="['is-' + r.safety, r.observed === null ? 'is-forecast' : '']"
                  :style="{ width: pct(r.observed ?? r.forecast ?? 0) + '%' }"
                ></div>
                <div class="road-marker" :style="{ left: roadPct + '%' }" :title="t('data.roadMarker')"></div>
              </div>
              <button
                v-if="r.safety === 'caution'"
                type="button"
                class="caution-hit"
                :aria-expanded="cautionOpenT === r.t"
                :aria-label="t('data.caution.title')"
                @click="toggleCaution(r.t)"
              ></button>
              <Transition name="pop">
                <div v-if="cautionOpenT === r.t" class="drift-pop caution-pop" role="note">
                  <strong>{{ t('data.caution.title') }}</strong>
                  <p>{{ cautionText(r) }}</p>
                </div>
              </Transition>
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
              <Transition name="pop">
                <div v-if="driftOpenT === r.t" class="drift-pop" role="note">
                  <strong>{{ t('data.drift.title') }}</strong>
                  <p>{{ driftText(r) }}</p>
                  <p class="drift-pop-generic">{{ t('data.drift.generic') }}</p>
                </div>
              </Transition>
            </div>
            <span v-else-if="r.observed === null && r.time.endsWith('00')" class="tag">{{
              t('data.forecastTag')
            }}</span>
            <span v-else class="tag spacer"></span>
          </li>
          <li v-if="deadlineByRowT.has(r.t)" class="deadline-row" role="note">
            <span class="deadline-body">
              <span class="deadline-main">
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                  <circle cx="6" cy="6" r="5" stroke="currentColor" stroke-width="1.4" />
                  <path d="M6 3.2V6l1.9 1.4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
                </svg>
                {{ t('data.lastSafeStart') }}
                <span class="deadline-time mono">{{ deadlineByRowT.get(r.t) }}</span>
              </span>
              <span class="deadline-note">{{ t('data.estimateNote') }}</span>
            </span>
          </li>
          <li v-if="r.t === fcBoundaryT" class="fc-divider" role="note">
            {{ t('data.fcBoundary') }}
          </li>
        </template>
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

      <footer class="site-footer">
        <p class="muted">{{ t('footer.disclaimer') }}</p>
        <p class="muted">{{ t('footer.source', { station: viewStationName }) }}</p>
        <p class="muted">
          {{ t('footer.official') }}
          <a href="https://oplev.esbjerg.dk/oplev-naturen/ved-vandet/mandoe" target="_blank" rel="noopener">Esbjerg Kommune</a>
          ·
          <a href="https://www.dmi.dk/vandstand/" target="_blank" rel="noopener">DMI vandstand</a>
          ·
          <a href="https://mandoebussen.dk" target="_blank" rel="noopener">Mandøbussen</a>
        </p>
        <p class="muted">
          <RouterLink to="/status">{{ t('footer.status') }}</RouterLink>
          ·
          <RouterLink to="/display">{{ t('footer.display') }}</RouterLink>
          ·
          <RouterLink to="/admin">{{ t('footer.admin') }}</RouterLink>
        </p>
      </footer>
    </template>
  </div>
</template>

<style scoped>
.top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  margin-bottom: 8px;
  flex-wrap: wrap;
}

.brand {
  /* 700 is the heaviest weight the font link actually loads — asking for
     800 got a synthesized bold. */
  font-weight: 700;
  font-size: 1.15rem;
  margin: 0;
}

.brand-sub {
  display: block;
  color: var(--text-muted);
  font-size: 0.82rem;
}

.site-footer {
  margin-top: 24px;
}

/* Pull-to-refresh indicator: grows with the drag, spins while refetching. */
.ptr {
  display: flex;
  align-items: flex-end;
  justify-content: center;
  overflow: hidden;
}

.ptr-icon {
  font-size: 20px;
  line-height: 1;
  color: var(--text-muted);
  padding-bottom: 6px;
  transition: transform 0.15s ease;
}

.ptr-icon.ready {
  transform: rotate(180deg);
  color: var(--text-secondary);
}

.ptr-icon.spin {
  animation: ptr-spin 0.8s linear infinite;
}

@keyframes ptr-spin {
  to {
    transform: rotate(360deg);
  }
}

/* Freshness chip: sits after the now-strip. Also the tap-to-refresh
   affordance for anyone scrolled past the top of the page. On narrow
   screens the label collapses to just the age. */
.fresh {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  padding: 4px 0 4px 8px;
  border: none;
  background: none;
  font: inherit;
  font-size: 0.72rem;
  color: var(--text-secondary);
  cursor: pointer;
}

.fresh-short {
  display: none;
}

@media (max-width: 420px) {
  .fresh-long {
    display: none;
  }
  .fresh-short {
    display: inline;
  }
}

.fresh-icon {
  font-size: 0.9rem;
  line-height: 1;
  color: var(--text-muted);
}

.fresh-icon.spin {
  animation: ptr-spin 0.8s linear infinite;
}

.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

.fresh-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--verdict-safe-accent);
  flex: none;
}

.fresh.stale {
  color: var(--verdict-caution-fg);
  font-weight: 600;
}

.fresh.stale .fresh-dot {
  background: var(--verdict-caution-accent);
}

.site-footer .muted {
  margin-bottom: 6px;
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
   Negative margins bleed the background to the page edges. Two compact
   rows: station + day pickers, then the now-strip + freshness chip. */
.controls {
  position: sticky;
  top: 0;
  z-index: 10;
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0 -16px 12px;
  padding: 10px 16px 8px;
  background: var(--page);
  border-bottom: 1px solid var(--border);
}
.ctl-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.seg {
  flex: 1.2;
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
  color: var(--accent-contrast);
  font-weight: 600;
}
.select {
  flex: 1;
  min-width: 0;
  padding: 8px 8px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text-primary);
  font: inherit;
  font-size: 0.82rem;
  accent-color: var(--accent);
}

/* Now-strip: current level + trend, doubling as the jump-to-now control. */
.now-strip {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--border));
  background: color-mix(in srgb, var(--accent) 9%, var(--surface));
  color: var(--text-primary);
  border-radius: 999px;
  padding: 6px 14px;
  cursor: pointer;
  text-align: left;
}
.now-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent);
  flex: none;
  animation: now-pulse 2.4s ease-in-out infinite;
}
@keyframes now-pulse {
  50% {
    opacity: 0.35;
  }
}
.now-lbl {
  font-size: 0.78rem;
  color: var(--text-secondary);
  flex: none;
}
.now-val {
  font-weight: 600;
  font-size: 0.92rem;
  flex: none;
}
.now-trend {
  font-size: 0.78rem;
  color: var(--text-secondary);
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.now-jump {
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--accent);
  flex: none;
  white-space: nowrap;
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
  gap: 4px 8px;
  align-items: center;
}
.legend-lead {
  flex-basis: 100%;
  color: var(--text-secondary);
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 1px 8px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--surface);
}
.dot {
  width: 9px;
  height: 9px;
  border-radius: 3px;
  display: inline-block;
}
/* Mini sample of the hatched forecast bars. */
.swatch {
  width: 14px;
  height: 9px;
  border-radius: 2px;
  display: inline-block;
  background-color: color-mix(in srgb, var(--text-muted) 55%, transparent);
  background-image: repeating-linear-gradient(
    135deg,
    transparent 0 3px,
    color-mix(in srgb, var(--surface) 65%, transparent) 3px 6px
  );
}
.dot.safe {
  background: var(--verdict-safe-accent);
}
.dot.caution {
  background: var(--verdict-caution-accent);
}
.dot.flooded {
  background: var(--verdict-unsafe-accent);
}
.drift-key {
  font-weight: 700;
  color: var(--text-secondary);
}

/* Sticky axis strip: labels the road line once, directly above it, and
   stays visible while scrolling the long table. Mirrors .row's grid and
   compensates for .rows' 1px border so the tick lands exactly on the line. */
.axis {
  position: sticky;
  z-index: 9;
  display: grid;
  grid-template-columns: 3.4em 1fr 3em 3.2em;
  gap: 8px;
  align-items: end;
  padding: 2px 13px 0;
  background: var(--page);
  /* Same font-size as .row — the em-based columns must resolve identically
     or the tick misses the road line below. */
  font-size: 12.5px;
}
.axis-track {
  position: relative;
  height: 26px;
}
.axis-tag-wrap {
  position: absolute;
  bottom: 0;
  width: 0;
}
.axis-tag-wrap::after {
  content: '';
  position: absolute;
  left: -1px;
  top: -4px;
  width: 2px;
  height: 9px;
  background: var(--text-primary);
}
.axis-tag {
  position: absolute;
  bottom: 4px;
  transform: translateX(-50%);
  padding: 1px 7px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--surface);
  color: var(--text-secondary);
  font: inherit;
  font-size: 10.5px;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
}
.road-pop {
  right: 0;
  top: calc(100% + 4px);
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
.rows > li:first-child {
  border-radius: 11px 11px 0 0;
}
.rows > li:last-child {
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
/* The full hour is the table's rhythm: the :00 rows carry an emphasized
   hour digit (below) rather than divider lines, which proved too noisy. */
.row.is-now {
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  box-shadow: inset 3px 0 0 var(--accent);
}
.row.is-now .time,
.row.is-now .time .time-h {
  color: var(--accent);
  font-weight: 700;
}

.time {
  color: var(--text-muted);
  font-size: 12px;
}
.time .time-h {
  color: var(--text-secondary);
}
.row.hour .time .time-h {
  color: var(--text-primary);
  font-weight: 600;
}

.bar-cell {
  position: relative;
  min-width: 0;
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
  border-radius: 4px 2px 2px 4px;
}
.bar-fill.is-safe {
  background: var(--verdict-safe-accent);
}
.bar-fill.is-caution {
  background: var(--verdict-caution-accent);
}
.bar-fill.is-flooded {
  background: var(--verdict-unsafe-accent);
}
/* Forecast bars are hatched (the instrument convention for "projected"),
   so forecast-ness stays visible on every row, not just at the divider. */
.bar-fill.is-forecast {
  opacity: 0.55;
  background-image: repeating-linear-gradient(
    135deg,
    transparent 0 3px,
    color-mix(in srgb, var(--surface) 65%, transparent) 3px 6px
  );
}

/* Invisible tap target over an amber bar — stretched a few px beyond the
   14px track so it's comfortably hittable on a phone without changing the
   dense row layout. */
.caution-hit {
  position: absolute;
  top: -6px;
  bottom: -6px;
  left: 0;
  right: 0;
  border: none;
  background: none;
  padding: 0;
  cursor: pointer;
}
/* Anchored to the bar cell, but pinned to the row's left edge (back across
   the time column) so the popover never clips off the side of a narrow
   phone screen. */
.caution-pop {
  right: auto;
  left: calc(-3.4em - 8px);
}

/* "Last safe start" boundary between the green and amber rows of a window —
   the most important line in the table, so it gets a clock and a solid pill. */
.deadline-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 12px;
  font-size: 12px;
  font-weight: 700;
  color: var(--verdict-safe-accent);
  background: color-mix(in srgb, var(--verdict-safe-accent) 10%, transparent);
}
.deadline-body {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1px;
}
.deadline-main {
  display: flex;
  align-items: center;
  gap: 8px;
  white-space: nowrap;
}
.deadline-note {
  font-size: 10px;
  font-weight: 500;
  opacity: 0.85;
  text-align: center;
}
.deadline-row::before,
.deadline-row::after {
  content: '';
  height: 1px;
  flex: 1;
  background: var(--verdict-safe-accent);
  opacity: 0.5;
}
.deadline-row svg {
  flex: none;
}
.deadline-time {
  background: var(--verdict-safe-accent);
  color: var(--page);
  border-radius: 999px;
  padding: 0 8px;
  font-size: 11.5px;
}

/* Where measurements hand over to forecast. */
.fc-divider {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 12px;
  font-size: 10.5px;
  color: var(--text-muted);
  white-space: nowrap;
}
.fc-divider::before,
.fc-divider::after {
  content: '';
  height: 0;
  flex: 1;
  border-top: 1px dashed var(--border-strong);
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
/* Popovers fade in with a small rise (the global reduced-motion rule
   disables this for users who ask for it). */
.pop-enter-active,
.pop-leave-active {
  transition: opacity 0.13s ease, transform 0.13s ease;
}
.pop-enter-from,
.pop-leave-to {
  opacity: 0;
  transform: translateY(3px);
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

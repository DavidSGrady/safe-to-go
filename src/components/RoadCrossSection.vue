<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { fmtTime, splitDuration } from '@/lib/format'
import type { SafetyRules, StatusResult } from '@/lib/types'

const props = defineProps<{
  status: StatusResult
  rules: SafetyRules
  now: number
}>()

const { t, locale } = useI18n()

const MAX_OFFSET_MIN = 24 * 60
const offsetMin = ref(0)
const playing = ref(false)
let timer: ReturnType<typeof setInterval> | null = null

function stop(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  playing.value = false
}

function togglePlay(): void {
  if (playing.value) {
    stop()
    return
  }
  if (offsetMin.value >= MAX_OFFSET_MIN) offsetMin.value = 0
  playing.value = true
  timer = setInterval(() => {
    offsetMin.value = Math.min(MAX_OFFSET_MIN, offsetMin.value + 9)
    if (offsetMin.value >= MAX_OFFSET_MIN) stop()
  }, 80)
}

function reset(): void {
  stop()
  offsetMin.value = 0
}

onBeforeUnmount(stop)

const scrubTime = computed(() => props.now + offsetMin.value * 60_000)

const displayLevel = computed(() => {
  if (offsetMin.value === 0) return props.status.currentLevelCm
  const v = props.status.levelAt(scrubTime.value)
  return v === null ? null : Math.round(v)
})

const rising = computed(() => {
  const a = props.status.levelAt(scrubTime.value)
  const b = props.status.levelAt(scrubTime.value + 8 * 60_000)
  if (a === null || b === null) return props.status.rising
  return b > a
})

// Mirror the verdict logic so the water colour matches the real state at the
// scrubbed moment: red when flooded, green/amber by direction.
//  - falling: safe as soon as it's at/below the falling limit
//  - rising: safe only if the crossing can finish before the water reaches
//    (flood − margin), i.e. there's enough time — otherwise amber.
const STEP_MS = 5 * 60_000
const RISE_SCAN_CAP_MS = 12 * 60 * 60_000

const displayState = computed<'safe' | 'caution' | 'unsafe' | 'unknown'>(() => {
  const v = displayLevel.value
  if (v === null) return 'unknown'
  const caution = props.rules.cautionMaxCm
  if (v >= caution) return 'unsafe'
  if (!rising.value) {
    return v <= props.rules.safeMaxFallingCm ? 'safe' : 'caution'
  }
  const target = caution - props.rules.floodMarginCm
  if (v >= target) return 'caution'
  // How long until the rising water reaches the safety target?
  const base = scrubTime.value
  let reachMs: number | null = null
  for (let dt = STEP_MS; dt <= RISE_SCAN_CAP_MS; dt += STEP_MS) {
    const lv = props.status.levelAt(base + dt)
    if (lv === null) break
    if (lv >= target) {
      reachMs = dt
      break
    }
  }
  if (reachMs === null) return 'safe' // target not reached soon → no time pressure
  const needMs = (props.rules.crossingMinutes + props.rules.bufferMinutes) * 60_000
  return reachMs >= needMs ? 'safe' : 'caution'
})

// Map cm (DVR90) to a 0-100% viewport height. The flood point sits high in
// frame with headroom for storm surge; the range scales with the admin's
// own thresholds instead of a fixed constant.
const viewMax = computed(() => props.rules.cautionMaxCm + 30)
const viewMin = computed(() => props.rules.cautionMaxCm - 170)
function pct(cm: number): number {
  const span = viewMax.value - viewMin.value
  return Math.min(97, Math.max(2, ((cm - viewMin.value) / span) * 100))
}

const roadTopPct = computed(() => pct(props.rules.cautionMaxCm))
const waterPct = computed(() => (displayLevel.value === null ? 0 : pct(displayLevel.value)))

const basisTxt = computed(() => {
  if (offsetMin.value > 0) {
    const { hours, minutes } = splitDuration(offsetMin.value * 60_000)
    return t('road.inDuration', { duration: t('windows.duration', { hours, minutes }) })
  }
  return props.status.dataFresh ? t('common.measured') : t('common.forecast')
})

const timeTxt = computed(() => fmtTime(scrubTime.value, locale.value))
</script>

<template>
  <section class="card">
    <h2>{{ t('road.title') }}</h2>
    <div class="viz" :class="displayState">
      <div class="scene">
        <div class="road" :style="{ height: roadTopPct + '%' }"></div>
        <div class="water" :style="{ height: waterPct + '%' }"></div>
        <div class="waterline" :style="{ bottom: waterPct + '%' }"></div>
        <div class="road-label" :style="{ bottom: roadTopPct + '%' }">
          {{ t('road.roadLabel', { cm: rules.cautionMaxCm }) }}
        </div>
        <div class="level-label" :style="{ bottom: `calc(${waterPct}% + 4px)` }">
          {{ displayLevel ?? '—' }} {{ t('chart.unit') }} {{ rising ? '↑' : '↓' }}
        </div>
      </div>

      <div class="controls">
        <button
          type="button"
          class="round-btn play"
          :aria-label="playing ? t('road.pause') : t('road.play')"
          @click="togglePlay"
        >
          {{ playing ? '❚❚' : '▶' }}
        </button>
        <button type="button" class="round-btn" :aria-label="t('road.reset')" @click="reset">⟲</button>
        <input
          v-model.number="offsetMin"
          type="range"
          min="0"
          :max="MAX_OFFSET_MIN"
          step="5"
          :aria-label="t('road.title')"
        />
        <div class="time-txt">{{ offsetMin === 0 ? t('road.now') : timeTxt }}</div>
      </div>

      <div class="readout">
        <span class="level">{{ displayLevel ?? '—' }} {{ t('chart.unit') }}</span>
        <span class="trend">{{ rising ? '↑' : '↓' }} {{ rising ? t('common.rising') : t('common.falling') }}</span>
        <span class="basis">{{ basisTxt }}</span>
      </div>

      <p class="caption">
        {{
          t('road.caption', {
            road: rules.cautionMaxCm,
            falling: rules.safeMaxFallingCm,
            margin: rules.floodMarginCm,
            rising: rules.cautionMaxCm - rules.floodMarginCm,
          })
        }}
      </p>
    </div>
  </section>
</template>

<style scoped>
.viz {
  background: var(--surface);
  border-radius: 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.scene {
  position: relative;
  height: 160px;
  background: linear-gradient(var(--page), var(--surface));
  border-radius: 10px;
  overflow: hidden;
  border: 1px solid var(--border);
}

.road {
  position: absolute;
  left: 50%;
  bottom: 0;
  transform: translateX(-50%);
  width: 42%;
  background: var(--baseline);
  border-top: 6px solid var(--text-muted);
  border-radius: 8px 8px 0 0;
}

.water {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  background: var(--water-safe-fill);
  transition: height 0.2s ease, background 0.3s ease;
}

.waterline {
  position: absolute;
  left: 0;
  right: 0;
  border-top: 2px solid var(--verdict-safe-accent);
  transition: bottom 0.2s ease, border-color 0.3s ease;
}

/* Water tracks the verdict palette: green when safe, amber at the warning
   threshold, red once the danger threshold is reached. */
.viz.caution .water {
  background: var(--water-caution-fill);
}
.viz.unsafe .water {
  background: var(--water-unsafe-fill);
}
.viz.unknown .water {
  background: rgba(100, 117, 111, 0.24);
}

.viz.caution .waterline {
  border-top-color: var(--verdict-caution-accent);
}
.viz.unsafe .waterline {
  border-top-color: var(--verdict-unsafe-accent);
}
.viz.unknown .waterline {
  border-top-color: var(--verdict-unknown-accent);
}

.road-label {
  position: absolute;
  left: 50%;
  transform: translate(-50%, 100%);
  margin-bottom: 4px;
  font-family: var(--font-mono);
  font-size: 9.5px;
  font-weight: 600;
  color: var(--text-secondary);
  background: rgba(255, 255, 255, 0.75);
  padding: 1px 5px;
  border-radius: 4px;
  white-space: nowrap;
}

.level-label {
  position: absolute;
  left: 8px;
  transform: translateY(100%);
  font-family: var(--font-mono);
  font-size: 10.5px;
  font-weight: 600;
  background: var(--text-primary);
  color: var(--page);
  padding: 2px 7px;
  border-radius: 4px;
  white-space: nowrap;
}

.controls {
  display: flex;
  align-items: center;
  gap: 8px;
}

.round-btn {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  border: 1px solid var(--baseline);
  background: var(--surface);
  color: var(--text-secondary);
  display: flex;
  align-items: center;
  justify-content: center;
  flex: none;
  cursor: pointer;
  padding: 0;
}

.round-btn.play {
  border-color: var(--accent);
  background: var(--accent);
  color: #fff;
  font-size: 11px;
}

.controls input[type='range'] {
  flex: 1;
  min-width: 0;
  padding: 0;
  border: none;
  accent-color: var(--accent);
  height: 24px;
}

.time-txt {
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 600;
  color: var(--text-secondary);
  white-space: nowrap;
}

.readout {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
}

.level {
  font-family: var(--font-mono);
  font-size: 22px;
  font-weight: 600;
}

.trend {
  font-size: 12.5px;
  font-weight: 600;
}

.basis {
  margin-left: auto;
  font-size: 11px;
  color: var(--text-muted);
}

.caption {
  font-size: 11px;
  color: var(--text-muted);
  line-height: 1.5;
  text-wrap: pretty;
  margin: 0;
}
</style>

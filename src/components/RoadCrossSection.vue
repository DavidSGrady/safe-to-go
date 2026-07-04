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
    offsetMin.value = Math.min(MAX_OFFSET_MIN, offsetMin.value + 3)
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

const displayState = computed<'safe' | 'caution' | 'unsafe' | 'unknown'>(() => {
  const v = displayLevel.value
  if (v === null) return 'unknown'
  if (v >= props.rules.cautionMaxCm) return 'unsafe'
  if (v >= props.rules.safeMaxCm) return 'caution'
  return 'safe'
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
const limitPct = computed(() => pct(props.rules.safeMaxCm))
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
        <div class="limit-line" :style="{ bottom: limitPct + '%' }"></div>
        <div class="limit-label" :style="{ bottom: limitPct + '%' }">
          {{ t('road.limitLabel', { cm: rules.safeMaxCm }) }}
        </div>
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
            limit: rules.safeMaxCm,
            margin: rules.cautionMaxCm - rules.safeMaxCm,
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
  background: rgba(15, 110, 102, 0.28);
  transition: height 0.2s ease;
}

.waterline {
  position: absolute;
  left: 0;
  right: 0;
  border-top: 2px solid var(--accent);
  transition: bottom 0.2s ease;
}

.limit-line {
  position: absolute;
  left: 0;
  right: 0;
  border-top: 2px dashed var(--verdict-caution-accent);
}

.limit-label {
  position: absolute;
  right: 8px;
  margin-bottom: 3px;
  transform: translateY(100%);
  font-family: var(--font-mono);
  font-size: 9.5px;
  font-weight: 600;
  color: var(--verdict-caution-accent);
  background: rgba(255, 255, 255, 0.75);
  padding: 1px 5px;
  border-radius: 4px;
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

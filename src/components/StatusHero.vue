<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { fmtTime, splitDuration } from '@/lib/format'
import type { StatusResult } from '@/lib/types'

const props = defineProps<{
  status: StatusResult
  now: number
}>()

const { t, locale } = useI18n()

const effectiveState = computed(() =>
  props.status.dataFresh || props.status.state === 'unknown'
    ? props.status.state
    : props.status.state === 'safe'
      ? 'caution'
      : props.status.state,
)

const icon = computed(
  () =>
    ({ safe: '✓', caution: '!', unsafe: '✕', unknown: '?' })[effectiveState.value],
)

// The current-level number is the actual measurement while it's fresh;
// after that the app falls back to the surge-adjusted forecast (see tide.ts).
const levelIsMeasured = computed(() => props.status.dataFresh)

const readingAge = computed(() => {
  if (props.status.lastObservedAt === null) return null
  const { hours, minutes } = splitDuration(props.now - props.status.lastObservedAt)
  return hours > 0
    ? t('status.agoHoursMinutes', { hours, minutes })
    : t('status.agoMinutes', { minutes })
})

const timeLeft = computed(() => {
  if (props.status.state !== 'safe' || props.status.safeUntil === null) return null
  const { hours, minutes } = splitDuration(props.status.safeUntil - props.now)
  return hours > 0
    ? t('status.hoursMinutesLeft', { hours, minutes })
    : t('status.minutesLeft', { minutes })
})
</script>

<template>
  <section class="hero" :class="effectiveState" role="status" aria-live="polite">
    <div class="badge" aria-hidden="true">{{ icon }}</div>
    <h1 class="headline">{{ t(`status.${effectiveState}`) }}</h1>
    <p class="desc">{{ t(`status.${effectiveState}Desc`) }}</p>

    <p v-if="status.state === 'safe' && status.safeUntil" class="until">
      {{ t('status.safeUntil', { time: fmtTime(status.safeUntil, locale) }) }}
      <span v-if="timeLeft" class="left">· {{ timeLeft }}</span>
    </p>

    <div class="facts">
      <div v-if="status.currentLevelCm !== null" class="fact">
        <span class="fact-label">{{ t('status.currentLevel') }}</span>
        <span class="fact-value">{{ status.currentLevelCm }} cm</span>
        <span class="fact-tag">{{ levelIsMeasured ? t('status.sourceMeasured') : t('status.sourceForecast') }}</span>
      </div>
      <div v-if="status.rising !== null" class="fact">
        <span class="fact-value trend">
          {{ status.rising ? '↑' : '↓' }}
          <span class="trend-text">{{ status.rising ? t('status.tideRising') : t('status.tideFalling') }}</span>
        </span>
      </div>
    </div>

    <p v-if="status.lastObservedAt" class="updated">
      {{ t('status.updated', { time: fmtTime(status.lastObservedAt, locale) }) }}
      <span v-if="readingAge"> ({{ readingAge }})</span>
      <span v-if="!status.dataFresh"> — {{ t('status.stale') }}</span>
    </p>
  </section>
</template>

<style scoped>
.hero {
  border-radius: var(--radius);
  padding: 28px 24px;
  color: #fff;
  text-align: center;
  margin-bottom: 16px;
  box-shadow: var(--shadow);
}

.hero.safe {
  background: var(--status-safe);
}

.hero.caution {
  background: var(--status-caution);
}

.hero.unsafe {
  background: var(--status-unsafe);
}

.hero.unknown {
  background: var(--status-unknown);
}

.badge {
  width: 56px;
  height: 56px;
  margin: 0 auto 12px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.22);
  font-size: 30px;
  font-weight: 700;
  line-height: 56px;
}

.headline {
  font-size: clamp(1.7rem, 6vw, 2.3rem);
  margin: 0 0 6px;
}

.desc {
  margin: 0 auto 12px;
  max-width: 44ch;
  opacity: 0.95;
}

.until {
  font-size: 1.15rem;
  font-weight: 700;
  margin: 0 0 14px;
}

.left {
  font-weight: 500;
  opacity: 0.9;
}

.facts {
  display: flex;
  justify-content: center;
  flex-wrap: wrap;
  gap: 10px 26px;
  margin-bottom: 10px;
}

.fact-label {
  display: block;
  font-size: 0.78rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  opacity: 0.85;
}

.fact-value {
  font-size: 1.25rem;
  font-weight: 700;
}

.fact-tag {
  display: block;
  font-size: 0.72rem;
  opacity: 0.85;
}

.trend-text {
  font-size: 0.95rem;
  font-weight: 500;
}

.updated {
  margin: 0;
  font-size: 0.8rem;
  opacity: 0.85;
}
</style>

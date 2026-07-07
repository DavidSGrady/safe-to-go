<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { dayLabel, fmtTime, localTimeMs, splitDuration } from '@/lib/format'
import { DAYTRIP_SHOPS_CLOSE_HOUR, planDayTrip, type DayTripCrossing } from '@/lib/daytrip'
import type { SafetyRules, StatusResult } from '@/lib/types'

const props = defineProps<{
  status: StatusResult
  rules: SafetyRules
  now: number
}>()

const { t, locale } = useI18n()

const plan = computed(() => planDayTrip(props.status.windows, props.rules, props.now))

// green for a full comfortable daytrip; amber when it's short or needs an
// early/late crossing; neutral when no daytrip is possible today.
const theme = computed(() =>
  !plan.value.feasible
    ? 'none'
    : plan.value.short || plan.value.comfort === 'extended'
      ? 'warn'
      : 'ok',
)

const durationTxt = (ms: number): string => {
  const { hours, minutes } = splitDuration(ms)
  return t('windows.duration', { hours, minutes })
}

// The actual time on the island vs. the recommended length — spelled out so the
// short-trip warning is transparent about the reasoning.
const shortWarningTxt = computed(() =>
  t('daytrip.shortWarning', {
    duration: durationTxt(plan.value.islandMs),
    recommended: durationTxt(props.rules.minDaytripMinutes * 60_000),
  }),
)

const title = computed(() => {
  const p = plan.value
  if (p.feasible) {
    // Fallback-to-tomorrow keeps the present-tense title; the lead-in note
    // explains that today's out and these are tomorrow's crossings.
    if (p.todayUnavailable) return t('daytrip.title')
    return p.forTomorrow ? t('daytrip.titleTomorrow') : t('daytrip.title')
  }
  return p.forTomorrow ? t('daytrip.noneTitleTomorrow') : t('daytrip.noneTitle')
})

// A crossing bracket, collapsed to a single time when it's essentially a point.
function bracketTxt(c: DayTripCrossing): string {
  if (c.latest - c.earliest < 60_000) {
    return t('daytrip.crossAround', { time: fmtTime(c.latest, locale.value) })
  }
  return t('daytrip.crossBetween', {
    from: fmtTime(c.earliest, locale.value),
    to: fmtTime(c.latest, locale.value),
  })
}

const shopsCloseTxt = computed(() =>
  fmtTime(localTimeMs(props.now, DAYTRIP_SHOPS_CLOSE_HOUR), locale.value),
)

const nextWindowTxt = computed(() => {
  const ts = plan.value.nextWindowStart
  if (ts === null) return null
  const label = dayLabel(ts, props.now, locale.value)
  const day = label === 'today' ? t('common.today') : label === 'tomorrow' ? t('common.tomorrow') : label
  return t('daytrip.noneNext', { day, time: fmtTime(ts, locale.value) })
})
</script>

<template>
  <div class="daytrip" :class="theme">
    <div class="dt-title">{{ title }}</div>

    <template v-if="plan.feasible && plan.outbound && plan.inbound">
      <p v-if="plan.todayUnavailable" class="dt-lead">{{ t('daytrip.todayUnavailableNote') }}</p>

      <div class="legs">
        <!-- Same window for both crossings → one round-trip line. -->
        <div v-if="plan.mode === 'single-window'" class="leg">
          <span class="leg-label">{{ t('daytrip.roundTrip') }}</span>
          <span class="leg-time mono">{{ bracketTxt(plan.outbound) }}</span>
        </div>
        <template v-else>
          <div class="leg">
            <span class="leg-label">{{ t('daytrip.there') }}</span>
            <span class="leg-time mono">{{ bracketTxt(plan.outbound) }}</span>
          </div>
          <div class="leg">
            <span class="leg-label">{{ t('daytrip.back') }}</span>
            <span class="leg-time mono">{{ bracketTxt(plan.inbound) }}</span>
          </div>
        </template>
      </div>

      <p class="dt-note">
        {{ plan.mode === 'two-window' ? t('daytrip.twoWindowNote') : t('daytrip.singleWindowNote') }}
      </p>
      <p v-if="plan.short" class="dt-warn">{{ shortWarningTxt }}</p>
      <p v-if="plan.comfort === 'extended'" class="dt-warn">
        {{ t('daytrip.extendedWarning', { time: shopsCloseTxt }) }}
      </p>
    </template>

    <template v-else>
      <p class="dt-note">{{ t('daytrip.noneBody') }}</p>
      <p v-if="nextWindowTxt" class="dt-note">{{ nextWindowTxt }}</p>
    </template>
  </div>
</template>

<style scoped>
.daytrip {
  border-radius: 12px;
  padding: 13px 15px;
  margin-bottom: 12px;
  border: 1px solid;
}

.daytrip.ok {
  background: var(--verdict-safe-bg);
  border-color: var(--verdict-safe-bd);
  color: var(--verdict-safe-fg);
}
.daytrip.warn {
  background: var(--verdict-caution-bg);
  border-color: var(--verdict-caution-bd);
  color: var(--verdict-caution-fg);
}
.daytrip.none {
  background: var(--verdict-unknown-bg);
  border-color: var(--verdict-unknown-bd);
  color: var(--verdict-unknown-fg);
}

.dt-title {
  font-weight: 700;
  font-size: 0.9rem;
  margin-bottom: 8px;
}

.legs {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 8px;
}

.leg {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}

.leg-label {
  font-size: 0.82rem;
  font-weight: 600;
  opacity: 0.9;
}

.leg-time {
  font-size: 0.9rem;
  font-weight: 600;
  margin-left: auto;
}

.dt-lead {
  font-size: 0.82rem;
  font-weight: 600;
  line-height: 1.45;
  margin: 0 0 8px;
  text-wrap: pretty;
}

.dt-note {
  font-size: 0.8rem;
  line-height: 1.5;
  opacity: 0.9;
  margin: 0;
  text-wrap: pretty;
}

.dt-warn {
  font-size: 0.8rem;
  line-height: 1.45;
  font-weight: 600;
  margin: 8px 0 0;
  text-wrap: pretty;
}
</style>

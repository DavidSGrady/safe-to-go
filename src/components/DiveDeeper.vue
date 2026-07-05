<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { dayLabel, fmtTime } from '@/lib/format'
import type { SafetyRules, StatusResult } from '@/lib/types'

const props = defineProps<{
  status: StatusResult
  rules: SafetyRules
  now: number
}>()

const { t, locale } = useI18n()

const first = computed(() => props.status.currentWindow ?? props.status.windows[0] ?? null)

function dayTxt(ms: number): string {
  const label = dayLabel(ms, props.now, locale.value)
  return label === 'today' ? t('common.today') : label === 'tomorrow' ? t('common.tomorrow') : label
}

const detail = computed(() => {
  const w = first.value
  if (!w) return null
  return {
    dayLabel: dayTxt(w.start),
    endTxt: fmtTime(w.end, locale.value),
    deadlineTxt: fmtTime(w.deadline, locale.value),
  }
})
</script>

<template>
  <section class="card">
    <h2>{{ t('dive.title') }}</h2>

    <div v-if="detail" class="block calc">
      <div class="block-title">{{ t('dive.calcTitle', { day: detail.dayLabel }) }}</div>
      <div class="row"><span>{{ t('dive.calcRowLimit', { limit: rules.safeMaxRisingCm }) }}</span><span class="mono strong">{{ detail.endTxt }}</span></div>
      <div class="row secondary"><span>{{ t('dive.calcRowCrossing') }}</span><span class="mono">− {{ rules.crossingMinutes }} min</span></div>
      <div class="row secondary"><span>{{ t('dive.calcRowBuffer') }}</span><span class="mono">− {{ rules.bufferMinutes }} min</span></div>
      <div class="row total"><span>{{ t('dive.calcRowDeadline') }}</span><span class="mono">{{ detail.deadlineTxt }}</span></div>
    </div>

    <div class="block">
      <div class="block-title">{{ t('dive.basisTitle') }}</div>
      <p class="body">{{ t('dive.basisBody') }}</p>
    </div>

    <div class="block">
      <div class="block-title">{{ t('dive.factsTitle') }}</div>
      <ul class="facts">
        <li>{{ t('dive.fact1') }}</li>
        <li>{{ t('dive.fact2', { max: rules.crossingMinutes }) }}</li>
        <li>{{ t('dive.fact3') }}</li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
.block {
  background: var(--page);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 14px 16px;
  margin-bottom: 10px;
}

.block-title {
  font-size: 10.5px;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: var(--text-muted);
  font-weight: 600;
  margin-bottom: 8px;
}

.row {
  display: flex;
  justify-content: space-between;
  font-size: 13px;
  padding: 3px 0;
}

.row.secondary {
  color: var(--text-secondary);
}

.row.total {
  border-top: 1px solid var(--border);
  margin-top: 6px;
  padding-top: 10px;
  font-size: 14px;
  font-weight: 700;
  color: var(--verdict-safe-fg);
}

.strong {
  font-weight: 600;
}

.body {
  font-size: 12.5px;
  color: var(--text-secondary);
  line-height: 1.55;
  text-wrap: pretty;
  margin: 0;
}

.facts {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.facts li {
  position: relative;
  padding-left: 16px;
  font-size: 12.5px;
  color: var(--text-secondary);
  line-height: 1.5;
}

.facts li::before {
  content: '';
  position: absolute;
  left: 0;
  top: 6px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-muted);
}
</style>

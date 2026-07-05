<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { dayLabel, fmtTime, splitDuration } from '@/lib/format'
import type { SafeWindow } from '@/lib/types'

const props = defineProps<{
  windows: SafeWindow[]
  now: number
  extended: boolean
}>()

const emit = defineEmits<{ 'toggle-extended': [] }>()

const { t, locale } = useI18n()

function dayTxt(ms: number): string {
  const label = dayLabel(ms, props.now, locale.value)
  return label === 'today' ? t('common.today') : label === 'tomorrow' ? t('common.tomorrow') : label
}

// Time with a day label when it isn't today, so a deadline or flood time that
// slips past midnight never reads as a time in the past.
function depTime(ms: number): string {
  return dayLabel(ms, props.now, locale.value) === 'today'
    ? fmtTime(ms, locale.value)
    : `${dayTxt(ms)} ${fmtTime(ms, locale.value)}`
}

function durationTxt(ms: number): string {
  const { hours, minutes } = splitDuration(ms)
  return t('windows.duration', { hours, minutes })
}

const confidenceLabels = {
  high: 'confidenceHigh',
  medium: 'confidenceMedium',
  low: 'confidenceLow',
  veryLow: 'confidenceVeryLow',
} as const

const items = computed(() =>
  props.windows.map(
    (w: SafeWindow) => {
      const total = w.end - w.start
      const greenMs = Math.max(0, Math.min(w.deadline, w.end) - w.start)
      const amberMs = total - greenMs
      const open = w.start <= props.now && props.now < w.end
      return {
        key: w.start,
        open,
        day: dayTxt(w.start),
        rangeTxt: `${fmtTime(w.start, locale.value)} → ${depTime(w.deadline)}`,
        deadlineTxt: depTime(w.deadline),
        floodsTxt: w.floodsAt !== null ? depTime(w.floodsAt) : null,
        lowTxt: fmtTime(w.lowAt, locale.value),
        greenPct: total > 0 ? (greenMs / total) * 100 : 0,
        amberPct: total > 0 ? (amberMs / total) * 100 : 0,
        tooShort: greenMs <= 0,
        durationTxt: durationTxt(total),
        greenDurationTxt: durationTxt(greenMs),
        confidenceKey: confidenceLabels[w.confidence],
      }
    },
  ),
)

const dayGroups = computed(() => {
  const groups: Array<{ day: string; items: typeof items.value }> = []
  for (const item of items.value) {
    const last = groups[groups.length - 1]
    if (last && last.day === item.day) last.items.push(item)
    else groups.push({ day: item.day, items: [item] })
  }
  return groups
})
</script>

<template>
  <section class="card">
    <h2>{{ t('windows.title') }}</h2>
    <p class="secondary intro">{{ t('windows.intro') }}</p>

    <p v-if="items.length === 0" class="none">{{ t('windows.none') }}</p>

    <div v-else class="groups">
      <div v-for="group in dayGroups" :key="group.day" class="group">
        <div class="day-label">{{ group.day }}</div>
        <div v-for="item in group.items" :key="item.key" class="window" :class="{ open: item.open }">
          <div class="row">
            <span class="range mono">{{ item.rangeTxt }}</span>
            <span class="conf" :class="item.confidenceKey">{{ t(`windows.${item.confidenceKey}`) }}</span>
          </div>
          <div class="bar">
            <div class="bar-green" :style="{ width: item.greenPct + '%' }"></div>
            <div class="bar-amber" :style="{ width: item.amberPct + '%' }"></div>
          </div>
          <p v-if="item.tooShort" class="too-short">{{ t('windows.tooShort', { duration: item.durationTxt }) }}</p>
          <div v-else class="row footer">
            <span>{{ t('windows.lastDeparture', { time: item.deadlineTxt }) }}</span>
            <span>{{ t('windows.lowTide', { time: item.lowTxt }) }} · {{ item.greenDurationTxt }}</span>
          </div>
          <div v-if="item.floodsTxt" class="row floods">
            <span>{{ t('windows.floodsAt', { time: item.floodsTxt }) }}</span>
          </div>
        </div>
      </div>
    </div>

    <p class="note">{{ t('windows.amberNote') }}</p>

    <button type="button" class="btn-link" @click="emit('toggle-extended')">
      {{ extended ? t('windows.showLess') : t('windows.showMore') }}
    </button>
    <p v-if="extended" class="note extended">{{ t('windows.extendedNote') }}</p>
  </section>
</template>

<style scoped>
.intro {
  font-size: 0.9rem;
  margin-bottom: 14px;
}

.none {
  color: var(--verdict-caution-fg);
  font-weight: 500;
}

.groups {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.day-label {
  font-weight: 600;
  font-size: 0.8rem;
  color: var(--text-secondary);
  margin-bottom: 6px;
}

.window {
  background: var(--page);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 8px;
}

.window.open {
  border-color: var(--verdict-safe-bd);
}

.row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 8px;
}

.range {
  font-size: 15px;
  font-weight: 600;
  color: var(--verdict-safe-fg);
  white-space: nowrap;
}

.conf {
  font-size: 10.5px;
  font-weight: 600;
  padding: 3px 8px;
  border-radius: 999px;
  white-space: nowrap;
}

.conf.confidenceHigh {
  background: var(--conf-high-bg);
  color: var(--conf-high-fg);
}
.conf.confidenceMedium {
  background: var(--conf-medium-bg);
  color: var(--conf-medium-fg);
}
.conf.confidenceLow {
  background: var(--conf-low-bg);
  color: var(--conf-low-fg);
}
.conf.confidenceVeryLow {
  background: var(--conf-verylow-bg);
  color: var(--conf-verylow-fg);
}

.bar {
  display: flex;
  height: 6px;
  border-radius: 3px;
  overflow: hidden;
  background: var(--grid);
}

.bar-green {
  background: var(--verdict-safe-accent);
}

.bar-amber {
  background: var(--verdict-caution-accent);
}

.footer {
  font-size: 11.5px;
  color: var(--text-secondary);
}

.floods {
  font-size: 11px;
  color: var(--verdict-unsafe-fg);
  font-weight: 600;
}

.too-short {
  font-size: 11.5px;
  color: var(--verdict-caution-fg);
  margin: 0;
}

.note {
  font-size: 11px;
  color: var(--text-muted);
  line-height: 1.5;
  margin: 10px 0 0;
}

.btn-link {
  background: none;
  border: 1px solid var(--border);
  color: var(--accent);
  border-radius: 12px;
  padding: 11px 14px;
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
  width: 100%;
  margin-top: 10px;
}

.note.extended {
  background: var(--page);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 11px 14px;
  margin-top: 8px;
}
</style>

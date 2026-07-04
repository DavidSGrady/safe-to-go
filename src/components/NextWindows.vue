<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { dayLabel, fmtTime, splitDuration } from '@/lib/format'
import type { SafeWindow } from '@/lib/types'

const props = defineProps<{
  windows: SafeWindow[]
  now: number
}>()

const { t, locale } = useI18n()

const items = computed(() =>
  props.windows.slice(0, 4).map((w) => {
    const open = w.start <= props.now && props.now < w.end
    const label = dayLabel(w.start, props.now, locale.value)
    const { hours, minutes } = splitDuration(w.end - w.start)
    return {
      key: w.start,
      open,
      day: label === 'today' ? t('windows.today') : label === 'tomorrow' ? t('windows.tomorrow') : label,
      from: fmtTime(w.start, locale.value),
      until: fmtTime(w.end, locale.value),
      duration: t('windows.duration', { hours, minutes }),
    }
  }),
)
</script>

<template>
  <section class="card">
    <h2>{{ t('windows.title') }}</h2>
    <p class="secondary intro">{{ t('windows.intro') }}</p>

    <p v-if="items.length === 0" class="none">{{ t('windows.none') }}</p>

    <ol v-else class="windows">
      <li v-for="item in items" :key="item.key" class="window" :class="{ open: item.open }">
        <span class="dot" aria-hidden="true"></span>
        <div class="when">
          <strong>{{ item.open ? t('windows.nowOpen') : item.day }}</strong>
          <span class="times">
            <template v-if="!item.open">{{ t('windows.from', { time: item.from }) }} </template>{{ t('windows.until', { time: item.until }) }}
          </span>
        </div>
        <span class="duration">{{ item.duration }}</span>
      </li>
    </ol>
  </section>
</template>

<style scoped>
.intro {
  font-size: 0.9rem;
}

.none {
  color: var(--ink-caution);
  font-weight: 500;
}

.windows {
  list-style: none;
  margin: 0;
  padding: 0;
}

.window {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 0;
  border-bottom: 1px solid var(--grid);
}

.window:last-child {
  border-bottom: none;
}

.dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--baseline);
  flex-shrink: 0;
}

.window.open .dot {
  background: var(--ink-safe);
}

.window.open strong {
  color: var(--ink-safe);
}

.when {
  flex: 1;
  display: flex;
  flex-direction: column;
}

.times {
  color: var(--text-secondary);
  font-size: 0.9rem;
  font-variant-numeric: tabular-nums;
}

.duration {
  color: var(--text-muted);
  font-size: 0.85rem;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
</style>

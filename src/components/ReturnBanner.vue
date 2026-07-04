<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { dayLabel, fmtTime } from '@/lib/format'
import type { StatusResult } from '@/lib/types'

const props = defineProps<{
  status: StatusResult
  now: number
}>()

const { t, locale } = useI18n()

const ok = computed(() => props.status.lastDepartureToday !== null)

const nextWindow = computed(() => props.status.windows.find((w) => w.start > props.now) ?? null)

function dayTxt(ms: number): string {
  const label = dayLabel(ms, props.now, locale.value)
  return label === 'today' ? t('common.today') : label === 'tomorrow' ? t('common.tomorrow') : label
}
</script>

<template>
  <div class="banner" :class="{ ok }">
    <div class="title">{{ ok ? t('retur.titleOk') : t('retur.titleNone') }}</div>
    <div class="body">
      <template v-if="ok && status.lastDepartureToday">
        {{ t('retur.bodyOk', { time: fmtTime(status.lastDepartureToday.deadline, locale) }) }}
      </template>
      <template v-else-if="nextWindow">
        {{
          t('retur.bodyWithNext', {
            day: dayTxt(nextWindow.start),
            time: fmtTime(nextWindow.start, locale),
            deadline: fmtTime(nextWindow.deadline, locale),
          })
        }}
      </template>
      <template v-else>{{ t('retur.bodyNoNext') }}</template>
    </div>
  </div>
</template>

<style scoped>
.banner {
  border-radius: 12px;
  padding: 11px 14px;
  margin-bottom: 12px;
  background: var(--verdict-unknown-bg);
  border: 1px solid var(--verdict-unknown-bd);
  color: var(--verdict-unknown-fg);
}

.banner.ok {
  background: var(--verdict-safe-bg);
  border-color: var(--verdict-safe-bd);
  color: var(--verdict-safe-fg);
}

.title {
  font-weight: 600;
  font-size: 0.85rem;
}

.body {
  font-size: 0.82rem;
  line-height: 1.5;
  margin-top: 2px;
}
</style>

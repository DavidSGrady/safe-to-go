<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { fmtTime } from '@/lib/format'
import type { StatusResult } from '@/lib/types'

// The return banner only appears when it adds something the verdict pane
// doesn't: a still-possible same-day return trip. `lastDepartureToday` is the
// last window whose deadline is still today, so its deadline is today's time.
// In every other case the verdict already answers "when can I cross?", so the
// banner stays hidden rather than repeating it.
defineProps<{ status: StatusResult }>()

const { t, locale } = useI18n()
</script>

<template>
  <div v-if="status.lastDepartureToday" class="banner ok">
    <div class="title">{{ t('retur.titleOk') }}</div>
    <div class="body">
      {{ t('retur.bodyOk', { time: fmtTime(status.lastDepartureToday.deadline, locale) }) }}
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

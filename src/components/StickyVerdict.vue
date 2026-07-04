<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { fmtTime } from '@/lib/format'
import type { StatusResult } from '@/lib/types'

const props = defineProps<{
  status: StatusResult
  now: number
  visible: boolean
}>()

const { t, locale } = useI18n()

const icon = computed(
  () => ({ safe: '✓', caution: '!', unsafe: '✕', unknown: '?' })[props.status.state],
)

const title = computed(() => {
  switch (props.status.state) {
    case 'safe':
      return t('verdict.safeTitle')
    case 'caution':
      return t('verdict.cautionTitle')
    case 'unsafe':
      return t('verdict.unsafeTitle')
    default:
      return t('verdict.unknownTitle')
  }
})

const next = computed(() => props.status.windows.find((w) => w.start > props.now) ?? null)

const short = computed(() => {
  const s = props.status
  if (s.state === 'safe' && s.currentWindow) {
    return t('verdict.shortSafe', { time: fmtTime(s.currentWindow.deadline, locale.value) })
  }
  if (s.state === 'caution') return t('verdict.shortCaution')
  if (s.state === 'unsafe') {
    return next.value
      ? t('verdict.shortUnsafe', { time: fmtTime(next.value.start, locale.value) })
      : t('verdict.shortNone')
  }
  return t('verdict.shortNone')
})
</script>

<template>
  <div class="sticky-bar" :class="[status.state, { visible }]" aria-hidden="true">
    <div class="sticky-inner">
      <span class="icon">{{ icon }}</span>
      <span class="title">{{ title }}</span>
      <span class="short">{{ short }}</span>
    </div>
  </div>
</template>

<style scoped>
.sticky-bar {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 50;
  color: #fff;
  transform: translateY(-100%);
  transition: transform 0.25s ease;
  box-shadow: 0 2px 10px rgba(27, 43, 46, 0.18);
  padding-top: env(safe-area-inset-top);
}

.sticky-bar.visible {
  transform: translateY(0);
}

.sticky-bar.safe {
  background: var(--verdict-safe-accent);
}
.sticky-bar.caution {
  background: var(--verdict-caution-accent);
}
.sticky-bar.unsafe {
  background: var(--verdict-unsafe-accent);
}
.sticky-bar.unknown {
  background: var(--verdict-unknown-accent);
}

.sticky-inner {
  max-width: 640px;
  margin: 0 auto;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
}

.icon {
  font-weight: 700;
  font-size: 15px;
}

.title {
  font-weight: 700;
  font-size: 15px;
}

.short {
  margin-left: auto;
  font-family: var(--font-mono);
  font-size: 11.5px;
  white-space: nowrap;
}
</style>

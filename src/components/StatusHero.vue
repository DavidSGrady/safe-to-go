<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { dayLabel, fmtTime, splitDuration } from '@/lib/format'
import type { SafetyRules, StatusResult } from '@/lib/types'

const props = defineProps<{
  status: StatusResult
  rules: SafetyRules
  now: number
}>()

const { t, locale } = useI18n()

const icon = computed(
  () => ({ safe: '✓', caution: '!', unsafe: '✕', unknown: '?' })[props.status.state],
)

const durationTxt = (ms: number): string => {
  const { hours, minutes } = splitDuration(ms)
  return t('windows.duration', { hours, minutes })
}

const dayTxt = (ms: number): string => {
  const label = dayLabel(ms, props.now, locale.value)
  return label === 'today' ? t('common.today') : label === 'tomorrow' ? t('common.tomorrow') : label
}

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

// Simple current-water-level statement (with trend), or the unknown message
// when we have no reading at all.
const sub = computed(() => {
  const s = props.status
  if (s.currentLevelCm === null) return t('verdict.unknownSub')
  const base = t('verdict.levelNow', { cm: s.currentLevelCm })
  if (s.rising === null) return base
  return `${base} · ${s.rising ? t('common.rising') : t('common.falling')}`
})

/** The two-line countdown box: what to do and when. */
const lines = computed(() => {
  const s = props.status
  const next = s.windows.find((w) => w.start > props.now)
  if (s.state === 'safe' && s.currentWindow) {
    return {
      line1: t('verdict.safeLine1', { time: fmtTime(s.currentWindow.deadline, locale.value) }),
      line2: durationTxt(s.currentWindow.deadline - props.now),
    }
  }
  if (s.state === 'caution') {
    if (next) {
      return {
        line1: t('verdict.cautionLine1WithNext'),
        line2: t('verdict.cautionLine2WithNext', {
          day: dayTxt(next.start),
          time: fmtTime(next.start, locale.value),
        }),
      }
    }
    return { line1: t('verdict.cautionLine1NoNext'), line2: '' }
  }
  if (s.state === 'unsafe') {
    if (next) {
      return {
        line1: t('verdict.unsafeLine1WithNext', { day: dayTxt(next.start), time: fmtTime(next.start, locale.value) }),
        line2: t('verdict.unsafeLine2WithNext', { time: fmtTime(next.deadline, locale.value) }),
      }
    }
    return { line1: t('verdict.unsafeLine1NoNext'), line2: '' }
  }
  return { line1: '', line2: '' }
})

// When the water reaches the road for the window we're in — the raw fact
// behind the deadline, so people can subtract their own crossing time + buffer.
const floodsAtTxt = computed(() => {
  const w = props.status.currentWindow
  if (w && w.floodsAt !== null) return fmtTime(w.floodsAt, locale.value)
  return null
})

const freshnessTxt = computed(() => {
  if (props.status.lastObservedAt === null) return null
  const { hours, minutes } = splitDuration(props.now - props.status.lastObservedAt)
  const duration = hours > 0 ? t('common.agoHoursMinutes', { hours, minutes }) : t('common.agoMinutes', { minutes })
  return props.status.dataFresh
    ? t('verdict.freshFresh', { duration })
    : t('verdict.freshStale', { duration })
})
</script>

<template>
  <section class="verdict" :class="status.state" role="status" aria-live="polite">
    <div class="badge" aria-hidden="true">{{ icon }}</div>
    <h1 class="title">{{ title }}</h1>
    <p class="sub">{{ sub }}</p>

    <div v-if="lines.line1" class="box">
      <div class="box-l1">{{ lines.line1 }}</div>
      <div v-if="lines.line2" class="box-l2">{{ lines.line2 }}</div>
    </div>

    <p v-if="floodsAtTxt" class="floods">{{ t('verdict.floodsAt', { time: floodsAtTxt }) }}</p>

    <p v-if="!status.dataFresh && status.lastObservedAt" class="banner banner-stale">
      {{
        t('verdict.staleBanner', {
          duration:
            splitDuration(now - status.lastObservedAt).hours > 0
              ? t('common.agoHoursMinutes', splitDuration(now - status.lastObservedAt))
              : t('common.agoMinutes', { minutes: splitDuration(now - status.lastObservedAt).minutes }),
        })
      }}
    </p>

    <p v-if="freshnessTxt" class="freshness">
      <span class="dot" :class="{ stale: !status.dataFresh }" aria-hidden="true"></span>
      {{ freshnessTxt }}
    </p>
  </section>
</template>

<style scoped>
.verdict {
  border-radius: var(--radius);
  padding: 26px 22px 18px;
  text-align: center;
  margin-bottom: 12px;
  border: 1px solid;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}

.verdict.safe {
  background: var(--verdict-safe-bg);
  border-color: var(--verdict-safe-bd);
  color: var(--verdict-safe-fg);
}
.verdict.caution {
  background: var(--verdict-caution-bg);
  border-color: var(--verdict-caution-bd);
  color: var(--verdict-caution-fg);
}
.verdict.unsafe {
  background: var(--verdict-unsafe-bg);
  border-color: var(--verdict-unsafe-bd);
  color: var(--verdict-unsafe-fg);
}
.verdict.unknown {
  background: var(--verdict-unknown-bg);
  border-color: var(--verdict-unknown-bd);
  color: var(--verdict-unknown-fg);
}

.badge {
  width: 46px;
  height: 46px;
  border-radius: 50%;
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: 21px;
}
.safe .badge {
  background: var(--verdict-safe-accent);
}
.caution .badge {
  background: var(--verdict-caution-accent);
}
.unsafe .badge {
  background: var(--verdict-unsafe-accent);
}
.unknown .badge {
  background: var(--verdict-unknown-accent);
}

.title {
  font-weight: 700;
  font-size: 1.9rem;
  line-height: 1.1;
  margin: 0;
}

.sub {
  font-size: 0.9rem;
  line-height: 1.55;
  opacity: 0.9;
  text-wrap: pretty;
  margin: 0;
  max-width: 46ch;
}

.box {
  font-family: var(--font-mono);
  font-weight: 600;
  background: rgba(255, 255, 255, 0.55);
  padding: 9px 18px;
  border-radius: 9px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.box-l1 {
  font-size: 15px;
  white-space: nowrap;
}

.box-l2 {
  font-size: 12.5px;
  opacity: 0.85;
}

.floods {
  font-size: 0.78rem;
  font-weight: 600;
  opacity: 0.9;
  margin: 0;
}

.banner {
  font-size: 0.75rem;
  font-weight: 600;
  background: rgba(255, 255, 255, 0.55);
  border: 1px solid rgba(0, 0, 0, 0.12);
  padding: 4px 12px;
  border-radius: 999px;
  margin: 0;
}

.banner-stale {
  color: var(--verdict-caution-fg);
  background: var(--verdict-caution-bg);
  border-color: var(--verdict-caution-bd);
}

.freshness {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 0.72rem;
  opacity: 0.85;
  border-top: 1px solid rgba(0, 0, 0, 0.09);
  padding-top: 9px;
  margin: 2px 0 0;
  width: 100%;
  justify-content: center;
}

.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--verdict-safe-accent);
  flex: none;
}

.dot.stale {
  background: var(--verdict-caution-accent);
}
</style>

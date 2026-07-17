<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { dayLabel, fmtTime } from '@/lib/format'
import {
  clearMarker,
  getArmedStation,
  needsIOSInstall,
  notificationsDenied,
  pushCapable,
  subscribePassable,
  unsubscribePassable,
} from '@/lib/push'
import type { StatusResult } from '@/lib/types'

const props = defineProps<{
  status: StatusResult | null
  stationId: string
  now: number
}>()

const { t, locale } = useI18n()

const capable = pushCapable()
const iosHint = needsIOSInstall() && !capable
const armed = ref(false)
const denied = ref(notificationsDenied())
const errored = ref(false)
const busy = ref(false)

onMounted(async () => {
  armed.value = (await getArmedStation()) === props.stationId
})
watch(
  () => props.stationId,
  async (id) => {
    armed.value = (await getArmedStation()) === id
  },
)

// Once the state turns passable the one-shot has served its purpose (the
// push fired, or the server will have consumed/expired the row) — clear the
// marker so a later unsafe period starts from the button again.
watch(
  () => props.status?.state,
  (state) => {
    if (armed.value && state && state !== 'unsafe') {
      armed.value = false
      clearMarker()
    }
  },
)

// Only offered while the road is impassable — that's the moment the promise
// "we'll tell you when it's passable" makes sense.
const visible = computed(() => props.status?.state === 'unsafe' && (capable || iosHint))

// "Expected passable ~HH:MM" from the same window engine as the verdict.
const expectedTxt = computed(() => {
  const start = props.status?.windows[0]?.start
  if (!start) return null
  const label = dayLabel(start, props.now, locale.value)
  const time = fmtTime(start, locale.value)
  return label === 'today' ? time : `${label === 'tomorrow' ? t('common.tomorrow') : label} ${time}`
})

async function arm(): Promise<void> {
  busy.value = true
  errored.value = false
  const result = await subscribePassable(props.stationId, locale.value)
  busy.value = false
  if (result === 'subscribed') armed.value = true
  else if (result === 'denied') denied.value = true
  else errored.value = true
}

async function cancel(): Promise<void> {
  armed.value = false
  await unsubscribePassable()
}
</script>

<template>
  <div v-if="visible" class="notify" role="group" :aria-label="t('notify.button')">
    <p v-if="iosHint" class="hint">{{ t('notify.iosHint') }}</p>

    <p v-else-if="denied" class="hint">{{ t('notify.denied') }}</p>

    <template v-else-if="armed">
      <div class="armed-row">
        <span class="bell" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path
              d="M8 2a4 4 0 0 0-4 4v2.6L2.8 11h10.4L12 8.6V6a4 4 0 0 0-4-4Zm-1.5 10a1.5 1.5 0 0 0 3 0"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linejoin="round"
              stroke-linecap="round"
            />
          </svg>
        </span>
        <span class="armed-txt">
          {{ t('notify.subscribed') }}
          <template v-if="expectedTxt"> {{ t('notify.expected', { time: expectedTxt }) }}</template>
        </span>
        <button type="button" class="cancel" @click="cancel()">{{ t('notify.cancel') }}</button>
      </div>
    </template>

    <template v-else>
      <button type="button" class="arm-btn" :disabled="busy" @click="arm()">
        {{ t('notify.button') }}
      </button>
      <p v-if="errored" class="hint err">{{ t('notify.error') }}</p>
    </template>
  </div>
</template>

<style scoped>
.notify {
  margin: 10px 0 0;
}

.arm-btn {
  width: 100%;
  border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--border));
  background: color-mix(in srgb, var(--accent) 9%, var(--surface));
  color: var(--text-primary);
  border-radius: 12px;
  padding: 11px 14px;
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.arm-btn:disabled {
  opacity: 0.6;
  cursor: default;
}

.armed-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--border));
  background: color-mix(in srgb, var(--accent) 9%, var(--surface));
  border-radius: 12px;
  padding: 10px 14px;
  font-size: 12.5px;
  line-height: 1.45;
}
.bell {
  color: var(--accent);
  flex: none;
  transform: translateY(2px);
}
.armed-txt {
  flex: 1;
  min-width: 0;
  color: var(--text-secondary);
}
.cancel {
  background: none;
  border: none;
  padding: 0;
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  color: var(--accent);
  cursor: pointer;
  flex: none;
}

.hint {
  margin: 0;
  font-size: 11.5px;
  color: var(--text-muted);
  line-height: 1.5;
}
.hint.err {
  color: var(--verdict-caution-fg);
  margin-top: 6px;
}
</style>

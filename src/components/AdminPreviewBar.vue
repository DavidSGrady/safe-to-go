<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { storeToRefs } from 'pinia'
import { fmtDateTime, splitDuration } from '@/lib/format'
import { useStatusStore } from '@/stores/status'

const { t, locale } = useI18n()
const store = useStatusStore()
const { realNow } = storeToRefs(store)

// Scrub the whole page across the next 24 hours.
const MAX_OFFSET_MIN = 24 * 60
const active = ref(false)
const offsetMin = ref(0)
const playing = ref(false)
let timer: ReturnType<typeof setInterval> | null = null

function stopPlay(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  playing.value = false
}

/** Push the current state into the store so every panel re-renders. */
function sync(): void {
  store.setPreviewOffset(active.value ? offsetMin.value : null)
}

function toggleActive(): void {
  active.value = !active.value
  if (!active.value) {
    stopPlay()
    offsetMin.value = 0
  }
  sync()
}

function onScrub(): void {
  active.value = true
  sync()
}

function togglePlay(): void {
  if (playing.value) {
    stopPlay()
    return
  }
  active.value = true
  if (offsetMin.value >= MAX_OFFSET_MIN) offsetMin.value = 0
  playing.value = true
  timer = setInterval(() => {
    offsetMin.value = Math.min(MAX_OFFSET_MIN, offsetMin.value + 6)
    if (offsetMin.value >= MAX_OFFSET_MIN) stopPlay()
  }, 90)
}

function reset(): void {
  offsetMin.value = 0
  sync()
}

watch(offsetMin, () => {
  if (active.value) sync()
})

// Never leave the public page frozen in a simulated time when we unmount.
onBeforeUnmount(() => {
  stopPlay()
  store.setPreviewOffset(null)
})

const simTime = computed(() => fmtDateTime(realNow.value + offsetMin.value * 60_000, locale.value))

const offsetTxt = computed(() => {
  if (offsetMin.value === 0) return t('preview.now')
  const { hours, minutes } = splitDuration(offsetMin.value * 60_000)
  return t('road.inDuration', { duration: t('windows.duration', { hours, minutes }) })
})
</script>

<template>
  <div class="preview-bar" :class="{ active }">
    <div class="inner">
      <span class="tag">{{ t('preview.label') }}</span>

      <button
        type="button"
        class="round-btn play"
        :aria-label="playing ? t('preview.pause') : t('preview.play')"
        @click="togglePlay"
      >
        {{ playing ? '❚❚' : '▶' }}
      </button>
      <button type="button" class="round-btn" :aria-label="t('preview.reset')" @click="reset">⟲</button>

      <input
        v-model.number="offsetMin"
        type="range"
        min="0"
        :max="MAX_OFFSET_MIN"
        step="5"
        :aria-label="t('preview.label')"
        @input="onScrub"
      />

      <span class="clock">
        <span class="when">{{ active ? simTime : t('preview.live') }}</span>
        <span v-if="active" class="offset">{{ offsetTxt }}</span>
      </span>

      <button type="button" class="toggle" @click="toggleActive">
        {{ active ? t('preview.disable') : t('preview.enable') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.preview-bar {
  position: sticky;
  top: 0;
  z-index: 60;
  margin: -16px -16px 16px;
  padding: 8px 16px calc(8px);
  padding-top: calc(8px + env(safe-area-inset-top));
  background: var(--text-primary);
  color: var(--page);
  box-shadow: 0 2px 10px rgba(27, 43, 46, 0.18);
}

.preview-bar.active {
  background: var(--verdict-caution-accent);
}

.inner {
  max-width: 640px;
  margin: 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
}

.tag {
  font-size: 0.62rem;
  font-weight: 700;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  opacity: 0.85;
  flex: none;
}

.round-btn {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, 0.4);
  background: rgba(255, 255, 255, 0.12);
  color: inherit;
  display: flex;
  align-items: center;
  justify-content: center;
  flex: none;
  cursor: pointer;
  padding: 0;
  font-size: 10px;
}

input[type='range'] {
  flex: 1;
  min-width: 40px;
  padding: 0;
  border: none;
  background: transparent;
  accent-color: #fff;
  height: 24px;
}

.clock {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  line-height: 1.15;
  flex: none;
}

.when {
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
}

.offset {
  font-size: 9.5px;
  opacity: 0.85;
  white-space: nowrap;
}

.toggle {
  flex: none;
  border: 1px solid rgba(255, 255, 255, 0.4);
  background: rgba(255, 255, 255, 0.12);
  color: inherit;
  border-radius: 999px;
  padding: 5px 11px;
  font-size: 0.72rem;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
}

.round-btn:focus-visible,
.toggle:focus-visible,
input[type='range']:focus-visible {
  outline: 2px solid #fff;
  outline-offset: 1px;
}
</style>

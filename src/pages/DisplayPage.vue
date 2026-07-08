<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { storeToRefs } from 'pinia'
import { useStatusStore } from '@/stores/status'
import { isDemoMode } from '@/lib/supabase'
import { fmtDateTime, fmtTime } from '@/lib/format'
import StatusHero from '@/components/StatusHero.vue'
import WindowsList from '@/components/WindowsList.vue'
import LangSwitcher from '@/components/LangSwitcher.vue'

const { t, locale } = useI18n()
const store = useStatusStore()
const { status, rules, loading, error, now, extended, primaryStationName } = storeToRefs(store)

// Kiosk page for shops/restaurants: meant to run unattended on a tablet or
// PC. The store already keeps the data fresh on its own (5-min poll, realtime
// push, 30-s clock tick). On top of that, do a full page reload twice a day
// so a screen that stays open for weeks also picks up new frontend deploys.
const RELOAD_MS = 12 * 60 * 60 * 1000
let reloadTimer: number | undefined

// Best-effort screen wake lock so an unattended tablet doesn't go to sleep.
// Not supported everywhere; failure is fine (kiosk devices usually have a
// no-sleep setting too). Reacquire when the tab becomes visible again — the
// browser releases the lock whenever the page is hidden.
let wakeLock: WakeLockSentinel | null = null
async function acquireWakeLock(): Promise<void> {
  try {
    wakeLock = (await navigator.wakeLock?.request('screen')) ?? null
  } catch {
    wakeLock = null
  }
}
function onVisibility(): void {
  if (document.visibilityState === 'visible') void acquireWakeLock()
}

onMounted(() => {
  store.start()
  reloadTimer = window.setInterval(() => window.location.reload(), RELOAD_MS)
  void acquireWakeLock()
  document.addEventListener('visibilitychange', onVisibility)
})
onBeforeUnmount(() => {
  window.clearInterval(reloadTimer)
  document.removeEventListener('visibilitychange', onVisibility)
  void wakeLock?.release().catch(() => {})
  wakeLock = null
})

const clock = computed(() => fmtTime(now.value, locale.value))
const printedAtTxt = computed(() => fmtDateTime(now.value, locale.value))

function printPage(): void {
  window.print()
}
</script>

<template>
  <div class="display-page">
    <header class="top">
      <div class="brand-block">
        <span class="brand">{{ t('app.title') }}</span>
        <span class="sub">{{ t('app.subtitle') }}</span>
      </div>
      <div class="clock mono" aria-hidden="true">{{ clock }}</div>
      <div class="tools">
        <LangSwitcher />
        <button type="button" class="print-btn" @click="printPage">{{ t('display.print') }}</button>
      </div>
    </header>

    <p v-if="isDemoMode" class="demo-banner">{{ t('demo.banner') }}</p>

    <div v-if="loading && !status" class="card skeleton" aria-busy="true"></div>

    <template v-else-if="status && rules">
      <div class="cols">
        <div class="col">
          <StatusHero :status="status" :rules="rules" :now="now" />
        </div>
        <div class="col">
          <WindowsList
            :windows="status.windows"
            :now="now"
            :extended="extended"
            @toggle-extended="store.toggleExtended"
          />
        </div>
      </div>
    </template>

    <p v-if="error && !status" class="card error">{{ t('verdict.unknownSub') }}</p>

    <p class="print-note">{{ t('display.printedNote', { time: printedAtTxt }) }}</p>

    <footer>
      <p class="muted auto-note">{{ t('display.autoUpdates') }}</p>
      <p class="muted">{{ t('footer.disclaimer') }}</p>
      <p class="muted">{{ t('footer.source', { station: primaryStationName }) }}</p>
    </footer>
  </div>
</template>

<style scoped>
/* Wider than the normal .page column — this runs on tablets/monitors, not
   phones. On big screens the whole page scales up so it reads from across
   a shop counter. */
.display-page {
  max-width: 1060px;
  margin: 0 auto;
  padding: 20px 20px calc(32px + env(safe-area-inset-bottom));
}

@media (min-width: 1400px) {
  .display-page {
    zoom: 1.3;
  }
}

.top {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}

.brand-block {
  min-width: 0;
}

.brand {
  display: block;
  font-weight: 800;
  font-size: 1.35rem;
}

.sub {
  display: block;
  color: var(--text-muted);
  font-size: 0.85rem;
}

.clock {
  flex: 1;
  text-align: center;
  font-size: 2.1rem;
  font-weight: 600;
  color: var(--text-secondary);
  letter-spacing: 0.03em;
}

.tools {
  display: flex;
  align-items: center;
  gap: 10px;
}

.print-btn {
  padding: 8px 14px;
  border: 1px solid var(--accent);
  border-radius: 10px;
  background: var(--surface);
  color: var(--accent);
  font: inherit;
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
}

.demo-banner {
  background: var(--verdict-caution-accent);
  color: #fff;
  border-radius: 12px;
  padding: 8px 14px;
  font-size: 0.85rem;
  margin: 0 0 16px;
}

/* Verdict and windows side by side on wide screens, stacked on narrow. */
.cols {
  display: grid;
  grid-template-columns: 1fr;
  gap: 16px;
  align-items: start;
}

@media (min-width: 920px) {
  .cols {
    grid-template-columns: 1fr 1fr;
  }
}

.skeleton {
  height: 320px;
  animation: pulse 1.2s ease-in-out infinite;
}

@keyframes pulse {
  50% {
    opacity: 0.5;
  }
}

.error {
  color: var(--verdict-unsafe-fg);
}

/* Only appears on paper (see @media print below). */
.print-note {
  display: none;
}

footer {
  margin-top: 24px;
}

footer .muted {
  margin-bottom: 6px;
}

.auto-note {
  font-weight: 600;
  color: var(--text-secondary);
}

@media print {
  .display-page {
    max-width: none;
    padding: 0;
    zoom: 1;
  }
  .clock,
  .tools,
  .auto-note,
  .demo-banner {
    display: none !important;
  }
  .cols {
    display: block;
  }
  /* The show-more toggle inside WindowsList is meaningless on paper. */
  .col :deep(.btn-link) {
    display: none;
  }
  .print-note {
    display: block;
    margin-top: 14px;
    padding: 10px 12px;
    border: 1px solid #000;
    border-radius: 8px;
    font-size: 0.85rem;
    font-weight: 600;
  }
}
</style>

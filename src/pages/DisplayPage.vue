<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { storeToRefs } from 'pinia'
import { renderSVG } from 'uqr'
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
// Kiosk-fit: a landscape tablet/monitor behind glass can't scroll, so the
// whole page must fit the viewport — verdict and windows side by side, the
// windows list capped, and the QR footer always on screen (CSS .kiosk-fit).
const KIOSK_MQ = '(min-width: 900px) and (orientation: landscape)'
const kioskFit = ref(false)
let kioskMq: MediaQueryList | undefined
function onKioskMq(): void {
  kioskFit.value = kioskMq?.matches ?? false
}
/** How many windows fit next to the verdict without scrolling. */
const KIOSK_WINDOW_LIMIT = 3

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
  kioskMq = window.matchMedia(KIOSK_MQ)
  onKioskMq()
  kioskMq.addEventListener('change', onKioskMq)
})
onBeforeUnmount(() => {
  window.clearInterval(reloadTimer)
  document.removeEventListener('visibilitychange', onVisibility)
  kioskMq?.removeEventListener('change', onKioskMq)
  void wakeLock?.release().catch(() => {})
  wakeLock = null
})

const clock = computed(() => fmtTime(now.value, locale.value))
const printedAtTxt = computed(() => fmtDateTime(now.value, locale.value))

// QR code to the public site, so people at the counter can take it home on
// their phone without typing a URL. Generated locally (uqr) — no external
// service, works on whatever domain the page is served from, prints too.
// Colors are fixed black-on-white (never theme vars) so it always scans.
const qrSvg = renderSVG(`${window.location.origin}/`, {
  border: 2,
  blackColor: '#000',
  whiteColor: '#fff',
})

function printPage(): void {
  window.print()
}
</script>

<template>
  <div class="display-page" :class="{ 'kiosk-fit': kioskFit }">
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
        <div class="col col-windows">
          <WindowsList
            :windows="status.windows"
            :now="now"
            :extended="extended"
            :limit="kioskFit ? KIOSK_WINDOW_LIMIT : undefined"
            @toggle-extended="store.toggleExtended"
          />
        </div>
      </div>
    </template>

    <p v-if="error && !status" class="card error">{{ t('verdict.unknownSub') }}</p>

    <p class="print-note">{{ t('display.printedNote', { time: printedAtTxt }) }}</p>

    <footer class="footer-cols">
      <div class="footer-text">
        <p class="muted auto-note">{{ t('display.autoUpdates') }}</p>
        <p class="muted">{{ t('footer.disclaimer') }}</p>
        <p class="muted">{{ t('footer.source', { station: primaryStationName }) }}</p>
      </div>
      <div class="qr-block">
        <div class="qr" v-html="qrSvg" aria-hidden="true"></div>
        <p class="qr-caption">{{ t('display.scanQr') }}</p>
      </div>
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

/* Kiosk-fit (landscape tablets/monitors, class set from the media query in
   the script): lock the page to the viewport height — no scrolling behind
   glass. Header and footer keep their natural height; the two columns take
   the rest and clip, with the windows list capped via the `limit` prop so
   nothing renders half-cut. */
.display-page.kiosk-fit {
  height: 100dvh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding-bottom: 12px;
}

@media (min-width: 1400px) {
  /* zoom scales the box but not dvh — divide so the zoomed page still fits. */
  .display-page.kiosk-fit {
    height: calc(100dvh / 1.3);
  }
}

.kiosk-fit .cols {
  flex: 1;
  min-height: 0;
  grid-template-columns: 1fr 1fr;
  overflow: hidden;
}

.kiosk-fit .col {
  min-height: 0;
  max-height: 100%;
  overflow: hidden;
}

/* The 7-day toggle needs scrolling to be useful — meaningless behind glass.
   The intro line and footnote go too: on a fixed-height screen that space is
   better spent on one more crossing window. */
.kiosk-fit .col :deep(.btn-link),
.kiosk-fit .col :deep(.note.extended),
.kiosk-fit .col-windows :deep(.intro),
.kiosk-fit .col-windows :deep(.note) {
  display: none;
}

/* Slightly denser window cards so three fit even with a banner showing. */
.kiosk-fit .col-windows :deep(.window) {
  padding: 9px 12px;
  gap: 6px;
  margin-bottom: 6px;
}
.kiosk-fit .col-windows :deep(.groups) {
  gap: 8px;
}

.kiosk-fit footer {
  margin-top: 12px;
}

.kiosk-fit .qr {
  width: 96px;
  padding: 5px;
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

.footer-cols {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  flex-wrap: wrap;
}

.footer-text {
  min-width: 0;
  flex: 1;
}

.qr-block {
  flex: none;
  text-align: center;
}

/* Always white behind the QR — a dark theme must not eat the quiet zone. */
.qr {
  width: 128px;
  padding: 6px;
  margin: 0 auto;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 12px;
}

.qr :deep(svg) {
  display: block;
  width: 100%;
  height: auto;
}

.qr-caption {
  margin: 6px 0 0;
  max-width: 150px;
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--text-secondary);
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

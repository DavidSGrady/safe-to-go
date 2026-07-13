import { onBeforeUnmount, onMounted, ref } from 'vue'

/**
 * Custom pull-to-refresh for touch devices. Needed because the site is
 * installed as a standalone PWA on phones, where there is no browser chrome
 * and iOS offers no native reload gesture — the rubber-band bounce does
 * nothing by itself.
 *
 * Dragging down while the page is scrolled to the very top reveals an
 * indicator; releasing past the trigger distance runs `onRefresh` (a data
 * refetch, not a page reload). All listeners are passive — we ride along
 * with the native overscroll instead of fighting it.
 */
export function usePullToRefresh(onRefresh: () => Promise<unknown>) {
  /** Indicator height in px while dragging (raw drag distance, dampened). */
  const pullPx = ref(0)
  /** Past the trigger distance — release will refresh. */
  const ready = ref(false)
  const refreshing = ref(false)

  const TRIGGER_PX = 34
  const MAX_PX = 60
  const DAMPING = 0.4
  const MIN_SPIN_MS = 400

  let startY = 0
  let tracking = false

  function onTouchStart(e: TouchEvent) {
    if (refreshing.value || window.scrollY > 0) return
    startY = e.touches[0].clientY
    tracking = true
  }

  function onTouchMove(e: TouchEvent) {
    if (!tracking || refreshing.value) return
    const dy = e.touches[0].clientY - startY
    if (window.scrollY > 0 || dy <= 0) {
      pullPx.value = 0
      ready.value = false
      return
    }
    pullPx.value = Math.min(dy * DAMPING, MAX_PX)
    ready.value = pullPx.value >= TRIGGER_PX
  }

  function onTouchEnd() {
    if (!tracking) return
    tracking = false
    if (ready.value && !refreshing.value) {
      refreshing.value = true
      ready.value = false
      pullPx.value = TRIGGER_PX
      const started = Date.now()
      void Promise.resolve(onRefresh())
        .catch(() => undefined)
        .then(() => {
          // Keep the spinner visible long enough to register as feedback.
          const wait = Math.max(0, MIN_SPIN_MS - (Date.now() - started))
          setTimeout(() => {
            refreshing.value = false
            pullPx.value = 0
          }, wait)
        })
    } else {
      pullPx.value = 0
      ready.value = false
    }
  }

  onMounted(() => {
    window.addEventListener('touchstart', onTouchStart, { passive: true })
    window.addEventListener('touchmove', onTouchMove, { passive: true })
    window.addEventListener('touchend', onTouchEnd, { passive: true })
    window.addEventListener('touchcancel', onTouchEnd, { passive: true })
  })
  onBeforeUnmount(() => {
    window.removeEventListener('touchstart', onTouchStart)
    window.removeEventListener('touchmove', onTouchMove)
    window.removeEventListener('touchend', onTouchEnd)
    window.removeEventListener('touchcancel', onTouchEnd)
  })

  return { pullPx, ready, refreshing }
}

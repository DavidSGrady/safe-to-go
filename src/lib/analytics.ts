// First-party, cookieless page counting. Fired from router.afterEach; the
// server side is api/visit.ts and the visit_record RPC (see the migration
// 20260919000000_visitor_counts.sql, whose header explains the whole design).
//
// THIS MODULE STORES NOTHING ON THE DEVICE, AND MUST NOT START.
// No cookie, no localStorage, no sessionStorage, no IndexedDB. Consent under
// the Danish cookie order attaches to storing or reading information on the
// visitor's device, not to counting -- so storing nothing is precisely what
// keeps this site free of a consent banner. The module-level `lastPath` /
// `lastAt` below are in-memory only and die with the tab, which is fine; the
// moment any of this is persisted, the site needs a consent banner.
//
// Nothing here renders. There is no visitor-facing counter anywhere on the
// site, by design -- the numbers are read from the Supabase SQL editor using
// supabase/visitor_queries.sql.

import { isDemoMode } from './supabase'

/**
 * Routes worth counting. Must stay in step with COUNTED_ROUTES in api/visit.ts
 * and the _route clamp in visit_record. /admin and /login are not visitors, and
 * /display is the shop kiosk, which reloads itself every 12 hours.
 */
const COUNTED = new Set(['/', '/status'])

/**
 * Ignore a repeat of the same path within this window. Guards against a
 * double-fired navigation or a visitor leaning on reload; the DB has its own,
 * much higher per-visitor cap as a backstop.
 */
const REPEAT_GUARD_MS = 30_000

let lastPath = ''
let lastAt = 0

/** Whether to count at all. Dev and demo traffic must never reach prod counts. */
function enabled(): boolean {
  return (
    // `vite dev` does not serve api/*, and a `vite preview` of a production
    // build would otherwise write to the real counters.
    import.meta.env.PROD &&
    !isDemoMode &&
    typeof navigator !== 'undefined' &&
    // Cheap automation filter; the real bot filtering is server-side.
    navigator.webdriver !== true
  )
}

/**
 * Record one pageview. Never throws, never blocks navigation, and never
 * reports failure -- a lost count is always preferable to a degraded page.
 */
export function recordPageview(path: string, locale: string): void {
  if (!enabled() || !COUNTED.has(path)) return

  // A speculation-rules prerender should only count if the visitor actually
  // arrives, so defer until activation.
  const doc = document as Document & { prerendering?: boolean }
  if (doc.prerendering) {
    doc.addEventListener('prerenderingchange', () => recordPageview(path, locale), {
      once: true,
    })
    return
  }

  const now = Date.now()
  if (path === lastPath && now - lastAt < REPEAT_GUARD_MS) return
  lastPath = path
  lastAt = now

  const payload = JSON.stringify({ p: path, r: document.referrer || '', l: locale })

  const fire = () => {
    try {
      // sendBeacon is the right primary: the browser queues it, it survives
      // unload, it cannot be cancelled by a route change, and it never delays
      // navigation. It returns false when the queue is full -- which is exactly
      // when the keepalive fetch should take over. Same-origin, so the JSON
      // Blob still costs no CORS preflight.
      const blob = new Blob([payload], { type: 'application/json' })
      if (navigator.sendBeacon?.('/api/visit', blob)) return
    } catch {
      // fall through to fetch
    }
    void fetch('/api/visit', {
      method: 'POST',
      keepalive: true,
      body: payload,
      headers: { 'Content-Type': 'application/json' },
    }).catch(() => {})
  }

  // Idle, so counting never competes with first paint.
  if ('requestIdleCallback' in window) {
    requestIdleCallback(fire, { timeout: 2000 })
  } else {
    setTimeout(fire, 0)
  }
}

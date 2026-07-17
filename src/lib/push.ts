// Web-push subscription plumbing for "notify me when the road is passable".
// The server side (trigger + sending) lives in the fetch-dmi-data edge
// function; the DB access goes through the push_subscribe/push_unsubscribe
// security-definer RPCs (see 20260726000000_push_subscriptions.sql).

import { getSupabase, isDemoMode } from './supabase'

// The VAPID *public* key — public by design (it ships in the bundle either
// way), so it's baked in rather than routed through a Vercel env var. It must
// match the VAPID_PRIVATE_KEY secret on the Supabase function; rotate both
// together. An env var still overrides it (e.g. for a separate test project).
const VAPID_PUBLIC_KEY =
  (import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined) ??
  'BORiDvM4psfJuWr6LS-9eLUpUH7DdgZ9QpmWN9zakcJMRG-tUBCQvOdjruneKqeDaXbey2n15IOsdObfOQf6h_M'

/** Marks which station a one-shot subscription was armed for. */
const MARKER_KEY = 'push.passable'

/** Whether this browser can do web push at all (and the app is configured for it). */
export function pushCapable(): boolean {
  return (
    !isDemoMode &&
    !!VAPID_PUBLIC_KEY &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  )
}

/**
 * iOS Safari exposes push only to home-screen installs. When this is true the
 * UI should show the install hint instead of a subscribe button.
 */
export function needsIOSInstall(): boolean {
  const iOS =
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    // iPadOS masquerades as macOS but is still touch-first.
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  const standalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true
  return iOS && !standalone
}

export function notificationsDenied(): boolean {
  return 'Notification' in window && Notification.permission === 'denied'
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(b64)
  return Uint8Array.from(raw, (c) => c.charCodeAt(0))
}

async function getRegistration(): Promise<ServiceWorkerRegistration> {
  // register() is idempotent — this also covers the race where the component
  // runs before main.ts's registration resolved.
  return navigator.serviceWorker.register('/sw.js')
}

/**
 * The server expires pending subscriptions after 24 h; a marker older than
 * that is definitely stale. (A marker can also go stale earlier, when the
 * push fires while the app is closed — the armed-state watcher in the
 * component clears it as soon as the state turns passable.)
 */
const MARKER_MAX_AGE_MS = 24 * 3600_000

export function clearMarker(): void {
  localStorage.removeItem(MARKER_KEY)
}

/** The station a pending subscription was armed for, or null. */
export async function getArmedStation(): Promise<string | null> {
  if (!pushCapable()) return null
  const raw = localStorage.getItem(MARKER_KEY)
  if (!raw) return null
  let marker: { station?: string; at?: number }
  try {
    marker = JSON.parse(raw)
  } catch {
    clearMarker()
    return null
  }
  if (!marker.station || !marker.at || Date.now() - marker.at > MARKER_MAX_AGE_MS) {
    clearMarker()
    return null
  }
  try {
    const reg = await navigator.serviceWorker.getRegistration('/')
    const sub = await reg?.pushManager.getSubscription()
    if (!sub) {
      clearMarker()
      return null
    }
    return marker.station
  } catch {
    return null
  }
}

export async function subscribePassable(
  stationId: string,
  locale: string,
): Promise<'subscribed' | 'denied' | 'error'> {
  try {
    const permission = await Notification.requestPermission()
    if (permission !== 'granted') return 'denied'

    const reg = await getRegistration()
    const sub =
      (await reg.pushManager.getSubscription()) ??
      (await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY!) as BufferSource,
      }))

    const json = sub.toJSON()
    if (!json.keys?.p256dh || !json.keys?.auth) return 'error'
    const { error } = await getSupabase().rpc('push_subscribe', {
      _endpoint: sub.endpoint,
      _p256dh: json.keys.p256dh,
      _auth: json.keys.auth,
      _station_id: stationId,
      _locale: locale,
    })
    if (error) return 'error'
    localStorage.setItem(MARKER_KEY, JSON.stringify({ station: stationId, at: Date.now() }))
    return 'subscribed'
  } catch {
    return 'error'
  }
}

export async function unsubscribePassable(): Promise<void> {
  clearMarker()
  try {
    const reg = await navigator.serviceWorker.getRegistration('/')
    const sub = await reg?.pushManager.getSubscription()
    if (!sub) return
    await getSupabase().rpc('push_unsubscribe', { _endpoint: sub.endpoint })
    // Keep the browser-level subscription: it's reusable if they re-arm, and
    // dropping the DB row alone guarantees no further sends.
  } catch {
    // Best effort — the 24 h server-side expiry is the backstop.
  }
}

import { localTimeMs, startOfNextLocalDay } from './format'
import type { SafeWindow, SafetyRules } from './types'

/**
 * Day-trip planner (pure, no I/O).
 *
 * A mainland visitor wants to drive over to Mandø and back the same day. This
 * turns the raw crossing windows into a there-and-back plan, considering only
 * reasonable daylight hours:
 *   - comfortable: 08:00–18:00 (green)
 *   - extended:    06:00–20:00 (amber — early/late crossing; most shops close ~16)
 *
 * A crossing must *start* inside a window's green period `[start, deadline]`
 * (the last safe departure already accounts for crossing time + buffer), so the
 * usable slice of a window is that green period clipped to daylight and to the
 * rest of today.
 */

export const DAYTRIP_COMFORT_HOURS = { start: 8, end: 18 }
export const DAYTRIP_EXTENDED_HOURS = { start: 6, end: 20 }
/** Most shops on Mandø close around this local hour — surfaced in the amber note. */
export const DAYTRIP_SHOPS_CLOSE_HOUR = 16

export type DayTripComfort = 'comfortable' | 'extended'
export type DayTripMode = 'two-window' | 'single-window' | 'none'

export interface DayTripCrossing {
  /** earliest ms it's sensible to *start* this crossing (green ∩ daylight ∩ today) */
  earliest: number
  /** latest ms it's sensible to *start* this crossing */
  latest: number
  /** true when the whole bracket sits within comfortable daytime hours */
  comfortable: boolean
}

export interface DayTripPlan {
  feasible: boolean
  mode: DayTripMode
  /** 'extended' → the plan needs an early/late crossing; render amber + shops note. */
  comfort: DayTripComfort
  outbound: DayTripCrossing | null
  inbound: DayTripCrossing | null
  /** For the infeasible case: ms epoch of the next crossing window, if any. */
  nextWindowStart: number | null
}

interface Bracket {
  comfLo: number
  comfHi: number
  comfOk: boolean
  extLo: number
  extHi: number
  extOk: boolean
}

/** Clip a window's green period to comfortable and extended daylight, plus "today". */
function bracketFor(
  greenLo: number,
  greenHi: number,
  now: number,
  dayEnd: number,
  comfStart: number,
  comfEnd: number,
  extStart: number,
  extEnd: number,
): Bracket {
  const comfLo = Math.max(greenLo, comfStart, now)
  const comfHi = Math.min(greenHi, comfEnd, dayEnd)
  const extLo = Math.max(greenLo, extStart, now)
  const extHi = Math.min(greenHi, extEnd, dayEnd)
  return { comfLo, comfHi, comfOk: comfHi > comfLo, extLo, extHi, extOk: extHi > extLo }
}

export function planDayTrip(windows: SafeWindow[], rules: SafetyRules, now: number): DayTripPlan {
  const dayEnd = startOfNextLocalDay(now)
  const comfStart = localTimeMs(now, DAYTRIP_COMFORT_HOURS.start)
  const comfEnd = localTimeMs(now, DAYTRIP_COMFORT_HOURS.end)
  const extStart = localTimeMs(now, DAYTRIP_EXTENDED_HOURS.start)
  const extEnd = localTimeMs(now, DAYTRIP_EXTENDED_HOURS.end)
  const crossingMs = rules.crossingMinutes * 60_000

  const nextWindowStart = windows.find((w) => w.start > now)?.start ?? null
  const none = (): DayTripPlan => ({
    feasible: false,
    mode: 'none',
    comfort: 'comfortable',
    outbound: null,
    inbound: null,
    nextWindowStart,
  })

  // Windows whose green (safe-to-start) period offers a crossing later today
  // within extended daylight. Each supports at least a one-way crossing.
  const usable = windows
    .map((w) => ({
      w,
      b: bracketFor(w.start, w.deadline, now, dayEnd, comfStart, comfEnd, extStart, extEnd),
    }))
    .filter((x) => x.b.extOk)

  if (usable.length === 0) return none()

  if (usable.length === 1) {
    // One window today: cross over and back within it. Prefer comfortable hours,
    // falling back to extended only if the round trip actually needs them. Needs
    // at least one crossing time of slack so there's room to get over and back.
    const b = usable[0].b
    let lo: number
    let hi: number
    let comfortable: boolean
    if (b.comfOk && b.comfHi - b.comfLo >= crossingMs) {
      lo = b.comfLo
      hi = b.comfHi
      comfortable = true
    } else if (b.extHi - b.extLo >= crossingMs) {
      lo = b.extLo
      hi = b.extHi
      comfortable = false
    } else {
      // Only time for a one-way crossing — not a there-and-back daytrip.
      return none()
    }
    return {
      feasible: true,
      mode: 'single-window',
      comfort: comfortable ? 'comfortable' : 'extended',
      outbound: { earliest: lo, latest: hi - crossingMs, comfortable },
      inbound: { earliest: lo + crossingMs, latest: hi, comfortable },
      nextWindowStart: null,
    }
  }

  // Two or more usable windows: drive over in the first, back in the last, so
  // the visit spans the day (the road floods between — you wait on the island).
  const toCrossing = (b: Bracket): DayTripCrossing =>
    b.comfOk
      ? { earliest: b.comfLo, latest: b.comfHi, comfortable: true }
      : { earliest: b.extLo, latest: b.extHi, comfortable: false }
  const outbound = toCrossing(usable[0].b)
  const inbound = toCrossing(usable[usable.length - 1].b)
  return {
    feasible: true,
    mode: 'two-window',
    comfort: outbound.comfortable && inbound.comfortable ? 'comfortable' : 'extended',
    outbound,
    inbound,
    nextWindowStart: null,
  }
}

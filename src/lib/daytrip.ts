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
  /** Island time (ms) of the chosen plan — shown to the user; 0 when infeasible. */
  islandMs: number
  /**
   * True when a trip is possible but shorter than the recommended length (it
   * still clears the absolute minimum). Render amber with a "short trip" note.
   */
  short: boolean
  /** True when the plan is for tomorrow (it's past the rollover hour today). */
  forTomorrow: boolean
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

type Candidate = DayTripPlan & { islandMs: number }

/** A crossing bracket from a window bracket, preferring comfortable hours. */
function crossingFrom(b: Bracket): DayTripCrossing {
  return b.comfOk
    ? { earliest: b.comfLo, latest: b.comfHi, comfortable: true }
    : { earliest: b.extLo, latest: b.extHi, comfortable: false }
}

export function planDayTrip(windows: SafeWindow[], rules: SafetyRules, now: number): DayTripPlan {
  // Once it's past the admin-set rollover hour, nobody's starting a daytrip
  // today — plan for tomorrow instead. `anchor` is a moment on the day we're
  // planning; `dayStart`/`dayEnd` bound that whole day (for today, dayStart is
  // "now" so past crossings are excluded).
  const forTomorrow = now >= localTimeMs(now, rules.daytripRolloverHour)
  const anchor = forTomorrow ? now + 24 * 60 * 60_000 : now
  const dayStart = forTomorrow ? startOfNextLocalDay(now) : now
  const dayEnd = startOfNextLocalDay(anchor)
  const comfStart = localTimeMs(anchor, DAYTRIP_COMFORT_HOURS.start)
  const comfEnd = localTimeMs(anchor, DAYTRIP_COMFORT_HOURS.end)
  const extStart = localTimeMs(anchor, DAYTRIP_EXTENDED_HOURS.start)
  const extEnd = localTimeMs(anchor, DAYTRIP_EXTENDED_HOURS.end)
  const crossingMs = rules.crossingMinutes * 60_000
  // Two admin-set thresholds on island time:
  //   recommendedMs — at/above this it's a full daytrip.
  //   floorMs       — below this there's no worthwhile trip → "no daytrip".
  // Between the two it's a short trip (shown with an amber warning). The floor
  // is clamped to the recommended length so it can never exceed it.
  const recommendedMs = rules.minDaytripMinutes * 60_000
  const floorMs = Math.min(rules.absoluteMinDaytripMinutes, rules.minDaytripMinutes) * 60_000

  const nextWindowStart = windows.find((w) => w.start > dayStart)?.start ?? null
  const none = (): DayTripPlan => ({
    feasible: false,
    mode: 'none',
    comfort: 'comfortable',
    outbound: null,
    inbound: null,
    islandMs: 0,
    short: false,
    forTomorrow,
    nextWindowStart,
  })

  // Windows whose green (safe-to-start) period offers a crossing on the planned
  // day within extended daylight. Each supports at least a one-way crossing.
  const usable = windows
    .map((w) => ({
      w,
      b: bracketFor(w.start, w.deadline, dayStart, dayEnd, comfStart, comfEnd, extStart, extEnd),
    }))
    .filter((x) => x.b.extOk)

  if (usable.length === 0) return none()

  // Build every sensible plan, each with its usable island time, then choose.
  // Island time ≈ (time you can start heading back) − (arrival = first start +
  // one crossing). Only trips with some positive time are kept here; the
  // recommended/floor thresholds are applied when choosing below.
  const candidates: Candidate[] = []

  const addSingle = (b: Bracket): void => {
    const c = crossingFrom(b)
    const lo = c.earliest
    const hi = c.latest
    const islandMs = hi - lo - crossingMs
    if (islandMs <= 0) return
    candidates.push({
      feasible: true,
      mode: 'single-window',
      comfort: c.comfortable ? 'comfortable' : 'extended',
      outbound: { earliest: lo, latest: hi - crossingMs, comfortable: c.comfortable },
      inbound: { earliest: lo + crossingMs, latest: hi, comfortable: c.comfortable },
      islandMs,
      short: false,
      forTomorrow,
      nextWindowStart: null,
    })
  }

  const addTwo = (a: Bracket, b: Bracket): void => {
    const out = crossingFrom(a)
    const inn = crossingFrom(b)
    const islandMs = inn.latest - out.earliest - crossingMs
    if (islandMs <= 0) return
    candidates.push({
      feasible: true,
      mode: 'two-window',
      comfort: out.comfortable && inn.comfortable ? 'comfortable' : 'extended',
      outbound: out,
      inbound: inn,
      islandMs,
      short: false,
      forTomorrow,
      nextWindowStart: null,
    })
  }

  // A round trip inside each single window.
  for (const x of usable) addSingle(x.b)
  // Span the day: over in the first window, back in the last (road floods
  // between — you wait on the island). Also the first/last *comfortable*
  // windows, so a fully-comfortable pairing is on the table even when an
  // earlier/later window would otherwise drag the plan into amber.
  if (usable.length >= 2) addTwo(usable[0].b, usable[usable.length - 1].b)
  const comfortableWindows = usable.filter((x) => x.b.comfOk)
  if (comfortableWindows.length >= 2) {
    addTwo(comfortableWindows[0].b, comfortableWindows[comfortableWindows.length - 1].b)
  }

  // Prefer a comfortable (daylight) plan over an early/late amber one; among
  // equal comfort, prefer the one that leaves the most time on the island.
  const pickBest = (list: Candidate[]): Candidate =>
    [...list].sort((p, q) =>
      p.comfort !== q.comfort ? (p.comfort === 'comfortable' ? -1 : 1) : q.islandMs - p.islandMs,
    )[0]

  // Three states: a full daytrip (≥ recommended) wins outright; otherwise a
  // short trip (≥ floor) shown with a warning; otherwise nothing worth it.
  const full = candidates.filter((c) => c.islandMs >= recommendedMs)
  const shortTrips = candidates.filter((c) => c.islandMs >= floorMs && c.islandMs < recommendedMs)

  let best: Candidate | undefined
  let short = false
  if (full.length) best = pickBest(full)
  else if (shortTrips.length) {
    best = pickBest(shortTrips)
    short = true
  }
  if (!best) return none()

  return {
    feasible: true,
    mode: best.mode,
    comfort: best.comfort,
    outbound: best.outbound,
    inbound: best.inbound,
    islandMs: best.islandMs,
    short,
    forTomorrow,
    nextWindowStart: null,
  }
}

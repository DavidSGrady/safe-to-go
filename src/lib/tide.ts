import { startOfNextLocalDay } from './format'
import type {
  ConfidenceTier,
  CurvePoint,
  ForecastPoint,
  Prediction,
  Reading,
  SafeWindow,
  SafetyRules,
  StatusResult,
} from './types'

/** Observations older than this are considered stale. */
const FRESHNESS_MS = 45 * 60 * 1000
/** Resolution used when scanning the curve for threshold crossings. */
const STEP_MS = 5 * 60 * 1000
/** Fine resolution used when locating the low point inside a window. */
const FINE_STEP_MS = 2 * 60 * 1000
/** How far back we scan so a window already in progress is found correctly. */
const LOOKBACK_MS = 8 * 60 * 60 * 1000
/** Default forward horizon for the windows list. */
export const DEFAULT_HORIZON_HOURS = 48
/** Extended horizon when the user asks to see further ahead. */
export const EXTENDED_HORIZON_HOURS = 168
/** Surge offsets beyond this are treated as data errors and clamped. */
const MAX_SURGE_CM = 250

/** Confidence drops the further out a window starts — it leans more on forecast, less on measurement. */
const CONFIDENCE_BREAKS_MIN = { high: 12 * 60, medium: 26 * 60, low: 72 * 60 }

interface TidePoint {
  t: number
  level: number
}

/**
 * Build a function level(t) from DMI predictions.
 * Prefers the dense '10minutes' curve; falls back to cosine interpolation
 * between successive high/low extremes (the standard tidal curve shape).
 */
export function buildPredictionCurve(
  predictions: Prediction[],
): ((t: number) => number | null) | null {
  const dense: TidePoint[] = predictions
    .filter((p) => p.predictionType === '10minutes')
    .map((p) => ({ t: Date.parse(p.predictedAt), level: p.levelCm }))
    .sort((a, b) => a.t - b.t)

  if (dense.length >= 12) {
    return (t: number) => interpolateLinear(dense, t)
  }

  const extremes: TidePoint[] = predictions
    .filter((p) => p.predictionType === 'minimum' || p.predictionType === 'maximum')
    .map((p) => ({ t: Date.parse(p.predictedAt), level: p.levelCm }))
    .sort((a, b) => a.t - b.t)

  if (extremes.length >= 2) {
    return (t: number) => interpolateCosine(extremes, t)
  }

  return null
}

function interpolateLinear(points: TidePoint[], t: number): number | null {
  if (points.length === 0) return null
  if (t <= points[0].t || t >= points[points.length - 1].t) {
    return t === points[0].t
      ? points[0].level
      : t === points[points.length - 1].t
        ? points[points.length - 1].level
        : null
  }
  const i = findSegment(points, t)
  const a = points[i]
  const b = points[i + 1]
  const f = (t - a.t) / (b.t - a.t)
  return a.level + (b.level - a.level) * f
}

/** Cosine easing between tide extremes approximates the real tidal curve well. */
function interpolateCosine(extremes: TidePoint[], t: number): number | null {
  if (t < extremes[0].t || t > extremes[extremes.length - 1].t) return null
  const i = findSegment(extremes, t)
  const a = extremes[i]
  const b = extremes[Math.min(i + 1, extremes.length - 1)]
  if (a.t === b.t) return a.level
  const f = (t - a.t) / (b.t - a.t)
  const eased = (1 - Math.cos(Math.PI * f)) / 2
  return a.level + (b.level - a.level) * eased
}

function findSegment(points: TidePoint[], t: number): number {
  let lo = 0
  let hi = points.length - 2
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (points[mid].t <= t) lo = mid
    else hi = mid - 1
  }
  return lo
}

function confidenceFor(startAheadMin: number): ConfidenceTier {
  if (startAheadMin < CONFIDENCE_BREAKS_MIN.high) return 'high'
  if (startAheadMin < CONFIDENCE_BREAKS_MIN.medium) return 'medium'
  if (startAheadMin < CONFIDENCE_BREAKS_MIN.low) return 'low'
  return 'veryLow'
}

/**
 * Compute the full safety status from raw data.
 *
 * The forecast source is chosen by the admin's wind toggle:
 *   - windAdjustmentEnabled (default): DMI's per-station prognosis
 *     ('dmi_station' — the exact gauge-calibrated series dmi.dk shows; wind
 *     and air pressure included, used with NO adjustment so our numbers match
 *     dmi.dk 1:1). Where it's missing, the raw DKSS grid model fills in,
 *     shifted by a small constant datum offset so it lines up with the
 *     gauge's zero. Beyond both horizons (~5 days) the astronomical tide
 *     table takes over.
 *   - off: the plain astronomical tide table only.
 * Either way, the current status uses the live measured level.
 *
 * A "window" runs from where *falling* water drops to `cautionMaxCm − fallMarginCm`
 * (safe as soon as it's that low — it only gets lower) until *rising* water
 * floods the road at `cautionMaxCm`. The **deadline** (last safe departure)
 * is time-based on the rising side: it's set so the crossing finishes before
 * the rising water reaches `cautionMaxCm − floodMarginCm`, keeping the trip at
 * least `floodMarginCm` below flooding throughout. Before the deadline it's
 * safe to start; between the deadline and the flood the road is still passable
 * but there's no longer time to cross safely (amber); above `cautionMaxCm` it's
 * flooded (red).
 */
export function computeStatus(
  readings: Reading[],
  predictions: Prediction[],
  forecast: ForecastPoint[],
  rules: SafetyRules,
  now: number = Date.now(),
  horizonHours: number = DEFAULT_HORIZON_HOURS,
  realNow: number = now,
): StatusResult {
  const sortedReadings = [...readings]
    .map((r) => ({ t: Date.parse(r.observedAt), level: r.levelCm }))
    .filter((r) => Number.isFinite(r.t) && Number.isFinite(r.level))
    .sort((a, b) => a.t - b.t)

  const latest = sortedReadings.length
    ? sortedReadings[sortedReadings.length - 1]
    : null
  const dataFresh = latest !== null && now - latest.t <= FRESHNESS_MS

  // Astronomical tide table (no weather) — used when the wind toggle is off
  // and as a fallback beyond the DKSS horizon.
  const astro = buildPredictionCurve(predictions)

  // Weather-inclusive forecast, split by source into dense interpolable
  // curves: the gauge-calibrated station prognosis (primary), and the raw
  // DKSS grid model (fallback — everything that isn't 'dmi_station', which
  // also covers demo data and pre-migration rows).
  const toPoints = (pts: ForecastPoint[]): TidePoint[] =>
    pts
      .map((f) => ({ t: Date.parse(f.forecastAt), level: f.levelCm }))
      .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.level))
      .sort((a, b) => a.t - b.t)
  const stationPts = toPoints(forecast.filter((f) => f.source === 'dmi_station'))
  const dkssPts = toPoints(forecast.filter((f) => f.source !== 'dmi_station'))
  const stationFc =
    stationPts.length >= 2 ? (t: number) => interpolateLinear(stationPts, t) : null
  const dkss = dkssPts.length >= 2 ? (t: number) => interpolateLinear(dkssPts, t) : null

  // Datum alignment: shift DKSS so it matches the gauge's zero at "now".
  // DKSS already carries the weather, so this offset is small and constant
  // (datum + model bias), not a surge we are inventing. The station prognosis
  // is already calibrated to the gauge by DMI, so it gets NO shift — shifting
  // it would break the 1:1 match with dmi.dk.
  let dkssDatumCm = 0
  if (latest && dkss) {
    const d = dkss(latest.t) ?? dkssPts[0].level
    dkssDatumCm = clamp(latest.level - d, -MAX_SURGE_CM, MAX_SURGE_CM)
  }

  // Weather surge, for admin diagnostics only: how far the measured level is
  // from the astronomical tide right now.
  let surgeOffsetCm = 0
  if (latest && astro) {
    const a = astro(latest.t)
    if (a !== null) surgeOffsetCm = clamp(latest.level - a, -MAX_SURGE_CM, MAX_SURGE_CM)
  }

  const useStation = rules.windAdjustmentEnabled && stationFc !== null
  const useDkss = rules.windAdjustmentEnabled && dkss !== null
  const forecastSource: StatusResult['forecastSource'] = useStation
    ? 'station'
    : useDkss
      ? 'dkss'
      : astro
        ? 'astronomical'
        : 'none'

  const adjusted: ((t: number) => number | null) | null =
    forecastSource === 'none'
      ? null
      : (t: number): number | null => {
          if (useStation) {
            const s = stationFc!(t)
            if (s !== null) return s
          }
          if (useDkss) {
            const d = dkss!(t)
            if (d !== null) return d + dkssDatumCm
          }
          // Past the forecast horizon → fall back to the astronomical table.
          return astro ? astro(t) : null
        }
  const levelAt = adjusted ?? ((): number | null => null)

  // When simulating a future time (admin preview), `now` runs ahead of the
  // real clock — the "current level" is then the forecast at that time, not the
  // last real measurement (which would otherwise be shown next to a future
  // verdict).
  const previewing = now - realNow > 5 * 60 * 1000

  // Current level: a fresh observation when we're live, otherwise the forecast.
  let currentLevelCm: number | null = null
  if (!previewing && dataFresh && latest) currentLevelCm = latest.level
  else if (adjusted) currentLevelCm = adjusted(now)
  else if (latest) currentLevelCm = latest.level

  // Tide direction from the adjusted curve (fall back to recent observations).
  let rising: boolean | null = null
  if (adjusted) {
    const a = adjusted(now)
    const b = adjusted(now + 30 * 60 * 1000)
    if (a !== null && b !== null) rising = b > a
  }
  if (rising === null && sortedReadings.length >= 3) {
    const recent = sortedReadings.slice(-3)
    rising = recent[2].level > recent[0].level
  }

  const allWindows = adjusted
    ? findWindows(adjusted, rules, now, now + horizonHours * 3600_000)
    : []

  // The lookback scan can surface windows that already closed before "now"
  // (kept only so a window in progress is detected correctly) — drop those
  // from what's shown to the user.
  const currentWindow = allWindows.find((w) => w.start <= now && now < w.end) ?? null
  const windows = allWindows.filter((w) => w.end > now)

  // "Almost there" heads-up shows up to an hour before the next window opens.
  const APPROACH_LEAD_MS = 60 * 60 * 1000

  let state: StatusResult['state'] = 'unknown'
  if (currentLevelCm !== null) {
    // Hard floor: if the water shown right now is above the flood point, the
    // road is under water — never green, whatever the forecast window says.
    // (Strictly above, so a falling margin of 0 can treat the road level itself
    // as the safe-to-go threshold — the receding-tide behaviour the locals want.)
    const floodedNow = currentLevelCm > rules.cautionMaxCm
    const next = windows.find((w) => w.start > now)
    // "Almost" while falling: a window opens within the lead time, OR the
    // forecast already has us inside one but the live reading is still right at
    // the flood line (the boundary case) — either way it's imminent, not unsafe.
    const nearWindow =
      rising === false &&
      (currentWindow !== null ||
        (next !== undefined && next.start - now <= APPROACH_LEAD_MS))
    if (!floodedNow && currentWindow && now <= currentWindow.deadline) {
      state = 'safe'
    } else if (!floodedNow && currentWindow) {
      state = 'caution'
    } else if (nearWindow) {
      // Falling and a window opens soon — "almost, get ready, but wait".
      state = 'approaching'
    } else {
      state = 'unsafe'
    }
  }

  // Return-trip banner: the last window whose *deadline* is still ahead and
  // still falls today (a late-night window whose deadline slips past midnight
  // is a tomorrow departure, not a valid "return today" time).
  const dayEnd = startOfNextLocalDay(now)
  const lastDepartureToday =
    [...windows].reverse().find((w) => w.deadline > now && w.deadline < dayEnd) ?? null

  const curve = buildChartCurve(sortedReadings, adjusted, now)

  return {
    state,
    currentLevelCm: currentLevelCm === null ? null : Math.round(currentLevelCm),
    currentWindow,
    windows,
    lastDepartureToday,
    curve,
    surgeOffsetCm: Math.round(surgeOffsetCm),
    forecastSource,
    windAdjustmentEnabled: rules.windAdjustmentEnabled,
    lastObservedAt: latest ? latest.t : null,
    dataFresh,
    rising,
    levelAt,
  }
}

/**
 * The level below which the road counts as inside a crossing window at time
 * `t`, chosen by the local tide direction:
 *   - falling → `cautionMaxCm − fallMarginCm` (safety margin; water only drops)
 *   - rising  → `cautionMaxCm` (the flood point itself; the window stays open
 *               until the road actually floods — the *time* to reach the flood
 *               is what constrains a safe departure, handled via the deadline)
 * `prev` is the level one step earlier (null if unknown). Using a lower level
 * to open (falling) than to close (rising) gives built-in hysteresis.
 */
export function windowLimitAt(
  rules: SafetyRules,
  level: (t: number) => number | null,
  t: number,
  prev: number | null,
): number {
  const here = level(t)
  const next = level(t + STEP_MS)
  let rising: boolean
  if (here !== null && next !== null) rising = next > here
  else if (here !== null && prev !== null) rising = here > prev
  else rising = false
  return rising ? rules.cautionMaxCm : rules.cautionMaxCm - rules.fallMarginCm
}

/**
 * Scan the adjusted curve for crossing windows. A window runs from where
 * falling water drops to `cautionMaxCm − fallMarginCm` until rising water floods the road
 * at `cautionMaxCm`. Its **deadline** (last safe departure) is timed so the
 * crossing finishes before the rising water reaches `cautionMaxCm − floodMarginCm`
 * — i.e. it stays at least `floodMarginCm` below flooding for the whole trip.
 */
export function findWindows(
  level: (t: number) => number | null,
  rules: SafetyRules,
  now: number,
  to: number,
): SafeWindow[] {
  const from = now - LOOKBACK_MS
  const minWindowMs = rules.minWindowMinutes * 60 * 1000
  // `flooded` = the window closed because rising water hit the flood point
  // (a real flood time), vs. just running past the forecast horizon.
  const raw: Array<{ start: number; end: number; flooded: boolean }> = []

  let openStart: number | null = null
  let prev: number | null = null
  for (let t = from; t <= to; t += STEP_MS) {
    const v = level(t)
    const inWindow = v !== null && v <= windowLimitAt(rules, level, t, prev)
    if (inWindow && openStart === null) {
      openStart = t
    } else if (!inWindow && openStart !== null) {
      // A real flood time only when the level actually reached the flood point
      // here — not when the forecast data simply ran out (v === null).
      const flooded = v !== null && v >= rules.cautionMaxCm
      raw.push({ start: openStart, end: t, flooded })
      openStart = null
    }
    prev = v
  }
  if (openStart !== null) raw.push({ start: openStart, end: to, flooded: false })

  const crossingMs = rules.crossingMinutes * 60 * 1000
  const bufferMs = rules.bufferMinutes * 60 * 1000
  // The crossing must finish while the water is still this far below flooding.
  const target = rules.cautionMaxCm - rules.floodMarginCm

  return raw
    .filter((w) => w.end - w.start >= minWindowMs)
    .map((w) => {
      let minLevelCm = Infinity
      let lowAt = w.start
      for (let t = w.start; t <= w.end; t += FINE_STEP_MS) {
        const v = level(t)
        if (v !== null && v < minLevelCm) {
          minLevelCm = v
          lowAt = t
        }
      }
      // First moment on the rising limb the water reaches the safety target
      // (flood minus margin). Defaults to the window end if never reached
      // (water never floods this cycle → no time pressure).
      let targetAt = w.end
      for (let t = lowAt; t <= w.end; t += FINE_STEP_MS) {
        const v = level(t)
        if (v !== null && v >= target) {
          targetAt = t
          break
        }
      }
      const deadline = targetAt - crossingMs - bufferMs
      const startAheadMin = Math.max(0, (w.start - now) / 60000)
      return {
        start: w.start,
        end: w.end,
        floodsAt: w.flooded ? w.end : null,
        deadline,
        lowAt,
        minLevelCm: Math.round(minLevelCm),
        confidence: confidenceFor(startAheadMin),
      }
    })
}

/** Combined observed history + adjusted forecast, for the optional detail chart. */
function buildChartCurve(
  readings: TidePoint[],
  adjusted: ((t: number) => number | null) | null,
  now: number,
): CurvePoint[] {
  const curve: CurvePoint[] = []
  const historyFrom = now - 6 * 60 * 60 * 1000
  const forecastTo = now + 30 * 60 * 60 * 1000

  for (const r of readings) {
    if (r.t >= historyFrom && r.t <= now) {
      curve.push({ t: r.t, level: r.level, observed: true })
    }
  }
  if (adjusted) {
    for (let t = now; t <= forecastTo; t += 10 * 60 * 1000) {
      const v = adjusted(t)
      if (v !== null) curve.push({ t, level: v, observed: false })
    }
  }
  return curve
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

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
 * The forecast comes from two DMI sources, chosen by the admin's wind toggle:
 *   - windAdjustmentEnabled (default): DMI's DKSS storm-surge model, which
 *     already includes wind and air pressure. We do NOT add a surge of our
 *     own; the only adjustment is a small constant datum offset so DKSS lines
 *     up with the gauge's zero. Beyond the DKSS horizon (~5 days) it falls
 *     back to the astronomical tide table.
 *   - off: the plain astronomical tide table only.
 * Either way, the current status uses the live measured level.
 *
 * A "window" is a stretch where the level is at or below the passable limit
 * (the road is passable). That limit is *directional*: while the water is
 * falling we allow up to `safeMaxFallingCm`, but once it turns and starts
 * rising we hold to the stricter `safeMaxRisingCm` — rising water is about to
 * flood the road, so a window closes at a lower level than it opened at.
 * Within a window the **deadline** — window end minus the crossing time minus
 * a safety buffer — is the last moment it's safe to *start* crossing: after
 * the deadline the road is still dry, but there is no longer enough time to
 * reach the other side before it floods again.
 */
export function computeStatus(
  readings: Reading[],
  predictions: Prediction[],
  forecast: ForecastPoint[],
  rules: SafetyRules,
  now: number = Date.now(),
  horizonHours: number = DEFAULT_HORIZON_HOURS,
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

  // DKSS weather-inclusive forecast, as a dense interpolable curve.
  const dkssPts = forecast
    .map((f) => ({ t: Date.parse(f.forecastAt), level: f.levelCm }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.level))
    .sort((a, b) => a.t - b.t)
  const dkss = dkssPts.length >= 2 ? (t: number) => interpolateLinear(dkssPts, t) : null

  // Datum alignment: shift DKSS so it matches the gauge's zero at "now".
  // DKSS already carries the weather, so this offset is small and constant
  // (datum + model bias), not a surge we are inventing.
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

  const useDkss = rules.windAdjustmentEnabled && dkss !== null
  const forecastSource: StatusResult['forecastSource'] = useDkss
    ? 'dkss'
    : astro
      ? 'astronomical'
      : 'none'

  const adjusted: ((t: number) => number | null) | null =
    forecastSource === 'none'
      ? null
      : (t: number): number | null => {
          if (useDkss) {
            const d = dkss!(t)
            if (d !== null) return d + dkssDatumCm
            // Past the DKSS horizon → fall back to the astronomical table.
            return astro ? astro(t) : null
          }
          return astro ? astro(t) : null
        }
  const levelAt = adjusted ?? ((): number | null => null)

  // Current level: trust a fresh observation over the model.
  let currentLevelCm: number | null = null
  if (dataFresh && latest) currentLevelCm = latest.level
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

  let state: StatusResult['state'] = 'unknown'
  if (currentLevelCm !== null) {
    if (currentWindow) {
      state = now <= currentWindow.deadline ? 'safe' : 'caution'
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
 * The passable limit at time `t`, chosen by the local tide direction: the
 * stricter rising limit while the water is climbing, the more lenient falling
 * limit while it drops. `prev` is the level one step earlier (null if unknown).
 */
export function passableLimitAt(
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
  return rising ? rules.safeMaxRisingCm : rules.safeMaxFallingCm
}

/**
 * Scan the adjusted curve for stretches at or below the (directional) passable
 * limit, and derive the deadline, low point and confidence tier for each.
 */
export function findWindows(
  level: (t: number) => number | null,
  rules: SafetyRules,
  now: number,
  to: number,
): SafeWindow[] {
  const from = now - LOOKBACK_MS
  const minWindowMs = rules.minWindowMinutes * 60 * 1000
  const raw: Array<{ start: number; end: number }> = []

  let openStart: number | null = null
  let prev: number | null = null
  for (let t = from; t <= to; t += STEP_MS) {
    const v = level(t)
    const safe = v !== null && v <= passableLimitAt(rules, level, t, prev)
    if (safe && openStart === null) {
      openStart = t
    } else if (!safe && openStart !== null) {
      raw.push({ start: openStart, end: t })
      openStart = null
    }
    prev = v
  }
  if (openStart !== null) raw.push({ start: openStart, end: to })

  const crossingMs = rules.crossingMinutes * 60 * 1000
  const bufferMs = rules.bufferMinutes * 60 * 1000

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
      const deadline = w.end - crossingMs - bufferMs
      const startAheadMin = Math.max(0, (w.start - now) / 60000)
      return {
        start: w.start,
        end: w.end,
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

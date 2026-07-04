import { startOfNextLocalDay } from './format'
import type {
  ConfidenceTier,
  CurvePoint,
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
 * The astronomical prediction is corrected by the current storm-surge offset
 * (latest observation minus prediction at the same moment), because wind
 * setup in the Wadden Sea routinely shifts the real level tens of cm from
 * the astronomical tide.
 *
 * A "window" is a stretch where the level is at or below `safeMaxCm` (the
 * road is passable). Within it, the **deadline** — window end minus the
 * crossing time minus a safety buffer — is the last moment it's safe to
 * *start* crossing: after the deadline the road is still dry, but there
 * is no longer enough time to reach the other side before it floods again.
 */
export function computeStatus(
  readings: Reading[],
  predictions: Prediction[],
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

  const predict = buildPredictionCurve(predictions)

  // Storm-surge correction: observed minus predicted at observation time.
  let surgeOffsetCm = 0
  if (latest && predict) {
    const predictedAtObs = predict(latest.t)
    if (predictedAtObs !== null) {
      surgeOffsetCm = clamp(latest.level - predictedAtObs, -MAX_SURGE_CM, MAX_SURGE_CM)
    }
  }

  const adjusted = predict
    ? (t: number): number | null => {
        const v = predict(t)
        return v === null ? null : v + surgeOffsetCm
      }
    : null
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

  // Return-trip banner: the last window today whose deadline is still ahead.
  const dayEnd = startOfNextLocalDay(now)
  const lastDepartureToday =
    [...windows].reverse().find((w) => w.deadline > now && w.start < dayEnd) ?? null

  const curve = buildChartCurve(sortedReadings, adjusted, now)

  return {
    state,
    currentLevelCm: currentLevelCm === null ? null : Math.round(currentLevelCm),
    currentWindow,
    windows,
    lastDepartureToday,
    curve,
    surgeOffsetCm: Math.round(surgeOffsetCm),
    lastObservedAt: latest ? latest.t : null,
    dataFresh,
    rising,
    levelAt,
  }
}

/**
 * Scan the adjusted curve for stretches at or below `safeMaxCm`, and derive
 * the deadline, low point and confidence tier for each.
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
  for (let t = from; t <= to; t += STEP_MS) {
    const v = level(t)
    const safe = v !== null && v <= rules.safeMaxCm
    if (safe && openStart === null) {
      openStart = t
    } else if (!safe && openStart !== null) {
      raw.push({ start: openStart, end: t })
      openStart = null
    }
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

import type {
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
/** How far ahead we look for safe windows. */
const HORIZON_MS = 48 * 60 * 60 * 1000
/** Surge offsets beyond this are treated as data errors and clamped. */
const MAX_SURGE_CM = 250

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
    // Only trust the dense curve inside its own span
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

/**
 * Compute the full safety status from raw data.
 *
 * The astronomical prediction is corrected by the current storm-surge offset
 * (latest observation minus prediction at the same moment), because wind
 * setup in the Wadden Sea routinely shifts the real level tens of cm from
 * the astronomical tide.
 */
export function computeStatus(
  readings: Reading[],
  predictions: Prediction[],
  rules: SafetyRules,
  now: number = Date.now(),
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

  // Safe windows over the horizon, from the adjusted curve.
  const windows = adjusted
    ? findSafeWindows(adjusted, rules, now, now + HORIZON_MS)
    : []

  // Current state.
  let state: StatusResult['state'] = 'unknown'
  let safeUntil: number | null = null
  if (currentLevelCm !== null) {
    if (currentLevelCm > rules.cautionMaxCm) {
      state = 'unsafe'
    } else if (currentLevelCm > rules.safeMaxCm) {
      state = 'caution'
    } else {
      // Level is in the safe band — but only call it SAFE if we're inside a
      // margin-trimmed window; right at the edges the road may still be wet
      // or about to flood.
      const current = windows.find((w) => w.start <= now && now < w.end)
      if (current) {
        state = 'safe'
        safeUntil = current.end
      } else {
        state = 'caution'
      }
    }
  }

  const curve = buildChartCurve(sortedReadings, adjusted, now)

  return {
    state,
    currentLevelCm: currentLevelCm === null ? null : Math.round(currentLevelCm),
    safeUntil,
    windows,
    curve,
    surgeOffsetCm: Math.round(surgeOffsetCm),
    lastObservedAt: latest ? latest.t : null,
    dataFresh,
    rising,
  }
}

/**
 * Scan the adjusted curve for intervals where the level stays at or below
 * the safe threshold, trim the margin off both ends (water must have receded
 * before, and you must be off the causeway before it returns), and drop
 * windows shorter than the configured minimum.
 */
export function findSafeWindows(
  level: (t: number) => number | null,
  rules: SafetyRules,
  from: number,
  to: number,
): SafeWindow[] {
  const marginMs = rules.marginMinutes * 60 * 1000
  const minWindowMs = rules.minWindowMinutes * 60 * 1000
  const windows: SafeWindow[] = []

  let openStart: number | null = null
  let openedAtScanStart = false
  for (let t = from; t <= to; t += STEP_MS) {
    const v = level(t)
    const safe = v !== null && v <= rules.safeMaxCm
    if (safe && openStart === null) {
      openStart = t
      openedAtScanStart = t === from
    } else if (!safe && openStart !== null) {
      pushWindow(windows, openStart, t, openedAtScanStart, false, marginMs, minWindowMs)
      openStart = null
    }
  }
  if (openStart !== null) {
    pushWindow(windows, openStart, to, openedAtScanStart, true, marginMs, minWindowMs)
  }
  return windows
}

function pushWindow(
  windows: SafeWindow[],
  rawStart: number,
  rawEnd: number,
  openEndedStart: boolean,
  openEndedEnd: boolean,
  marginMs: number,
  minWindowMs: number,
): void {
  // Don't trim an edge that is only an artifact of the scan range: if the
  // window was already open when the scan began, its true start (with margin
  // already elapsed) lies in the past.
  const start = openEndedStart ? rawStart : rawStart + marginMs
  const end = openEndedEnd ? rawEnd : rawEnd - marginMs
  if (end - start >= minWindowMs) {
    windows.push({ start, end })
  }
}

/** Combined observed history + adjusted forecast, for the chart. */
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

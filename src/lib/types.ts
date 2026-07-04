/** A water-level observation from the DMI oceanObs `observation` collection. */
export interface Reading {
  /** ISO timestamp of the observation */
  observedAt: string
  /** Water level in cm relative to DVR90 */
  levelCm: number
}

/** An astronomical tide prediction from the DMI oceanObs `tidewater` collection. */
export interface Prediction {
  /** ISO timestamp the prediction applies to */
  predictedAt: string
  /** 'minimum' (low tide), 'maximum' (high tide) or '10minutes' (curve point) */
  predictionType: 'minimum' | 'maximum' | '10minutes'
  /** Predicted water level in cm relative to DVR90 */
  levelCm: number
}

/**
 * A point from DMI's DKSS storm-surge forecast (weather-inclusive water
 * level). This is the real "prognosis" — wind and air pressure are already
 * included by DMI's model, so we do not add any surge of our own.
 */
export interface ForecastPoint {
  /** ISO timestamp the forecast applies to */
  forecastAt: string
  /** Forecast water level in cm (aligned to the gauge datum at read time) */
  levelCm: number
}

/** Admin-configurable safety thresholds. */
export interface SafetyRules {
  /** Water level (cm DVR90) at or below which the road is passable */
  safeMaxCm: number
  /** Water level (cm DVR90) at which the road is fully flooded */
  cautionMaxCm: number
  /** Time it takes to cross the causeway in the worst case (minutes) */
  crossingMinutes: number
  /** Extra safety buffer beyond the crossing time (minutes) */
  bufferMinutes: number
  /** Windows shorter than this are not shown (minutes) — filters measurement noise */
  minWindowMinutes: number
  /**
   * When true, the current gap between the measured level and the
   * astronomical tide table (wind + air-pressure surge) is carried forward
   * and added to the forecast. When false, the forecast uses the plain
   * astronomical tide only.
   */
  windAdjustmentEnabled: boolean
  updatedAt?: string
}

export type SafetyState = 'safe' | 'caution' | 'unsafe' | 'unknown'

export type ConfidenceTier = 'high' | 'medium' | 'low' | 'veryLow'

export interface SafeWindow {
  /** ms epoch — level drops to/below safeMaxCm */
  start: number
  /** ms epoch — level rises back above safeMaxCm (road floods again) */
  end: number
  /**
   * ms epoch — the last moment it's safe to *start* crossing:
   * end minus crossing time minus safety buffer. Between start and deadline
   * is the "green" period; between deadline and end is "amber" (still
   * passable, but too late to safely begin).
   */
  deadline: number
  /** ms epoch of the lowest water level within the window */
  lowAt: number
  /** the lowest water level within the window (cm) */
  minLevelCm: number
  /** how far ahead of "now" this window starts, driving the confidence tier */
  confidence: ConfidenceTier
}

export interface CurvePoint {
  /** ms epoch */
  t: number
  /** water level cm */
  level: number
  /** true when this point comes from an actual observation */
  observed: boolean
}

export interface StatusResult {
  state: SafetyState
  /** Current water level in cm (observed if fresh, otherwise adjusted forecast) */
  currentLevelCm: number | null
  /** The window "now" falls inside (before or after its deadline), if any */
  currentWindow: SafeWindow | null
  /** Upcoming safe windows, soonest first (may include the current one) */
  windows: SafeWindow[]
  /** The last window whose deadline is still today (Danish local time), for the return-trip banner */
  lastDepartureToday: SafeWindow | null
  /** Combined observed + adjusted forecast curve for charting */
  curve: CurvePoint[]
  /**
   * Weather surge (cm): measured level minus the astronomical tide at the
   * same moment — how far wind/pressure is pushing the water off the tide
   * table. Diagnostic only; the forecast itself comes from DKSS.
   */
  surgeOffsetCm: number
  /** Which source the forecast/windows are built from */
  forecastSource: 'dkss' | 'astronomical' | 'none'
  /** Whether the DKSS (weather-inclusive) forecast is selected */
  windAdjustmentEnabled: boolean
  /** Timestamp of the newest observation (ms epoch) */
  lastObservedAt: number | null
  /** True when the newest observation is recent enough to trust */
  dataFresh: boolean
  /** True when the tide is currently rising */
  rising: boolean | null
  /** Sample the surge-adjusted forecast curve at an arbitrary future time (ms epoch); null outside its range */
  levelAt: (t: number) => number | null
}

export interface RuleChangeLogEntry {
  id: number
  changedAt: string
  changedByEmail: string | null
  oldValues: Record<string, unknown>
  newValues: Record<string, unknown>
}

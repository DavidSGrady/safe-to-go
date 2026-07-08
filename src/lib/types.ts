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
 * A weather-inclusive water-level forecast point. Two sources exist:
 * 'dmi_station' — DMI's per-station prognosis (the exact series dmi.dk
 * shows; gauge-calibrated, used as-is), and a DKSS collection id (e.g.
 * 'dkss_ws') — the raw storm-surge grid model, kept as fallback and aligned
 * to the gauge datum at read time.
 */
export interface ForecastPoint {
  /** ISO timestamp the forecast applies to */
  forecastAt: string
  /** Forecast water level in cm */
  levelCm: number
  /** 'dmi_station' or a DKSS collection id; absent in demo data */
  source?: string
  /** When DMI generated the run ('dmi_station') or when it was fetched (DKSS); null on old rows */
  generatedAt?: string | null
}

/** Admin-configurable safety thresholds. */
export interface SafetyRules {
  /**
   * Safety headroom (cm) below the flood point while the water is *rising*.
   * The last safe departure is timed so the crossing finishes before the
   * rising forecast reaches (cautionMaxCm − floodMarginCm).
   */
  floodMarginCm: number
  /**
   * Safety headroom (cm) below the flood point while the water is *falling*.
   * The road counts as safe once the falling level is at/below
   * (cautionMaxCm − fallMarginCm). No time pressure — it only gets lower.
   */
  fallMarginCm: number
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
  /** Show a "parts of the road may still be flooded / puddles" caution. */
  puddleWarningEnabled: boolean
  /**
   * How many cm below the flood point the puddle caution shows while the water
   * is *falling* (receding). The warning appears when a falling level is within
   * this band below cautionMaxCm.
   */
  puddleWarningRangeCm: number
  /**
   * How fast the "situation at the road" animation scrubs through the forecast
   * when Play is pressed, as a percentage of the base speed: 100 = full speed,
   * 50 = half, 33 = a third. Purely presentational — does not affect safety.
   */
  playbackSpeedPct: number
  /**
   * Which planning pane shows under the verdict:
   *   - 'daytrip' — the "Planning a daytrip?" there-and-back planner
   *   - 'return'  — the older "Heading back today?" last-departure banner
   *   - 'off'     — neither
   */
  dayTripMode: 'daytrip' | 'return' | 'off'
  /**
   * Recommended visit length (minutes on the island). At/above this the daytrip
   * planner shows a full (green) daytrip; between this and
   * `absoluteMinDaytripMinutes` it shows a short-trip amber warning.
   */
  minDaytripMinutes: number
  /**
   * Absolute minimum visit (minutes). Below this there's no worthwhile trip, so
   * the daytrip planner shows "no daytrip today" rather than a short trip.
   */
  absoluteMinDaytripMinutes: number
  /**
   * Local hour (0–23) after which the daytrip planner switches to planning for
   * tomorrow instead of today — by then it's too late to start a trip today.
   */
  daytripRolloverHour: number
  /** Row resolution (minutes) for the raw data / observations table page. */
  tableGranularityMinutes: number
  updatedAt?: string
}

export type SafetyState = 'safe' | 'caution' | 'approaching' | 'unsafe' | 'unknown'

export type ConfidenceTier = 'high' | 'medium' | 'low' | 'veryLow'

export interface SafeWindow {
  /** ms epoch — falling water drops to/below the falling passable limit */
  start: number
  /** ms epoch — rising water floods the road (reaches cautionMaxCm again) */
  end: number
  /**
   * ms epoch the rising water reaches the flood point (cautionMaxCm) — i.e.
   * "the water reaches the road". Equals `end` when the window closed by
   * flooding; null when the window never floods within the forecast horizon
   * (so there is no flood time to show). Surfaced to users so they can do the
   * head-math themselves (subtract crossing + their own buffer).
   */
  floodsAt: number | null
  /**
   * ms epoch — the last moment it's safe to *start* crossing: the water
   * reaches (cautionMaxCm − floodMarginCm) minus crossing time minus safety
   * buffer, so the crossing finishes with that margin below flooding. Between
   * start and deadline is the "green" period; between deadline and the flood
   * is "amber" (still passable, but too late to safely begin).
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
  /** Which source the forecast/windows are primarily built from:
   * 'station' = DMI's gauge-calibrated station prognosis (matches dmi.dk),
   * 'dkss' = raw DKSS grid model (fallback), 'astronomical' = tide table. */
  forecastSource: 'station' | 'dkss' | 'astronomical' | 'none'
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

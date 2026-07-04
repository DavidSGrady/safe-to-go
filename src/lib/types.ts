/** A water-level observation from the DMI oceanObs `observation` collection. */
export interface Reading {
  /** ISO timestamp of the observation */
  observedAt: string
  /** Water level in cm relative to DVR90 */
  levelCm: number
}

/** A tide prediction from the DMI oceanObs `tidewater` collection. */
export interface Prediction {
  /** ISO timestamp the prediction applies to */
  predictedAt: string
  /** 'minimum' (low tide), 'maximum' (high tide) or '10minutes' (curve point) */
  predictionType: 'minimum' | 'maximum' | '10minutes'
  /** Predicted water level in cm relative to DVR90 */
  levelCm: number
}

/** Admin-configurable safety thresholds. */
export interface SafetyRules {
  /** Water level (cm DVR90) at or below which crossing is considered safe */
  safeMaxCm: number
  /** Water level (cm DVR90) above which crossing is considered unsafe */
  cautionMaxCm: number
  /** Safety buffer applied to both ends of a safe window (minutes) */
  marginMinutes: number
  /** Windows shorter than this are not shown (minutes) */
  minWindowMinutes: number
  updatedAt?: string
}

export type SafetyState = 'safe' | 'caution' | 'unsafe' | 'unknown'

export interface SafeWindow {
  /** ms epoch */
  start: number
  /** ms epoch */
  end: number
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
  /** When the current safe period ends (ms epoch), if state === 'safe' */
  safeUntil: number | null
  /** Upcoming safe windows, soonest first (may include the current one) */
  windows: SafeWindow[]
  /** Combined observed + adjusted forecast curve for charting */
  curve: CurvePoint[]
  /** Storm-surge offset applied to the astronomical prediction (cm) */
  surgeOffsetCm: number
  /** Timestamp of the newest observation (ms epoch) */
  lastObservedAt: number | null
  /** True when the newest observation is recent enough to trust */
  dataFresh: boolean
  /** True when the tide is currently rising */
  rising: boolean | null
}

export interface RuleChangeLogEntry {
  id: number
  changedAt: string
  changedByEmail: string | null
  oldValues: Record<string, unknown>
  newValues: Record<string, unknown>
}

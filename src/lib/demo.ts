import type { ForecastPoint, Prediction, Reading, SafetyRules } from './types'

/**
 * Synthetic Wadden Sea tide for previewing the app without a backend.
 * Semidiurnal tide (M2, period 12.42 h) with ~160 cm range around DVR90,
 * plus a gentle wind-surge drift so observed ≠ predicted.
 */
const M2_MS = 12.42 * 60 * 60 * 1000
const AMPLITUDE_CM = 80

function astronomical(t: number): number {
  return AMPLITUDE_CM * Math.sin((2 * Math.PI * t) / M2_MS)
}

function surge(t: number): number {
  // Slow pseudo-random drift, deterministic so the demo is stable.
  return 18 * Math.sin((2 * Math.PI * t) / (37 * 60 * 60 * 1000) + 1.3)
}

export function demoReadings(now: number): Reading[] {
  const readings: Reading[] = []
  for (let t = now - 24 * 60 * 60 * 1000; t <= now; t += 10 * 60 * 1000) {
    readings.push({
      observedAt: new Date(t).toISOString(),
      levelCm: Math.round(astronomical(t) + surge(t)),
    })
  }
  return readings
}

export function demoPredictions(now: number): Prediction[] {
  const predictions: Prediction[] = []
  for (let t = now - 12 * 60 * 60 * 1000; t <= now + 8 * 24 * 60 * 60 * 1000; t += 10 * 60 * 1000) {
    predictions.push({
      predictedAt: new Date(t).toISOString(),
      predictionType: '10minutes',
      levelCm: Math.round(astronomical(t)),
    })
  }
  return predictions
}

/**
 * Stand-in for DMI's DKSS forecast: the astronomical tide plus the same
 * surge that shows up in the observations, so it behaves like a real
 * weather-inclusive forecast (distinct from the pure astronomical curve).
 */
export function demoForecast(now: number): ForecastPoint[] {
  const points: ForecastPoint[] = []
  for (let t = now - 2 * 60 * 60 * 1000; t <= now + 5 * 24 * 60 * 60 * 1000; t += 60 * 60 * 1000) {
    points.push({
      forecastAt: new Date(t).toISOString(),
      levelCm: Math.round(astronomical(t) + surge(t)),
    })
  }
  return points
}

export const demoRules: SafetyRules = {
  floodMarginCm: 5,
  fallMarginCm: 10,
  cautionMaxCm: 60,
  crossingMinutes: 30,
  bufferMinutes: 10,
  minWindowMinutes: 10,
  windAdjustmentEnabled: true,
  puddleWarningEnabled: true,
  puddleWarningRangeCm: 15,
  playbackSpeedPct: 100,
  dayTripMode: 'daytrip',
}

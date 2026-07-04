import type { Prediction, Reading, SafetyRules } from './types'

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
  for (let t = now - 12 * 60 * 60 * 1000; t <= now + 50 * 60 * 60 * 1000; t += 10 * 60 * 1000) {
    predictions.push({
      predictedAt: new Date(t).toISOString(),
      predictionType: '10minutes',
      levelCm: Math.round(astronomical(t)),
    })
  }
  return predictions
}

export const demoRules: SafetyRules = {
  safeMaxCm: 20,
  cautionMaxCm: 50,
  marginMinutes: 30,
  minWindowMinutes: 45,
}

/** Time/date formatting helpers. All output is in Danish local time —
 * the tide happens at Mandø, so the times shown must be Mandø's. */

const TZ = 'Europe/Copenhagen'

export function fmtTime(ms: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: TZ,
  }).format(ms)
}

export function fmtDateTime(ms: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: TZ,
  }).format(ms)
}

/** 'today' | 'tomorrow' | weekday name, in Danish local time. */
export function dayLabel(ms: number, nowMs: number, locale: string): 'today' | 'tomorrow' | string {
  const dayOf = (t: number) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: TZ, dateStyle: 'short' }).format(t)
  const target = dayOf(ms)
  if (target === dayOf(nowMs)) return 'today'
  if (target === dayOf(nowMs + 24 * 60 * 60 * 1000)) return 'tomorrow'
  return new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: TZ }).format(ms)
}

export function splitDuration(ms: number): { hours: number; minutes: number } {
  const totalMinutes = Math.max(0, Math.round(ms / 60000))
  return { hours: Math.floor(totalMinutes / 60), minutes: totalMinutes % 60 }
}

/** ms epoch of the next local midnight in Danish time (approximate across DST transitions). */
export function startOfNextLocalDay(nowMs: number): number {
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(nowMs)
    .split('-')
    .map(Number)

  const tzName = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    timeZoneName: 'shortOffset',
  })
    .formatToParts(nowMs)
    .find((p) => p.type === 'timeZoneName')?.value
  const match = /GMT([+-]\d+)(?::(\d+))?/.exec(tzName ?? 'GMT+1')
  const offsetHours = match ? Number(match[1]) : 1
  const offsetMinutes = offsetHours * 60 + Math.sign(offsetHours || 1) * (match?.[2] ? Number(match[2]) : 0)

  return Date.UTC(y, m - 1, d + 1, 0, 0, 0) - offsetMinutes * 60_000
}

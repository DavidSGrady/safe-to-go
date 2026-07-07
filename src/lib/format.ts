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

/** Danish-local calendar date (year, month, day) of an instant. */
function localYmd(ms: number): [number, number, number] {
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(ms)
    .split('-')
    .map(Number)
  return [y, m, d]
}

/** Danish-local UTC offset in minutes at the given instant (handles DST). */
function tzOffsetMinutes(ms: number): number {
  const tzName = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    timeZoneName: 'shortOffset',
  })
    .formatToParts(ms)
    .find((p) => p.type === 'timeZoneName')?.value
  const match = /GMT([+-]\d+)(?::(\d+))?/.exec(tzName ?? 'GMT+1')
  const offsetHours = match ? Number(match[1]) : 1
  return offsetHours * 60 + Math.sign(offsetHours || 1) * (match?.[2] ? Number(match[2]) : 0)
}

/** ms epoch of the next local midnight in Danish time (approximate across DST transitions). */
export function startOfNextLocalDay(nowMs: number): number {
  const [y, m, d] = localYmd(nowMs)
  return Date.UTC(y, m - 1, d + 1, 0, 0, 0) - tzOffsetMinutes(nowMs) * 60_000
}

/**
 * ms epoch of a given local wall-clock time (hour:minute, Danish time) on the
 * same calendar day as `refMs`. Uses the offset at `refMs`, so it's exact for
 * daytime hours (the only ones we ask for) and only ever off by an hour right
 * around a DST switch in the small hours.
 */
export function localTimeMs(refMs: number, hour: number, minute = 0): number {
  const [y, m, d] = localYmd(refMs)
  return Date.UTC(y, m - 1, d, hour, minute, 0) - tzOffsetMinutes(refMs) * 60_000
}

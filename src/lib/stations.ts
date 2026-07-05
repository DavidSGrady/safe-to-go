/**
 * Measuring stations the site can show. Both are valid crossing-relevant
 * gauges locals use; the safety thresholds are shared (v1). The `id` is the
 * DMI observation stationId, which is also how readings/predictions/forecast
 * rows are keyed in Postgres.
 */
export interface Station {
  id: string
  name: string
}

export const STATIONS: readonly Station[] = [
  { id: '9006701', name: 'Ribe Kammersluse' },
  { id: '9007101', name: 'Mandø' },
]

export const DEFAULT_STATION_ID = '9006701'

export function stationName(id: string): string {
  return STATIONS.find((s) => s.id === id)?.name ?? id
}

// Find DMI station IDs (no API key required).
//
// Usage:
//   npm run find-stations              (searches "ribe" and "mandø")
//   npm run find-stations -- esbjerg   (custom search)

const BASE = process.env.DMI_BASE_URL ?? 'https://dmigw.govcloud.dk/v2/oceanObs'
const API_KEY = process.env.DMI_API_KEY // optional

const queries = process.argv.slice(2).length ? process.argv.slice(2) : ['ribe', 'mandø', 'mando', 'vester vedsted']

async function list(collection) {
  let url = `${BASE}/collections/${collection}/items?limit=1000`
  if (API_KEY) url += `&api-key=${API_KEY}`
  const res = await fetch(url)
  if (!res.ok) {
    console.error(`${collection}: HTTP ${res.status} — ${(await res.text()).slice(0, 200)}`)
    return []
  }
  const json = await res.json()
  return (json.features ?? []).map((f) => f.properties)
}

const [stations, tideStations] = await Promise.all([
  list('station'),
  list('tidewaterstation'),
])

function show(label, rows) {
  console.log(`\n=== ${label} ===`)
  const matches = rows.filter((p) =>
    queries.some((q) => String(p.name ?? '').toLowerCase().includes(q.toLowerCase())),
  )
  if (!matches.length) {
    console.log('(no name matches — dumping every station so you can scan manually)')
    for (const p of rows) console.log(`${p.stationId}\t${p.name}\t${p.status ?? ''}`)
    return
  }
  for (const p of matches) {
    console.log(JSON.stringify({
      stationId: p.stationId,
      name: p.name,
      status: p.status,
      parameterId: p.parameterId,
    }, null, 2))
  }
}

show('Observation stations (use for DMI_STATION_ID_OBS)', stations)
show('Tidewater stations (use for DMI_STATION_ID_TIDE)', tideStations)

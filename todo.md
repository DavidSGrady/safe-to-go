# Ideas & backlog

Running list of features/ideas to build. Not prioritised unless noted.

## In progress
- **Surface flood-reach time** — show the time DMI's prognosis says the water
  reaches the road (`caution_max_cm`, ~60 cm) in the verdict pane and for each
  window, so people can do the head-math (subtract crossing + their own buffer)
  and see how we arrive at the recommendation. *(building now)*

## Agreed, queued
- **Station switch: Mandø ⇄ Ribe Kammersluse.** v1 = pure data-source swap with
  the *same* thresholds (both are valid crossing readings locals use). Checkbox
  selector, pick one or both; when both are on, comparison mode showing both,
  with the most-cautious of the two driving the single safety verdict (never
  under-warn). Smarter dual-logic later. DMI station IDs (verified via
  `find-stations`): observations `9006701` "Ribe Kammersluse I" (backup `9006703`),
  tide predictions `25343`. Ribe exposes the same measured level + DKSS prognosis
  as Mandø, so ingest all three the same way. Note: `fetchReadings` must start
  filtering by `station_id` *before* a second station is ingested, or the
  unfiltered query would mix both stations.

## Ideas (not yet scoped)
- **Prognosis drift warnings (high priority — build early).** On each DMI update,
  check whether the prognosis is trending *worse* (e.g. the estimated time the
  water reaches the road keeps moving earlier). If so, warn: "Prognosis may be
  unstable — consider adding extra buffer / leaving a bit earlier than planned."
  Also surface how the latest *measurements* have differed from the prognosis.
  Locals reportedly already do this by eye to sanity-check estimates. Needs us to
  retain prognosis history (snapshots per update) to compare against.

- **Subscribe to reminders (phone / Apple Watch).** Let someone on the island
  subscribe from their phone and get a reminder/notification when it's time to
  leave: flood-reach time − crossing − buffer − an optional personal reminder
  buffer. A live-updated "latest you should leave" note that adjusts as the
  prognosis updates. Logic not fully finalised yet. (Likely needs push
  notifications / PWA + a subscription backend.)

- **Location-aware time-to-leave.** So far everything is timed from the start of
  the causeway crossing. Expand to account for the user's current location: time
  to leave = crossing deadline − travel time from where they are now. Would need
  geolocation + a travel-time estimate to the causeway.

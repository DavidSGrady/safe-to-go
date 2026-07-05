# Ideas & backlog

Running list of features/ideas to build. Not prioritised unless noted.

## Shipped
- **Surface flood-reach time** — the time DMI's prognosis says the water reaches
  the road (`caution_max_cm`) now shows in the verdict pane and per window.
- **Station switch: Mandø ⇄ Ribe Kammersluse (v1).** Checkbox selector (one or
  both); one drives the whole page, both shows a comparison with the most-cautious
  driving the verdict. Shared thresholds. Ingests Ribe (obs `9006701`, tide `25343`)
  alongside Mandø. Future: per-station thresholds, smarter dual-station logic, a
  Ribe-specific DKSS grid point (currently sampled near the sluice; falls back to
  astronomical if the point is dry).

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

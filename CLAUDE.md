# CLAUDE.md — agent guide for **Safe to Go — Mandø**

Mobile-first site telling visitors whether it's safe to cross the Låningsvej
causeway to Mandø right now, for how long, and when the next window opens.
Data comes from DMI (measured water level + astronomical tide + DKSS storm-surge
forecast). See `README.md` for the product/deploy walkthrough; this file is the
fast path for working in the code.

## Stack
- **Frontend:** Vue 3 + `<script setup>` TS, Vite, Pinia, vue-router, vue-i18n.
- **Backend:** Supabase (Postgres + Auth + Edge Functions + cron). No custom server.
- **Hosting:** Vercel (frontend), Supabase (DB/functions).

## Commands
- `npm run dev` — local dev server (Vite).
- `npm run build` — `vue-tsc -b && vite build`. **Run this before shipping**; it typechecks + builds.
- `npm run typecheck` — `vue-tsc -b` only.
- `npm run find-stations` — re-discover DMI station IDs (keyless).
- No test runner / linter is configured. To sanity-check pure logic in `src/lib`
  (e.g. `tide.ts`), bundle it and run under node:
  `npx esbuild src/lib/tide.ts --bundle --format=esm --outfile=<scratch>/tide.mjs` then import it.

## Deploying to production
Two independent systems. **Do the DB migration first, then push git** (migrations
here are written to be backward-compatible so either order is safe, but keep this habit).

1. **Migrations → Supabase.** Project is already linked (`supabase/.temp/linked-project.json`,
   ref `eslsgbnrrpjrcqpupxhp`). The CLI is authenticated and works non-interactively.
   - Apply: `npx supabase db push --yes` (the `--yes` global flag skips the confirm prompt).
   - Check state: `npx supabase migration list --linked` and `npx supabase db push --dry-run`
     ("Remote database is up to date" = nothing pending). Each migration runs in a transaction.
   - `npx supabase db query` connects to the **local** DB by default (fails if none running) —
     don't rely on it to inspect prod.
2. **Frontend → Vercel.** Vercel auto-deploys on push to GitHub `main`
   (`origin` = `github.com/DavidSGrady/safe-to-go`). There is **no** separate deploy step —
   `git push origin main` IS the production deploy. `vercel.json` only sets SPA rewrites.
   - Prod env vars live in Vercel: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (anon key only).
   - **Verify a deploy shipped:** `/admin` shows a "Live build" footer with the commit SHA
     (links to the GitHub commit) + build time, baked in via Vite `define` in `vite.config.ts`
     (`__COMMIT_SHA__` from `VERCEL_GIT_COMMIT_SHA`, `__BUILD_TIME__`; typed in `src/build-info.d.ts`).

### Migration conventions & gotchas
- Files: `supabase/migrations/YYYYMMDD000000_name.sql`, applied in filename order.
- After **adding or dropping columns** on a table in the Realtime publication
  (`safety_rules` is one), refresh it or Realtime keeps a stale column list and errors:
  ```sql
  alter publication supabase_realtime drop table public.safety_rules;
  alter publication supabase_realtime add table public.safety_rules;
  ```
- The `safety_rules` audit trigger `public.log_rule_change()` hardcodes the column
  list in two `jsonb_build_object(...)` calls — update it whenever rules columns change.
- **Zero-downtime rule:** the live frontend and the DB roll out at different times.
  Don't drop/rename a column the currently-deployed frontend still SELECTs in the same
  migration that ships the new frontend — keep the old column (nullable, old checks dropped)
  and remove it in a later migration once all clients are on the new build. That's why
  `safe_max_cm` still exists as a vestigial column (see below).

## Architecture map
- `src/lib/tide.ts` — **the safety algorithm** (pure, no I/O). `computeStatus()` is the
  entry point; `findWindows()` scans the forecast curve for safe windows; `buildPredictionCurve()`
  interpolates DMI data. Everything downstream derives from its `StatusResult`.
- `src/lib/api.ts` — Supabase queries + demo-mode fallback. Maps snake_case DB rows ↔ camelCase types.
  `fetchReadings/fetchPredictions/fetchForecast` all take a `stationId` and filter by `station_id`.
- `src/lib/stations.ts` — the measuring stations (`STATIONS`: Mandø `9007101`, Ribe Kammersluse `9006701`).
  Both are valid crossing gauges; **thresholds are shared (v1)**. The `id` is the DMI observation
  stationId and the key for readings/predictions/forecast rows in Postgres.
- `src/lib/types.ts` — `SafetyRules`, `StatusResult`, `SafeWindow`, etc.
- `src/lib/demo.ts` — synthetic tide used when Supabase env vars are absent (**demo mode**).
- `src/stores/status.ts` — Pinia: polls/refreshes **all stations'** data (per-station maps),
  holds the effective `now`, and the selected station set (`selectedStationIds`, persisted in
  localStorage). `statusByStation` computes a `StatusResult` per station; `status` is the
  **primary** — the single selected one, or the most-cautious when several are selected (so we
  never under-warn), tracked by `primaryStationId`. `readings/predictions/forecast` are exposed as
  the primary station's series (used by the admin threshold preview). Also owns the **admin preview
  offset** (`previewOffsetMin` / `setPreviewOffset`): `now` is a computed `realNow + offset`, so
  overriding it time-travels the whole page.
- `src/stores/auth.ts` — Supabase auth; `isAdmin` = `profiles.role === 'admin'`.
- `src/pages/` — `HomePage` (public), `AdminPage` (threshold tuning, gated), `LoginPage`.
- `src/components/` — `StatusHero`/`StickyVerdict` (verdict), `RoadCrossSection` (road sim),
  `WindowsList`, `ReturnBanner`, `DiveDeeper`, `AdminPreviewBar`.
- `src/i18n/locales/*.json` — 7 locales (da, en, de, nl, fr, es, zh). `fallbackLocale: 'en'`.
  **When you add/rename a user-facing key, update `en` (fallback) + `da` (primary) at minimum;
  update all 7 for public-facing strings** so no `{placeholder}` renders raw in another locale.

## Data ingestion (edge function)
`supabase/functions/fetch-dmi-data/index.ts` runs on cron (~10 min). It ingests observations,
tide predictions and **two forecasts** for **each station in its `STATIONS` array**
(Mandø + Ribe Kammersluse), fault-isolated per station (one failing doesn't block the others):
- `source = 'dmi_station'` — DMI's per-station prognosis from www.dmi.dk's internal
  `NinJo2DmiDk/ninjo2dmidk?cmd=odj&stations=<tideId>&datatype=fcst` endpoint (keyless,
  undocumented, 10-min resolution, ~5 days). **The exact series dmi.dk shows** — gauge-calibrated,
  so `tide.ts` uses it as-is (no datum shift). Our numbers must match dmi.dk 1:1; regressions here
  are user-visible (see the /data page footer for provenance/debugging).
- `source = 'dkss_ws'` — raw DKSS grid model via the open forecastedr API. **Fallback only**: the
  grid cells near the stations dry out at low tide (clamp ≈ −20 cm), so it must never be primary.
`water_level_forecast` carries `station_id` (unique `station_id, source, forecast_at`) and
`generated_at` (model-run time for `dmi_station`, fetch time for DKSS).
Deploy with `npx supabase functions deploy fetch-dmi-data` (this CLI has no `functions invoke`;
trigger by waiting for cron or curling the function URL with the anon key). After a new station is
added, apply the migration + deploy the frontend *before* the edge function starts writing the new
station's rows (see the migration header).

## Domain model — safety thresholds (current)
`safety_rules` (single row, `id = 1`), tuned from `/admin`:
- `safe_max_rising_cm` / `safe_max_falling_cm` — **directional passable limits.** A window
  opens when *falling* water drops below the falling limit and closes when *rising* water
  climbs above the (stricter, lower) rising limit → more cautious while water rises.
  Enforced: `rising ≤ falling ≤ caution`. `passableLimitAt()` in `tide.ts` picks by direction.
- `caution_max_cm` — flood point (road fully under water).
- `crossing_minutes` + `buffer_minutes` — deadline = window end − crossing − buffer
  (last moment it's safe to *start* crossing).
- `min_window_minutes` — windows shorter than this are hidden.
- `wind_adjustment_enabled` — on = DKSS storm-surge forecast; off = plain astronomical tide.
- `safe_max_cm` — **vestigial**, kept nullable for backward-compat; not read/written by current
  code. Safe to drop in a future migration once no old frontend is live.

## Behavior gotchas
- **Admin preview bar** shows only when `auth.isAdmin` and never in demo mode; it appears on
  `HomePage` after auth resolves (async, so it pops in shortly after load). No URL/route for it.
- **Return banner** (`ReturnBanner` → `status.lastDepartureToday`): filter is on the window's
  **deadline** being today (before next local midnight), not its start — otherwise a late window
  whose deadline slips past midnight shows an after-midnight "return today" time.
- All times display in **Europe/Copenhagen** (`src/lib/format.ts`), regardless of locale.
- Verdict palette CSS vars (`--verdict-*`) in `src/assets/styles.css`; the road sim water reuses
  them (`--water-*-fill`) so it recolors green/amber/red by state.

# Safe to Go — Mandø

A mobile-first website that tells visitors whether it is safe to cross the
Låningsvej causeway to Mandø **right now**, for how long, and when the next
safe window opens — based on live water-level measurements and tide
predictions from DMI's open data API (no API key required).

- **Frontend:** Vue 3 + TypeScript + Vite + Pinia + vue-i18n (7 languages: da, en, de, nl, fr, es, zh)
- **Backend:** Supabase (Postgres, Auth, Edge Functions, cron) — no custom server
- **Data:** [DMI Oceanographic Observation & Tidewater API](https://www.dmi.dk/friedata/dokumentation/apis/oceanographic-observation-and-tidewater-api)

## Stations used (verified live)

| Purpose | Station | ID | Parameter |
|---|---|---|---|
| Water level (measured) | Mandø I | `9007101` | `sea_reg` (cm) |
| Water level (backup) | Mandø II | `9007102` | `sea_reg` (cm) |
| Tide predictions | Mandø | `25346` | 10-min curve + high/low |

These are baked in as defaults; override with Supabase secrets
(`DMI_STATION_ID_OBS`, `DMI_STATION_ID_TIDE`) if they ever change.
`npm run find-stations` re-discovers them (no key needed).

## How the safety algorithm works

1. A cron-scheduled edge function pulls **observations** (measured water level)
   and **tide predictions** (astronomical tide curve) from DMI every 10 minutes
   into Postgres.
2. The frontend computes a **surge offset** — the difference between the latest
   measurement and the astronomical prediction at the same moment. Westerly
   wind routinely pushes the Wadden Sea far above the tide table, so the whole
   forecast curve is shifted by this offset.
3. The adjusted curve is scanned 48 h ahead against the admin-configured
   thresholds:
   - **Safe (green):** level ≤ `safe_max_cm`, inside a window trimmed by
     `margin_minutes` at both ends
   - **Caution (amber):** between `safe_max_cm` and `caution_max_cm`, or safe
     but the water rises soon, or the data is stale
   - **Unsafe (red):** level > `caution_max_cm`
   - Windows shorter than `min_window_minutes` are hidden.
4. All four knobs live in the `safety_rules` table and are tuned from `/admin`
   with a live preview — no redeploy needed.

> ⚠️ The default thresholds (safe ≤ 20 cm, unsafe > 50 cm) are **placeholders**.
> Calibrate them with local authorities (Esbjerg Kommune / Vadehavscentret)
> before telling anyone the road is safe.

## Local development

```bash
npm install
npm run dev
```

Without a `.env.local` the app runs in **demo mode** with synthetic tide data.
Copy `.env.example` to `.env.local` and fill in your Supabase project to use
real data.

## Step-by-step deployment (see also the walkthrough in the project chat)

### 1. Create the Supabase project

1. Sign up at <https://supabase.com> → **New project** (region `eu-central-1`,
   free plan). Save the database password somewhere safe.
2. On your computer, in this project folder:

```bash
npx supabase login
npx supabase link --project-ref <YOUR_PROJECT_REF>
npx supabase db push
npx supabase functions deploy fetch-dmi-data
```

(`<YOUR_PROJECT_REF>` is the random string in your project's URL.)

### 2. Load data and schedule the fetch

Test the function once (Dashboard → **Edge Functions → fetch-dmi-data → Test**,
or curl it with the service_role key). You should see
`readingsUpserted`/`predictionsUpserted` counts.

Then schedule it: Dashboard → **Integrations → Cron** → new job → run the
`fetch-dmi-data` edge function on `*/10 * * * *`. (Alternative:
[`supabase/setup_cron.sql`](supabase/setup_cron.sql) in the SQL editor.)

### 3. Create admin users

1. Dashboard → **Authentication → Users → Add user** (email + password,
   auto-confirm on).
2. SQL editor:

```sql
update public.profiles set role = 'admin' where email = 'name@example.com';
```

Admins sign in at `/login` and tune thresholds at `/admin`.

### 4. Deploy the frontend (Vercel)

1. Push this repo to GitHub, then import it at <https://vercel.com/new>
   (framework preset **Vite**; `vercel.json` handles SPA rewrites).
2. Environment variables (Project → Settings → Environment Variables):
   - `VITE_SUPABASE_URL` = `https://<PROJECT_REF>.supabase.co`
   - `VITE_SUPABASE_ANON_KEY` = the **anon/public** key (never the service key)
3. Add a custom domain under **Settings → Domains**.

### 5. Verify end to end

- Public page shows a real status and the chart's "measured" line ends near "now".
- `/admin` → Data health shows a recent measurement marked OK.
- Change a threshold → the public page updates within seconds.

## Project layout

```
supabase/
  migrations/           schema: readings, predictions, safety_rules, profiles,
                        audit log, RLS policies, realtime publication
  functions/fetch-dmi-data/   cron-driven DMI ingestion + station discovery
  setup_cron.sql        pg_cron schedule (fill in project ref + service key)
scripts/find-stations.mjs     station-ID lookup against DMI (keyless)
src/
  lib/tide.ts           the safety algorithm (surge correction, window scan)
  lib/api.ts            Supabase queries (demo-mode fallback built in)
  stores/               Pinia: status polling + realtime, auth
  pages/                Home (public), Login, Admin
  components/           StatusHero, NextWindows, TideChart, TideExplainer, LangSwitcher
  i18n/locales/         da, en, de, nl, fr, es, zh
```

## Operational notes

- **Stale data degrades safely:** if the newest measurement is older than
  45 min, a green status is downgraded to amber and a warning is shown; with no
  data at all the page says "No live data — do not cross based on this page."
- **Units:** DMI's `sea_reg` values are cm relative to DVR90 (verified against
  live data). Cross-check the first day of `station_readings` against
  [dmi.dk/vandstand](https://www.dmi.dk/vandstand).
- **Legal:** the footer carries a multilingual disclaimer; this is guidance,
  not an official safety service.

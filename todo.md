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

- **Renamed to "Kør til Mandø" + basic SEO.** Brand strings (tab title, PWA
  manifest, push fallback, test push) say "Kør til Mandø"; the `<h1>` keeps its
  per-locale question in all 7 locales, deliberately. `<title>` is the
  search-facing phrasing `Kan man køre til Mandø nu? Vandstand på Låningsvejen`
  (52 chars, under Google's ~580px cut). Also: Danish-only description meta (was
  a bilingual mash), `og:`/`twitter:` tags so Messenger shares stop rendering a
  bare URL, `rel="canonical"`, `robots.txt`, `sitemap.xml`, and an initial
  `document.documentElement.lang` sync (`setLocale()` only synced on *change*, so
  a first load in English served English text tagged `lang="da"`).

## Ideas (not yet scoped)

- **Prognosis drift warnings (high priority — build early).** On each DMI update,
  check whether the prognosis is trending _worse_ (e.g. the estimated time the
  water reaches the road keeps moving earlier). If so, warn: "Prognosis may be
  unstable — consider adding extra buffer / leaving a bit earlier than planned."
  Also surface how the latest _measurements_ have differed from the prognosis.
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

- **SEO: prerender `/` (highest remaining lever).** The SPA ships an empty
  `<div id="app">` — nothing we actually say is in the HTML. The verdict only
  exists after JS boots *and* `/api/conditions` resolves. Google's renderer
  usually gets there, but it indexes slower, and Bing plus most social and LLM
  crawlers mostly don't. Fix: prerender `/` at build time so the Danish copy and
  headings are in `dist/index.html`. Interacts with the edge-cached read path —
  prerendered numbers would be build-time stale, so bake in the *copy and
  structure*, not live values.

- **SEO: mobile LCP / Core Web Vitals.** 508 kB JS (161 kB gzip, single chunk —
  Vite already warns) plus a render-blocking Google Fonts stylesheet in `<head>`,
  *then* a network round-trip for conditions before anything renders. This is a
  phone-in-the-car use case and CWV is a live ranking signal. Options:
  `manualChunks`, self-host the two IBM Plex faces to kill the third-party
  round-trip, or preload the conditions fetch.

- **SEO: verify `/robots.txt` and `/sitemap.xml` actually serve.** Static files in
  `dist/` root should beat `vercel.json`'s SPA rewrite, but this repo already had
  to carve `/api/` out of that catch-all, so confirm rather than assume:
  `curl -sI https://www.xn--krtilmand-l8ai.dk/robots.txt`. If HTML comes back, the
  rewrite needs the same exclusion treatment. Then submit the domain in Google
  Search Console (the sitemap is picked up from robots.txt automatically).

- **A real 1200×630 `og:image`.** Currently `og:image` is `/icon-512.png`, a
  square, so link previews render a small thumbnail. A proper banner upgrades
  Facebook/Messenger to a large card and lets `twitter:card` become
  `summary_large_image`.

- **Per-route canonical, when a second page goes public.** `rel="canonical"` in
  `index.html` is static, so it points *every* route at `/`. Correct only while
  `/` is the sole indexable route. When `/status` (HomePage) goes public: drop its
  `Disallow` from `robots.txt`, add it to `sitemap.xml`, and move the canonical to
  per-route runtime — otherwise Google discards it in favour of `/`.

- **Locale URLs + hreflang.** All 7 locales share one URL and switch at runtime,
  so only Danish is indexable. Fine as strategy (Danish is the money query), but
  `/en/`, `/de/` … with `hreflang` would open German and Dutch tourist search —
  Mandø's actual visitor mix. Needs routing + prerendering per locale, so it
  depends on the prerender item above.

- **Backlinks (non-code, probably the biggest real-world win).** For a niche this
  small, a few inbound links would outrank every meta tag: Mandø Fælleskab,
  VisitVadehavet/VisitRibe, Mandø Kro, the campground, Mandøbussen, Esbjerg
  Kommune's Mandø page (we already link out to the last two).

- **Small copy leftovers.** `manifest.webmanifest` `description` is still
  English-only. `short_name` is `Kør til Mandø` — 13 chars, and Android home
  screens truncate around 12, so it may render "Kør til Man…"; shorten to "Mandø"
  if that looks bad on a real device.

- **Structured data (JSON-LD) — low priority, mostly entity clarity.** Worth
  knowing before anyone sinks time into it: Google restricted `FAQPage` rich
  results to authoritative gov/health sites in 2023, so FAQ markup will *not*
  produce rich results here. A `WebSite`/`WebApplication` + `Place` graph helps
  entity understanding but won't visibly change the SERP.

// Vercel serverless function: the first-party, cookieless visit counter.
//
// Why this is a separate function from api/conditions.ts: that one is cached at
// Vercel's edge for 5 minutes, so it deliberately does NOT run per visitor --
// folding counting into it would either never fire (cache hit) or destroy the
// cache that keeps Supabase egress flat. The two also want opposite cache
// headers (no-store vs s-maxage=300) and opposite failure behaviour (conditions
// returns 502 so the client falls back to direct Supabase; this must return 204
// no matter what and never influence the page).
//
// PRIVACY CONTRACT. This function is the only place where the visitor's IP and
// user-agent exist. They are hashed together with VISIT_PEPPER and discarded on
// the next line; nothing but the resulting 64-hex digest crosses into Postgres,
// where a daily-rotating salt is mixed in and the result truncated to 64 bits.
// Neither value is logged, stored, or forwarded. See the migration header in
// supabase/migrations/20260919000000_visitor_counts.sql for the whole design.
//
// The path is /api/visit on purpose: "track", "collect", "analytics",
// "pageview" and "hit" all appear in EasyPrivacy path rules and would be
// blocked by default for a large share of visitors. Nothing is being
// circumvented -- the endpoint is first-party and stores nothing on the device.
//
// NOTE: api/*.ts is in no tsconfig (tsconfig.app.json covers src/** only), so
// `npm run build` does NOT typecheck this file. Check it by hand after edits:
//   npx esbuild api/visit.ts --bundle --platform=node --outfile=<scratch>/visit.mjs

import { createHash } from 'node:crypto'

const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY
/** Shared secret with the DB, so the public anon key alone cannot forge counts. */
const VISIT_TOKEN = process.env.VISIT_TOKEN ?? ''
/** Server-only hash pepper. Deliberately not stored in the database. */
const VISIT_PEPPER = process.env.VISIT_PEPPER ?? ''

/**
 * Routes worth counting. Must stay in step with COUNTED in src/lib/analytics.ts
 * and the _route clamp in visit_record. /admin and /login are not visitors, and
 * /display is the shop kiosk, which reloads itself every 12 hours.
 */
const COUNTED_ROUTES = new Set(['/', '/status'])

/** The 7 shipped locales; anything else is bucketed as 'other'. */
const LOCALES = new Set(['da', 'en', 'de', 'nl', 'fr', 'es', 'zh'])

/** How long we will wait for Postgres before giving up on a count. */
const RPC_TIMEOUT_MS = 2000

/**
 * Collapse the long tail of search/social hosts into stable buckets, so the
 * referrer breakdown stays readable and its row cap is never the binding limit.
 * Matched against the hostname with any leading "www." stripped.
 */
const REFERRER_BUCKETS: Array<[RegExp, string]> = [
  [/(^|\.)google\./, 'google'],
  [/(^|\.)bing\./, 'bing'],
  [/(^|\.)duckduckgo\./, 'duckduckgo'],
  [/(^|\.)ecosia\./, 'ecosia'],
  [/(^|\.)yahoo\./, 'yahoo'],
  [/(^|\.)(facebook|fb)\.|^l\.facebook|^lm\.facebook|^m\.facebook/, 'facebook'],
  [/(^|\.)messenger\./, 'facebook'],
  [/(^|\.)instagram\./, 'instagram'],
  [/(^|\.)(chatgpt\.com|chat\.openai\.com)$/, 'chatgpt'],
  [/(^|\.)claude\.ai$/, 'claude'],
  [/(^|\.)perplexity\./, 'perplexity'],
  [/(^|\.)t\.co$|(^|\.)x\.com$|(^|\.)twitter\./, 'twitter'],
  [/(^|\.)linkedin\./, 'linkedin'],
  [/(^|\.)reddit\./, 'reddit'],
]

// Second line of defence only: a crawler that does not execute JavaScript never
// reaches the beacon at all, so this mostly catches things curling the endpoint
// directly. Under-counting is the safe direction -- a slightly over-eager regex
// costs a few real visits, while an under-eager one silently inflates the
// numbers, which is the failure mode that makes analytics worthless.
const BOT_RE =
  /bot[/_ ;)\]]|bot$|spider|crawl|scrap(?:er|ing)|headless|phantomjs|puppeteer|playwright|selenium|webdriver|lighthouse|pagespeed|gtmetrix|pingdom|uptimerobot|statuscake|monitoring|curl\/|wget|python-(?:requests|urllib|httpx)|aiohttp|libwww-perl|java\/|okhttp|go-http-client|axios\/|node-fetch|guzzle|postman|insomnia|facebookexternalhit|whatsapp|telegram|discord|slack|twitterbot|linkedin|pinterest|redditbot|embedly|quora link preview|skypeuripreview|applebot|bingpreview|yandex|baiduspider|sogou|petal|ahrefs|semrush|mj12|dotbot|dataforseo|seznam|blexbot|screaming frog|archive\.org|ia_archiver|feedfetcher|feedly|gptbot|oai-searchbot|chatgpt-user|claudebot|claude-web|anthropic-ai|perplexitybot|ccbot|bytespider|amazonbot|googlebot|google-inspectiontool|adsbot|mediapartners/i

// CUBOT is a real Android phone brand, so "CUBOT KING KONG" trips the `bot `
// branch above. A whole phone brand is worth one carve-out.
const NOT_A_BOT_RE = /cubot/i

/**
 * Reduce document.referrer to a bucket or a bare hostname. Only the host is
 * ever kept -- never the path or query, which is where anything personal in a
 * referring URL would live. Same-origin referrers count as 'direct'.
 */
function normaliseReferrer(raw: unknown, selfHost: string): string {
  if (typeof raw !== 'string' || !raw) return 'direct'
  let host: string
  try {
    host = new URL(raw).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return 'direct'
  }
  if (!host) return 'direct'
  // Our own pages are not a referral source.
  if (selfHost && (host === selfHost.toLowerCase().replace(/^www\./, ''))) return 'direct'
  for (const [re, bucket] of REFERRER_BUCKETS) {
    if (re.test(host)) return bucket
  }
  return host.slice(0, 64)
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export default async function handler(req: any, res: any) {
  // First, always: this must never be cached at the edge or in a browser.
  res.setHeader('Cache-Control', 'no-store')

  if (req.method !== 'POST') {
    res.status(405).end()
    return
  }
  // Missing configuration is not an error the visitor should ever see.
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !VISIT_TOKEN) {
    res.status(204).end()
    return
  }

  try {
    const h = req.headers ?? {}
    const host = String(h['x-forwarded-host'] ?? h.host ?? '')
    const origin = String(h.origin ?? '')
    // Safari omits Origin on same-origin POSTs, so absent is fine; present and
    // foreign is not.
    if (origin && host && !origin.endsWith(host)) {
      res.status(204).end()
      return
    }

    const ua = String(h['user-agent'] ?? '')
    if (ua.length < 16) {
      res.status(204).end()
      return
    }
    if (BOT_RE.test(ua) && !NOT_A_BOT_RE.test(ua)) {
      res.status(204).end()
      return
    }

    const xff = String(h['x-forwarded-for'] ?? h['x-real-ip'] ?? '')
    const ip = xff.split(',')[0].trim()
    if (!ip) {
      res.status(204).end()
      return
    }

    // The one moment ip and ua exist together. Nothing below this line sees
    // either of them -- only `pre`, which is a one-way digest.
    const pre = createHash('sha256').update(`${VISIT_PEPPER}${ip}|${ua}`).digest('hex')

    const body =
      typeof req.body === 'string' ? JSON.parse(req.body) : ((req.body ?? {}) as any)

    const route = COUNTED_ROUTES.has(body?.p) ? String(body.p) : 'other'
    const locale = LOCALES.has(body?.l) ? String(body.l) : 'other'
    const rawCountry = String(h['x-vercel-ip-country'] ?? '')
    const country = /^[A-Z]{2}$/.test(rawCountry) ? rawCountry : 'ZZ'
    const referrer = normaliseReferrer(body?.r, host)

    // Bound how long a slow database can burn function duration. A dropped
    // count is always preferable to a hung request.
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), RPC_TIMEOUT_MS)
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/rpc/visit_record`, {
        method: 'POST',
        signal: ac.signal,
        headers: {
          apikey: SUPABASE_ANON_KEY as string,
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          _token: VISIT_TOKEN,
          _pre: pre,
          _route: route,
          _country: country,
          _referrer: referrer,
          _locale: locale,
        }),
      })
    } finally {
      clearTimeout(timer)
    }
  } catch (err) {
    // Counting must never break or slow the page, and a 5xx here would show up
    // red in Vercel's dashboard for something that does not matter. Log it and
    // report success anyway.
    console.error('visit failed:', err)
  }

  // Always 204, never a body: sendBeacon ignores the response entirely.
  res.status(204).end()
}

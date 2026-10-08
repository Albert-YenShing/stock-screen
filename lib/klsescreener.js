'use strict'

const cheerio = require('cheerio')

const BASE = 'https://www.klsescreener.com'
const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'application/json, text/javascript, */*; q=0.01',
  'X-Requested-With': 'XMLHttpRequest',
}

// What each UI period maps to upstream, and how the bars are spaced.
// Upstream `ytd` is broken (it returns the 10y series), so YTD is derived
// locally by trimming the daily 1y series to 1 January.
const PERIODS = {
  '1d':  { upstream: '1d',  grain: 'intraday' },
  '1w':  { upstream: '1w',  grain: 'day' },
  '1m':  { upstream: '1m',  grain: 'day' },
  '3m':  { upstream: '3m',  grain: 'day' },
  '6m':  { upstream: '6m',  grain: 'day' },
  'ytd': { upstream: '1y',  grain: 'day', trimToYearStart: true },
  '1y':  { upstream: '1y',  grain: 'day' },
  '5y':  { upstream: '5y',  grain: 'day' },
  '10y': { upstream: '10y', grain: 'week' },
  'max': { upstream: '30y', grain: 'month' },
}

const cache = new Map()

async function cached(key, ttlMs, produce) {
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < ttlMs) return hit.value
  const value = await produce()
  cache.set(key, { at: Date.now(), value })
  return value
}

async function fetchSeries(code, upstream) {
  const url = `${BASE}/v2/stocks/chart/${encodeURIComponent(code)}/${upstream}?ajax=1&selected=0`
  const res = await fetch(url, { headers: HEADERS })
  if (!res.ok) throw new Error(`klsescreener returned HTTP ${res.status}`)
  const data = await res.json()
  if (!data || !Array.isArray(data.ohlc)) throw new Error('unexpected payload from klsescreener')
  return data
}

// Timestamps are MYT wall-clock stamped as UTC, so reading them back as UTC
// gives the Malaysian clock face. Never convert zones here.
const utc = (ms) => new Date(ms)
const isoDate = (ms) => utc(ms).toISOString().slice(0, 10)
const hhmm = (ms) => utc(ms).toISOString().slice(11, 16)

function normalise(raw) {
  const volByTime = new Map()
  for (const v of raw.volume || []) {
    if (Array.isArray(v)) volByTime.set(v[0], v[1])
    else if (v && typeof v === 'object') volByTime.set(v.x, v.y)
  }

  return raw.ohlc
    .filter((r) => Array.isArray(r) && r.length >= 5 && r[4] != null)
    .map((r) => ({
      t: r[0],
      date: isoDate(r[0]),
      time: hhmm(r[0]),
      open: r[1],
      high: r[2],
      low: r[3],
      close: r[4],
      volume: volByTime.get(r[0]) ?? 0,
    }))
}

const events = (raw) =>
  [...(raw.dividends || []), ...(raw.capital_changes || [])]
    .filter((e) => e && e.x)
    .map((e) => ({
      t: e.x,
      date: isoDate(e.x),
      kind: e.title || '?',
      text: String(e.text || '').replace(/<[^>]+>/g, '').trim(),
    }))

async function getSeries(code, period = '1y') {
  const spec = PERIODS[period] || PERIODS['1y']
  const ttl = spec.grain === 'intraday' ? 60_000 : 900_000

  return cached(`series:${code}:${period}`, ttl, async () => {
    const raw = await fetchSeries(code, spec.upstream)
    let bars = normalise(raw)

    if (spec.trimToYearStart) {
      const jan1 = `${new Date().getUTCFullYear()}-01-01`
      bars = bars.filter((b) => b.date >= jan1)
    }

    return { period, grain: spec.grain, bars, events: events(raw) }
  })
}

/**
 * Derive a live quote from the 5-minute intraday feed, using the daily series
 * for the previous close and the 1-year series for the 52-week range.
 */
async function getQuote(code) {
  return cached(`quote:${code}`, 60_000, async () => {
    const [intraday, daily, year] = await Promise.all([
      getSeries(code, '1d'),
      getSeries(code, '1m'),
      getSeries(code, '1y').catch(() => ({ bars: [] })),
    ])

    if (!intraday.bars.length && !daily.bars.length) {
      throw Object.assign(new Error(`No price data for "${code}"`), { status: 404 })
    }

    // "Today" is whatever the newest session in the feed is — which keeps this
    // correct over weekends and holidays too.
    const session = intraday.bars.length
      ? intraday.bars[intraday.bars.length - 1].date
      : daily.bars[daily.bars.length - 1].date
    const todays = intraday.bars.filter((b) => b.date === session)

    const dayBar = daily.bars.find((b) => b.date === session)
    const prev = [...daily.bars].reverse().find((b) => b.date < session)

    const last = todays.length ? todays[todays.length - 1].close : dayBar?.close ?? null
    const prevClose = prev?.close ?? null
    const change = last != null && prevClose != null ? last - prevClose : null
    const y = year.bars || []

    return {
      last,
      prevClose,
      change,
      changePercent: change != null && prevClose ? (change / prevClose) * 100 : null,
      open: todays.length ? todays[0].open : dayBar?.open ?? null,
      high: todays.length ? Math.max(...todays.map((b) => b.high)) : dayBar?.high ?? null,
      low: todays.length ? Math.min(...todays.map((b) => b.low)) : dayBar?.low ?? null,
      volume: dayBar?.volume ?? todays.reduce((s, b) => s + b.volume, 0),
      session,
      asOf: todays.length ? todays[todays.length - 1].time : null,
      week52High: y.length ? Math.max(...y.map((b) => b.high)) : null,
      week52Low: y.length ? Math.min(...y.map((b) => b.low)) : null,
      retrievedAt: new Date().toISOString(),
    }
  })
}


/* ---------------- fundamentals ---------------- */

// The stock page is HTML, not the JSON the chart endpoint serves.
const PAGE_HEADERS = {
  'User-Agent': HEADERS['User-Agent'],
  Accept: 'text/html,application/xhtml+xml',
  'Accept-Language': 'en-US,en;q=0.9',
}

// "1,234.5" / "5.99%" -> 1234.5 / 5.99 ; "-" / "" -> null
function num(raw) {
  if (raw == null) return null
  const cleaned = String(raw).replace(/[,%\s]/g, '')
  if (!/^[-+]?\d*\.?\d+$/.test(cleaned)) return null
  return Number(cleaned)
}

// Market cap arrives pre-abbreviated: "127.2B" -> 127200000000
const MULTIPLIER = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 }
function scaled(raw) {
  const m = String(raw ?? '').trim().match(/^([-+]?[\d,.]+)\s*([kmbt])?$/i)
  if (!m) return null
  const n = num(m[1])
  if (n == null) return null
  return m[2] ? n * MULTIPLIER[m[2].toLowerCase()] : n
}

// "3,079,100 / 96,400" -> [3079100, 96400]
function pair(raw, sep = '/') {
  const parts = String(raw ?? '').split(sep)
  return parts.length === 2 ? [num(parts[0]), num(parts[1])] : [null, null]
}

/**
 * Trade snapshot and valuation ratios, scraped from the stock page — bid/ask
 * and the buy/sell volume split are not in the chart JSON.
 */
async function getFundamentals(code) {
  return cached(`fundamentals:${code}`, 60_000, async () => {
    const url = `${BASE}/v2/stocks/view/${encodeURIComponent(code)}`
    const res = await fetch(url, { headers: PAGE_HEADERS })
    if (!res.ok) throw new Error(`klsescreener returned HTTP ${res.status}`)

    const $ = cheerio.load(await res.text())

    // Key each row off its label text, never nth-child — the layout shifts.
    const f = {}
    $('table.stock_details tr').each((_, tr) => {
      const cells = $(tr).find('td')
      const label = cells.eq(0).text().trim()
      if (label) f[label] = cells.eq(1).text().replace(/\s+/g, ' ').trim()
    })

    if (!Object.keys(f).length) {
      throw Object.assign(new Error(`No stock details for "${code}"`), { status: 404 })
    }

    const [volumeBuy, volumeSell] = pair(f['Volume (B/S)'])
    const [bid, ask] = pair(f['Price Bid/Ask'])
    const [week52Low, week52High] = pair(f['52w'], /\s+-\s+/)

    return {
      high: num(f.High),
      low: num(f.Low),
      open: num(f.Open),
      volume: num(f.Volume),
      volumeBuy,
      volumeSell,
      bid,
      ask,
      week52Low,
      week52High,
      roe: num(f.ROE),
      pe: num(f['P/E']),
      eps: num(f.EPS),
      dps: num(f.DPS),
      dy: num(f.DY),
      nta: num(f.NTA),
      pb: num(f['P/B']),
      rps: num(f.RPS),
      psr: num(f.PSR),
      marketCap: scaled(f['Market Cap']),
      marketCapText: f['Market Cap'] || null,
      shares: num(f['Shares (mil)']),
      retrievedAt: new Date().toISOString(),
    }
  })
}

module.exports = { getSeries, getQuote, getFundamentals, PERIODS: Object.keys(PERIODS) }

'use strict'

const cheerio = require('cheerio')

const BASE = 'https://klse.i3investor.com'

// i3investor sits behind Cloudflare and returns 403 to header-less clients.
const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
}

async function fetchText(path) {
  const res = await fetch(BASE + path, { headers: HEADERS })
  if (!res.ok) throw new Error(`i3investor returned HTTP ${res.status} for ${path}`)
  return res.text()
}

// "8,578,200" -> 8578200 ; "" / "-" -> null
function num(raw) {
  if (raw == null) return null
  const cleaned = String(raw).replace(/[,\s]/g, '')
  if (!/^[-+]?\d*\.?\d+$/.test(cleaned)) return null
  return Number(cleaned)
}

const cache = new Map()

async function cached(key, ttlMs, produce) {
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < ttlMs) return hit.value
  const value = await produce()
  cache.set(key, { at: Date.now(), value })
  return value
}

async function getQuote(code) {
  return cached(`quote:${code}`, 60_000, async () => {
    const html = await fetchText(`/web/stock/overview/${encodeURIComponent(code)}`)
    const $ = cheerio.load(html)

    // <title>HEXTAR (5151) Overview - HEXTAR GLOBAL BERHAD | I3investor</title>
    const title = $('title').text()
    const m = title.match(/(.+?)\s*\(([\w]+)\)\s*Overview\s*-\s*(.+?)\s*\|/)
    if (!m) throw Object.assign(new Error(`No stock found for "${code}"`), { status: 404 })

    // Key the cells off their label text, never nth-child — the layout shifts.
    const fields = {}
    $('#stock-price-info > div').each((_, el) => {
      const p = $(el).find('p')
      const label = p.eq(0).text().trim()
      if (label) fields[label] = p.eq(1).text().trim()
    })

    // "-0.025 (3.65%)" — the site signs only the amount and colours the span,
    // so the percentage has to inherit its sign from the amount.
    const parts = (fields["Today's Change"] || '').match(/([-+]?[\d.]+)\s*\(([-+]?[\d.]+)%\)/)
    const change = parts ? num(parts[1]) : null
    let changePercent = parts ? num(parts[2]) : null
    if (change != null && changePercent != null && change < 0) {
      changePercent = -Math.abs(changePercent)
    }

    return {
      ticker: m[2],
      name: m[1],
      companyName: m[3],
      lastPrice: num(fields['Last Price']),
      change,
      changePercent,
      dayRange: fields["Day's Change"] || null,
      volume: num(fields['Trading Volume']),
      retrievedAt: new Date().toISOString(),
    }
  })
}

async function getHistory(code) {
  return cached(`history:${code}`, 600_000, async () => {
    const html = await fetchText(`/web/stock/historical-chart/${encodeURIComponent(code)}`)

    // The DataTable is hydrated from an inline `var dtdata = [[...]];` literal.
    const m = html.match(/var\s+dtdata\s*=\s*(\[[\s\S]*?\])\s*;/)
    if (!m) throw Object.assign(new Error(`No historical data for "${code}"`), { status: 404 })

    return JSON.parse(m[1])
      .map((r) => ({
        date: r[0],
        open: num(r[1]),
        high: num(r[2]),
        low: num(r[3]),
        close: num(r[4]),
        volume: num(r[6]),
      }))
      .filter((r) => r.date && r.close != null)
      .sort((a, b) => a.date.localeCompare(b.date))
  })
}

async function search(query) {
  if (!query || query.length < 2) return []
  return cached(`search:${query.toLowerCase()}`, 3_600_000, async () => {
    const raw = await fetchText(
      `/wapi/web/autocomplete/stocklistjson?q=${encodeURIComponent(query)}`
    )
    // The endpoint double-encodes: a JSON string containing a JSON array.
    let rows = JSON.parse(raw)
    if (typeof rows === 'string') rows = JSON.parse(rows)
    if (!Array.isArray(rows)) return []
    return rows.map((r) => ({ code: r[0], symbol: r[1], name: r[2] }))
  })
}

module.exports = { getQuote, getHistory, search }

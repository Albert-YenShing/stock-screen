'use strict'

const $ = (id) => document.getElementById(id)

const PERIODS = [
  ['1d', '1D'], ['1w', '1W'], ['1m', '1M'], ['3m', '3M'], ['6m', '6M'],
  ['ytd', 'YTD'], ['1y', '1Y'], ['5y', '5Y'], ['10y', '10Y'], ['max', 'MAX'],
]

const state = { code: null, period: '1y', quote: null, grain: 'day', tv: false }
let chart, candles

/* ---------------- theme ---------------- */

function readTheme() {
  try {
    const saved = localStorage.getItem('klse-theme')
    if (saved) return saved
  } catch { /* private mode */ }
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function applyTheme(mode) {
  document.documentElement.dataset.theme = mode
  try { localStorage.setItem('klse-theme', mode) } catch { /* ignore */ }
  if (chart) chart.applyOptions(chartTheme())
}

const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim()

// The CSS scales type by viewport width; the canvas axis has to follow it.
const axisFont = () =>
  state.tv ? Math.round(Math.min(32, Math.max(16, innerWidth / 145))) : 11

function chartTheme() {
  return {
    layout: { background: { color: 'transparent' }, textColor: cssVar('--text-3'), fontSize: axisFont() },
    grid: { vertLines: { color: cssVar('--grid') }, horzLines: { color: cssVar('--grid') } },
    rightPriceScale: { borderColor: cssVar('--line') },
    timeScale: { borderColor: cssVar('--line') },
    crosshair: {
      vertLine: { color: cssVar('--text-3'), width: 1, style: 2, labelBackgroundColor: cssVar('--text-2') },
      horzLine: { color: cssVar('--text-3'), width: 1, style: 2, labelBackgroundColor: cssVar('--text-2') },
    },
  }
}

/* ---------------- chart ---------------- */

// Upstream timestamps are Malaysian wall-clock stamped as UTC, so every label
// must be formatted with UTC getters or it drifts by the viewer's offset.
const pad = (n) => String(n).padStart(2, '0')
const clockOf = (sec) => {
  const d = new Date(sec * 1000)
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const dayOf = (sec) => {
  const d = new Date(sec * 1000)
  return `${d.getUTCDate()} ${MON[d.getUTCMonth()]}`
}

// Daily and coarser series use business-day times, which arrive as
// {year,month,day} (or an ISO string) rather than a number. Returning undefined
// for those makes the axis render the literal text "undefined".
// TickMarkType: 0 Year, 1 Month, 2 DayOfMonth, 3 Time, 4 TimeWithSeconds.
function tickLabel(t, tickType) {
  if (typeof t === 'number') return clockOf(t)

  const bd = typeof t === 'string'
    ? { year: +t.slice(0, 4), month: +t.slice(5, 7), day: +t.slice(8, 10) }
    : t
  if (!bd || !bd.year) return ''

  if (tickType === 0) return String(bd.year)
  if (tickType === 1) return `${MON[bd.month - 1]} ${String(bd.year).slice(2)}`
  return `${bd.day} ${MON[bd.month - 1]}`
}

function initChart() {
  const el = $('chart')

  chart = LightweightCharts.createChart(el, {
    width: el.clientWidth,
    height: el.clientHeight,
    ...chartTheme(),
    handleScale: { axisPressedMouseMove: { time: true, price: false } },
    localization: {
      timeFormatter: (t) => (typeof t === 'number' ? `${dayOf(t)} ${clockOf(t)}` : tickLabel(t, 2)),
    },
    timeScale: {
      ...chartTheme().timeScale,
      rightOffset: 3,
      tickMarkFormatter: tickLabel,
    },
  })

  candles = chart.addCandlestickSeries({
    priceLineVisible: true,
    lastValueVisible: true,
    // A proportional bottom scaleMargin expands the axis *below* the data, so a
    // 30-year view spanning 0.50 to 28.00 prints negative price labels. Own the
    // padding here instead, with the floor clamped at zero, and leave the
    // scale's own margins at zero so the axis range is exactly this range.
    autoscaleInfoProvider: (original) => {
      const res = original()
      if (!res || !res.priceRange) return res
      const { minValue, maxValue } = res.priceRange
      const span = maxValue - minValue || Math.max(maxValue, 1) * 0.1
      return {
        priceRange: {
          minValue: Math.max(0, minValue - span * 0.15),
          maxValue: maxValue + span * 0.08,
        },
      }
    },
  })
  chart.priceScale('right').applyOptions({ scaleMargins: { top: 0, bottom: 0 } })

  // Born inside a hidden card, so it starts at zero width — re-measure on reveal.
  new ResizeObserver(() => {
    if (!el.clientWidth) return
    chart.applyOptions({ width: el.clientWidth, height: el.clientHeight })
  }).observe(el)

  chart.subscribeCrosshairMove((param) => {
    const bar = param.seriesData?.get(candles)
    showLegend(bar || null)
  })
}

function seriesColors() {
  const up = cssVar('--up'), down = cssVar('--down')
  return {
    upColor: up, downColor: down,
    borderUpColor: up, borderDownColor: down,
    wickUpColor: up, wickDownColor: down,
  }
}

function drawChart(series) {
  state.grain = series.grain
  const intraday = series.grain === 'intraday'
  const decimals = decimalsFor(series.bars)

  candles.applyOptions({
    ...seriesColors(),
    priceFormat: { type: 'price', precision: decimals, minMove: Math.pow(10, -decimals) },
  })

  // Business-day strings for daily+ bars; epoch seconds for intraday.
  const key = (b) => (intraday ? Math.floor(b.t / 1000) : b.date)

  candles.setData(series.bars.map((b) => ({
    time: key(b), open: b.open, high: b.high, low: b.low, close: b.close,
  })))

  candles.setMarkers(markersFor(series, intraday))
  chart.applyOptions({ timeScale: { timeVisible: intraday, secondsVisible: false } })
  requestAnimationFrame(() => chart.timeScale().fitContent())
}

// Dividend / capital-change flags, snapped to a bar that actually exists.
function markersFor(series, intraday) {
  if (intraday || series.grain !== 'day' || !series.events.length) return []
  const dates = new Set(series.bars.map((b) => b.date))
  const first = series.bars[0]?.date
  const seen = new Set()

  return series.events
    .filter((e) => e.date >= first)
    .map((e) => {
      if (dates.has(e.date)) return e
      const after = series.bars.find((b) => b.date >= e.date)
      return after ? { ...e, date: after.date } : null
    })
    .filter((e) => e && !seen.has(e.date + e.kind) && seen.add(e.date + e.kind))
    .map((e) => ({
      time: e.date,
      position: 'belowBar',
      color: cssVar('--accent'),
      shape: 'circle',
      text: e.kind,
      size: 0.9,
    }))
}

function decimalsFor(bars) {
  let max = 2
  for (const b of bars.slice(-160)) {
    const s = String(b.close)
    const i = s.indexOf('.')
    if (i >= 0) max = Math.max(max, Math.min(4, s.length - i - 1))
  }
  return max
}

function showLegend(bar) {
  const el = $('legend')
  if (!bar) { el.hidden = true; return }
  const d = decimalsFor([{ close: bar.close }])
  const f = (v) => (v == null ? '—' : Number(v).toFixed(d))
  el.hidden = false
  el.innerHTML =
    `<span class="k">O<b>${f(bar.open)}</b></span>` +
    `<span class="k">H<b>${f(bar.high)}</b></span>` +
    `<span class="k">L<b>${f(bar.low)}</b></span>` +
    `<span class="k">C<b>${f(bar.close)}</b></span>`
}

/* ---------------- fundamentals ---------------- */

// Bursa trades in half sen, so a 0.290 bid can sit against a 0.295 ask. Take the
// widest precision in the set, or the ask silently rounds onto the bid.
const decimalsOf = (...vals) =>
  Math.min(4, Math.max(2, ...vals.map((v) => String(v ?? '').split('.')[1]?.length || 0)))

const dash = (v, fn) => (v == null ? '—' : fn(v))
const fixed = (v, d) => dash(v, (n) => Number(n).toFixed(d))

function renderFundamentals(f) {
  // Scraped separately from the prices, so it can fail on its own — leave the
  // placeholders standing rather than blanking the card.
  if (!f) return

  const d = decimalsOf(f.high, f.low, f.open, f.bid, f.ask, f.week52Low, f.week52High)
  const price = (v) => fixed(v, d)
  const set = (id, text) => { $(id).textContent = text }

  set('f-high', price(f.high))
  set('f-low', price(f.low))
  set('f-open', price(f.open))
  set('f-vol', compact(f.volume))
  set('f-volbs', `${compact(f.volumeBuy)} / ${compact(f.volumeSell)}`)
  set('f-bidask', `${price(f.bid)} / ${price(f.ask)}`)

  set('f-52w', f.week52Low == null || f.week52High == null
    ? '—'
    : `${price(f.week52Low)} – ${price(f.week52High)}`)
  set('f-roe', fixed(f.roe, 2))
  set('f-pe', fixed(f.pe, 2))
  set('f-eps', fixed(f.eps, 2))
  set('f-dps', fixed(f.dps, 2))
  set('f-dy', dash(f.dy, (n) => `${n.toFixed(2)}%`))

  set('f-nta', fixed(f.nta, 4))
  set('f-pb', fixed(f.pb, 2))
  set('f-rps', fixed(f.rps, 2))
  set('f-psr', fixed(f.psr, 2))
  set('f-mcap', f.marketCapText || compact(f.marketCap))
  set('f-shares', dash(f.shares, (n) =>
    n.toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 })))
}

/* ---------------- quote ---------------- */

const compact = (n) =>
  n == null ? '—' : Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 2 }).format(n)
const money = (n, d = 3) => (n == null ? '—' : Number(n).toFixed(d))

function renderQuote(profile, q) {
  const d = String(q.last ?? '').split('.')[1]?.length >= 3 ? 3 : 2

  for (const el of document.querySelectorAll('.skel')) el.classList.remove('skel', 'skel-lg')

  $('q-symbol').textContent = profile.symbol
  $('q-code').textContent = profile.code
  $('q-company').textContent = profile.companyName || '—'

  const lastEl = $('q-last')
  const next = money(q.last, d)
  if (lastEl.textContent && lastEl.textContent !== next) {
    lastEl.classList.remove('flash'); void lastEl.offsetWidth; lastEl.classList.add('flash')
  }
  lastEl.textContent = next

  const dir = q.change > 0 ? 'up' : q.change < 0 ? 'down' : 'flat'
  const sign = q.change > 0 ? '+' : ''
  $('q-change').className = `pill ${dir}`
  $('q-change').textContent =
    `${sign}${money(q.change, d)} (${sign}${(q.changePercent ?? 0).toFixed(2)}%)`
  $('q-asof').textContent = q.asOf ? `as of ${q.asOf} MYT` : ''

  // 52-week position bar
  const { week52Low: lo, week52High: hi, last } = q
  if (lo != null && hi != null && hi > lo && last != null) {
    const pct = Math.min(100, Math.max(0, ((last - lo) / (hi - lo)) * 100))
    $('r-fill').style.width = `${pct}%`
    $('r-dot').style.left = `${pct}%`
    $('r-pos').textContent = `${pct.toFixed(0)}% of range`
    $('r-low').textContent = money(lo, d)
    $('r-high').textContent = money(hi, d)
  }

  document.title = `${profile.symbol} ${next} · KLSE Viewer`
}

/* ---------------- loading ---------------- */

const veil = (on) => $('chart-veil').classList.toggle('on', on)

function fail(msg) {
  const s = $('status')
  s.hidden = false
  s.className = 'status error'
  s.textContent = msg
}

async function loadStock(code, period = state.period) {
  state.code = code
  state.period = period
  location.hash = `${code}/${period}`
  $('status').hidden = true
  veil(true)

  try {
    const res = await fetch(`/api/stock/${encodeURIComponent(code)}?period=${period}`)
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
    state.quote = data.quote
    renderQuote(data.profile, data.quote)
    renderFundamentals(data.fundamentals)
    drawChart(data.series)
    renderPeriods()
  } catch (err) {
    fail(`Could not load "${code}" — ${err.message}`)
  } finally {
    veil(false)
  }
}

async function loadPeriod(period) {
  if (!state.code || period === state.period) return
  state.period = period
  location.hash = `${state.code}/${period}`
  renderPeriods()
  veil(true)
  try {
    const res = await fetch(`/api/series/${encodeURIComponent(state.code)}?period=${period}`)
    const series = await res.json()
    if (!res.ok) throw new Error(series.error || `HTTP ${res.status}`)
    drawChart(series)
  } catch (err) {
    fail(`Could not load ${period.toUpperCase()} — ${err.message}`)
  } finally {
    veil(false)
  }
}

function renderPeriods() {
  $('periods').innerHTML = PERIODS.map(
    ([id, label]) =>
      `<button role="tab" data-p="${id}" aria-selected="${id === state.period}">${label}</button>`
  ).join('')
}

$('periods').addEventListener('click', (e) => {
  const b = e.target.closest('button')
  if (b) loadPeriod(b.dataset.p)
})

/* ---------------- search ---------------- */

const input = $('search')
const results = $('results')
let timer, active = -1, items = []

const closeResults = () => { results.hidden = true; active = -1 }

function pick(i) {
  if (!items[i]) return
  input.value = ''
  input.blur()
  closeResults()
  loadStock(items[i].code)
}

input.addEventListener('input', () => {
  clearTimeout(timer)
  const q = input.value.trim()
  if (q.length < 2) return closeResults()

  timer = setTimeout(async () => {
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`)
      items = res.ok ? await res.json() : []
    } catch { items = [] }
    if (!items.length) return closeResults()

    results.innerHTML = items.slice(0, 30).map((s, i) =>
      `<li role="option" data-i="${i}"><span class="sym">${s.symbol}</span>` +
      `<span class="code">${s.code}</span><span class="nm">${s.name}</span></li>`).join('')
    results.hidden = false
    active = -1
  }, 200)
})

input.addEventListener('keydown', (e) => {
  if (results.hidden) {
    if (e.key === 'Enter' && input.value.trim()) {
      const code = input.value.trim()
      input.value = ''
      loadStock(code)
    }
    return
  }
  const els = [...results.children]
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    active = (active + (e.key === 'ArrowDown' ? 1 : -1) + els.length) % els.length
    els.forEach((el, i) => el.setAttribute('aria-selected', i === active))
    els[active].scrollIntoView({ block: 'nearest' })
  } else if (e.key === 'Enter') {
    e.preventDefault(); pick(active >= 0 ? active : 0)
  } else if (e.key === 'Escape') {
    closeResults(); input.blur()
  }
})

results.addEventListener('mousedown', (e) => {
  const li = e.target.closest('li')
  if (li) { e.preventDefault(); pick(Number(li.dataset.i)) }
})

document.addEventListener('click', (e) => { if (!e.target.closest('.search')) closeResults() })

document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement !== input) { e.preventDefault(); input.focus() }
})

/* ---------------- chrome ---------------- */

$('theme').addEventListener('click', () =>
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'))

$('refresh').addEventListener('click', async (e) => {
  if (!state.code) return
  const btn = e.currentTarget
  btn.classList.add('busy')
  await loadStock(state.code, state.period)
  btn.classList.remove('busy')
})

addEventListener('hashchange', () => {
  const [code, period] = location.hash.slice(1).split('/')
  if (code && code !== state.code) loadStock(code, period || state.period)
})

/* ---------------- boot ---------------- */

// ?tv — a display-only view for a big screen. Kept in the query string so the
// #code/period hash keeps working untouched.
state.tv = new URLSearchParams(location.search).has('tv')
if (state.tv) document.documentElement.dataset.tv = '1'

applyTheme(readTheme())
initChart()
renderPeriods()

const [hashCode, hashPeriod] = location.hash.slice(1).split('/')
loadStock(hashCode || '1155', PERIODS.some(([p]) => p === hashPeriod) ? hashPeriod : '1y')

// Nobody is standing at a wall display to press refresh. Four hours between
// ticks, so the price on screen sits well behind the market for most of the day.
const TV_REFRESH_MS = 4 * 60 * 60 * 1000
if (state.tv) {
  setInterval(() => { if (state.code) loadStock(state.code, state.period) }, TV_REFRESH_MS)
}

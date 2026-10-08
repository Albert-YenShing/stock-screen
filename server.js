'use strict'

const path = require('path')
const express = require('express')
const ks = require('./lib/klsescreener')
const i3 = require('./lib/i3')

const app = express()
const PORT = process.env.PORT || 3000

app.use(express.static(path.join(__dirname, 'public')))

function handle(fn) {
  return async (req, res) => {
    try {
      res.json(await fn(req))
    } catch (err) {
      res.status(err.status || 502).json({ error: err.message })
    }
  }
}

// klsescreener has the prices; i3investor has the company names.
async function profile(code) {
  const matches = await i3.search(code).catch(() => [])
  const hit = matches.find((m) => m.code === code) || matches[0]
  return { code, symbol: hit?.symbol || code, companyName: hit?.name || '' }
}

const periodOf = (req) => (ks.PERIODS.includes(req.query.period) ? req.query.period : '1y')

app.get('/api/search', handle((req) => i3.search((req.query.q || '').trim())))
app.get('/api/series/:code', handle((req) => ks.getSeries(req.params.code, periodOf(req))))

app.get('/api/fundamentals/:code', handle((req) => ks.getFundamentals(req.params.code)))

app.get('/api/stock/:code', handle(async (req) => {
  const code = req.params.code
  // Fundamentals are scraped, so let them fail alone — the chart still works.
  const [prof, quote, series, fundamentals] = await Promise.all([
    profile(code),
    ks.getQuote(code),
    ks.getSeries(code, periodOf(req)),
    ks.getFundamentals(code).catch(() => null),
  ])
  return { profile: prof, quote, series, fundamentals }
}))

app.listen(PORT, () => console.log(`KLSE viewer running at http://localhost:${PORT}`))

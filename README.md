# KLSE Viewer

A local web app for Bursa Malaysia stock prices and charts.

```bash
npm install
npm start          # http://localhost:3000
```

Deep-link a stock and period with the hash: `http://localhost:3000/#5151/6m`

## Interface

* **Search** — by name or code, `/` to focus, arrows + Enter to pick
* **Periods** — 1D · 1W · 1M · 3M · 6M · YTD · 1Y · 5Y · 10Y · MAX
* **Chart** — candlesticks, OHLC legend on hover, dividend/capital-change
  flags on daily views
* **Stats** — trade snapshot, valuation and balance-sheet figures in three
  columns, plus a 52-week range bar showing where the current price sits
* **Theme** — light/dark, follows the system by default, remembered per browser
* **TV mode** — add `?tv` to the URL (`http://localhost:3000/?tv#1155/6m`) for a
  wall display: the chart takes the left ~62% at close to full height, the 18
  fields run down the right, and type is sized in `vw` so one rule set fits 1080p
  and 4K. The board is locked to a single screen so it never scrolls — the field
  rows share out whatever height the column has rather than overflowing it. The
  search bar stays, sized for the room, and is the first thing Tab lands on so a
  TV remote can reach it — type, then arrows and OK to pick. Brand, theme and
  refresh buttons are dropped. It reloads itself every 4 hours, long enough that
  the price on screen sits well behind the market for most of the session.

## Where the data comes from

| Source | Used for |
| --- | --- |
| `klsescreener.com/v2/stocks/chart/{code}/{period}?ajax=1` | all prices — JSON, no scraping |
| `klse.i3investor.com/wapi/web/autocomplete/stocklistjson?q=` | company names and search |
| `klsescreener.com/v2/stocks/view/{code}` | the stats table — ratios, bid/ask, buy/sell volume |

Two details that will bite anyone touching `lib/klsescreener.js`:

* **Timestamps are Malaysian wall-clock stamped as UTC.** Read them back as UTC
  to get the MYT clock face. Converting time zones puts you 8 hours out.
* **Upstream `ytd` is broken** — it returns the 10-year series. YTD is derived
  locally by trimming the daily 1-year series to 1 January.

Granularity by period: `1d` is 5-minute intraday; `1w`–`5y` are daily; `10y` is
weekly; `max` (30y) is monthly.

## API

| Endpoint | Returns |
| --- | --- |
| `GET /api/stock/:code?period=` | `{ profile, quote, series, fundamentals }` |
| `GET /api/series/:code?period=` | bars + corporate-action events |
| `GET /api/fundamentals/:code` | the stats table `{ high, low, open, volume, bid, ask, roe, pe, … }` |
| `GET /api/search?q=` | matching stocks |

The quote is derived: last price and today's OHLC from the intraday feed,
previous close from the daily series, 52-week range from the 1-year series.

Cached in memory — 60s for quotes, intraday and the stats table, 15 min for
longer series, 1 h for searches.

## Deploying to Render

`render.yaml` is a blueprint: create a new Blueprint instance in Render, point it
at this repo, and the build command, start command, Node version and region come
from the file. Nothing needs setting by hand, and `PORT` is injected by Render —
`server.js` already reads it.

Two things to expect on the free plan:

* **It sleeps.** A free service spins down after ~15 minutes idle and takes
  roughly a minute to wake. The TV board refreshes every 4 hours, so almost every
  refresh pays that cold start.
* **The scrapers run from a datacenter IP.** Both upstreams are fine with a home
  connection, but i3investor sits behind Cloudflare and KLSE Screener's chart
  endpoint is internal. Neither has agreed to be called from a cloud host, so
  requests may be throttled or blocked there even though they work locally.

## Known limits

* **Not real-time.** Roughly 4 minutes behind, since the newest 5-minute bar is
  still forming. Better than i3investor's fixed 15-minute delay, but not live.
  True real-time needs a paid feed.
* **The header and the chart can disagree by a tick.** The header shows the
  latest intraday close; the chart's last daily bar is a separate aggregate
  upstream and updates slightly later. Both are genuine — they are not forced
  to match.
* **Bid/ask and Volume (B/S) are only meaningful during trading.** Once the
  session closes, upstream starts returning inverted pairs — MAYBANK reads
  `11.360 / 9.680` against a 10.52 last price, and a bid above the ask is not a
  real quote. They are passed through exactly as the source gives them.
* **Scraping is fragile.** The chart JSON is an internal endpoint with no
  stability guarantee. The i3investor scraper this replaced broke exactly this
  way when the site was redesigned.
* Data belongs to KLSE Screener and i3investor. Personal use only.

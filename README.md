# 📈 Jib Jab Dashboard

A free, static, auto-refreshing dashboard showing **live Gold (GC=F)** and
**Nasdaq-100 (NQ=F)** futures pricing, configurable historical ranges, and a
technical **Buy / Hold / Sell** signal summary.

No backend, no API key, no build step — just three files you can host anywhere.

## Features

- **Live pricing** for Gold and Nasdaq-100 futures (near-real-time via Yahoo Finance).
- **Day-trading timeframes** — one-click **1m / 5m / 15m / 1h / 1D** charts, each
  with a sensible lookback (1m → ~1 day, 5m → 3 days, 15m → 5 days, 1h → ~1 month,
  1D → ~6 months). Defaults to the live **1-minute** view.
- **Resilient windowing** — Yahoo's intraday buckets can come back empty or
  sparse off-session, so the app fetches a richer range and trims client-side to
  the timeframe's window, so the chart is never nearly-empty early in a session.
- **Auto-refresh** every 30 seconds (toggleable) plus a manual refresh button.
- **Signal Summary** — a Buy/Hold/Sell read-out computed from:
  - Price vs. 20-period SMA
  - 20-SMA vs. 50-SMA cross (trend)
  - RSI (overbought / oversold)
  - Momentum over the selected window
- Responsive dark UI, works on mobile.

## Run locally

Just open `index.html` in a browser, or serve the folder:

```bash
python -m http.server 8000
# then visit http://localhost:8000
```

## Deploy for free

**GitHub Pages**
1. Push this repo to GitHub.
2. Settings → Pages → Source: `main` branch, `/root`.
3. Your site goes live at `https://<user>.github.io/<repo>/`.

**Netlify / Cloudflare Pages** — drag-and-drop the folder, or connect the repo.
No build command needed (it's plain static HTML/CSS/JS).

## How the data works

The browser can't call Yahoo Finance directly (CORS), so `app.js` routes the
request through a chain of public CORS proxies and falls back through them until
one succeeds. If all are rate-limited at once, the dashboard shows a notice and
retries on the next refresh. For heavy/production use, swap in your own proxy or
a keyed provider (Twelve Data, Alpha Vantage) in `fetchChart()`.

## ⚠️ Disclaimer

This is an **educational** technical read-out, **not financial advice**. The
Buy/Hold/Sell signal is a simple indicator score and can be wrong. Futures
trading carries substantial risk. Do your own research.

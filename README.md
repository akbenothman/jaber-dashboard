# 📈 Jib Jab Dashboard

A free, static, auto-refreshing day-trading dashboard for **Gold (GC=F)** and
**Nasdaq-100 (NQ=F)** futures: a TradingView-style candlestick chart with
zoom/pan, and an **ICT / CRT trade assistant** gated to your New York Open
killzone.

No backend, no API key, no build step — just static files you can host anywhere.

## Features

- **Live pricing** for Gold and Nasdaq-100 futures (near-real-time via Yahoo Finance).
- **TradingView-style candlestick chart** (TradingView's own open-source
  [Lightweight Charts](https://github.com/tradingview/lightweight-charts)):
  real candles, **scroll/pinch to zoom, drag to pan**, double-click to reset.
  Candle times are shown in **New York time**.
- **Day-trading timeframes** — one-click **1m / 5m / 15m / 1h / 1D**, each with a
  session-sized lookback. Defaults to the live **1-minute** view.
- **JadeCap Daily-Sweep Model** — an educational implementation of JadeCap's
  "one strategy for life." The engine:
  1. **Bias from the 1-hour chart** — finds the most recent confirmed
     **swing-failure pattern (SFP)**: price raids a 1H swing high/low and
     *closes back inside*. Sweep of a high → short bias; sweep of a low → long.
  2. **Refines entry on your chart timeframe** — an aligned fair-value gap or
     market-structure shift.
  3. **Stop** beyond the swept 1H wick; **target** the next opposing 1H liquidity.
  4. **Premium/discount** check for entry location.

  It outputs a **LONG / SHORT / WAIT** call with entry, stop, target and
  reward:risk, and **only green-lights a trade inside your NY Open killzone**
  (default **06:00–09:00 ET**, DST-aware, adjustable) when reward:risk ≥ 1:1 —
  JadeCap targets ~2R+. The swept 1H level, PDH/PDL and entry/stop/target are
  drawn on the chart.
- **Auto-refresh** every 30 seconds (toggleable) plus a manual refresh button,
  with a live killzone countdown.
- **Resilient data** — widening range fallback, multi-proxy chain with
  per-request timeouts, and a cached higher-timeframe context feed.
- Responsive dark UI, works on mobile.

> ⚠️ **Not financial advice.** The assistant reports probabilities from price
> structure, not certainties. No trading system is "accurate." Trade your own
> plan and manage risk.

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

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
- **One-glance Trade Signal** — a single **BUY / SELL / WAIT** call with a tight
  scalp plan (entry, stop, target, ~1.5R). It combines **six independent intraday
  strategies** and only fires when they agree (fewer, higher-quality entries):
  1. **EMA trend** (9/21 direction, 50 regime)
  2. **VWAP** position
  3. **RSI** momentum
  4. **MACD** histogram
  5. **Opening-range breakout** (first 15 min of the session)
  6. **JadeCap's 1H liquidity sweep** (swing-failure pattern)

  A trade is only green-lit when a clear majority agree **and** you're inside your
  NY Open window (default **06:00–09:00 ET**, DST-aware, adjustable). Confidence is
  shown as the vote count (e.g. "5/6 agree · STRONG"). VWAP and the entry/stop/
  target are drawn on the chart. Designed for quick in-and-out intraday scalps.
  The signal is the **hero at the top of the page**, and a **🔔 Alert me** toggle
  plays a sound + desktop notification the moment it flips to BUY/SELL in your
  window — so you don't have to stare at it.
- **Backtest** — the **⏱ Backtest** button runs the *exact same* ensemble
  walk-forward over recent history for the selected symbol/timeframe (no
  lookahead: each bar is scored on a trailing window, one position at a time,
  killzone only). Reports **trades, win rate, avg R, total R, profit factor and
  max drawdown**, with an equity curve. Simplified simulation (no fees/slippage,
  conservative intrabar fills, delayed/limited free data) — a sanity check, not a
  promise of live results.
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

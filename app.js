/* Jib Jab Dashboard — live Gold & Nasdaq futures with technical summary.
 * Data: Yahoo Finance chart API, fetched through CORS-proxy fallbacks so it
 * works from any static host (GitHub Pages / Netlify) with no API key.
 */

const SYMBOLS = {
  "GC=F": { name: "Gold Futures", unit: "$", decimals: 2 },
  "NQ=F": { name: "Nasdaq-100 Futures", unit: "", decimals: 2 },
};

const DAY = 86400000;

// Day-trading timeframes. Each button is a chart granularity plus how much
// history to show: baseRange seeds the fetch, lookbackMs trims it client-side.
const TIMEFRAMES = {
  "1m": { interval: "1m", baseRange: "5d", lookbackMs: 1 * DAY },
  "5m": { interval: "5m", baseRange: "5d", lookbackMs: 3 * DAY },
  "15m": { interval: "15m", baseRange: "5d", lookbackMs: 5 * DAY },
  "1h": { interval: "1h", baseRange: "1mo", lookbackMs: 22 * DAY },
  "1d": { interval: "1d", baseRange: "1y", lookbackMs: 186 * DAY },
};

const state = {
  symbol: "GC=F",
  tf: "1m",
  ...TIMEFRAMES["1m"], // spreads interval, baseRange, lookbackMs
  autoTimer: null,
};

// Yahoo limits how far back each interval can go — used to widen safely.
const INTERVAL_MAX_DAYS = { "1m": 7, "5m": 60, "15m": 60, "1h": 730, "1d": Infinity };
const RANGE_DAYS = { "1d": 1, "5d": 5, "1mo": 31, "3mo": 93, "6mo": 186, "1y": 366, "2y": 731 };
// Widening ladder: Yahoo's own "1d"/"5d" buckets can be empty off-session, so
// we request progressively larger ranges until one returns data, then trim.
const RANGE_LADDER = ["1d", "5d", "1mo", "3mo", "6mo", "1y", "2y"];

const intervalValid = (range, interval) => INTERVAL_MAX_DAYS[interval] >= RANGE_DAYS[range];

// Candidate fetch ranges: the timeframe's base range and every larger range
// still valid for that interval (so an empty bucket can fall through).
function candidateRanges(baseRange, interval) {
  const start = RANGE_LADDER.indexOf(baseRange);
  return RANGE_LADDER.slice(start === -1 ? 0 : start).filter((r) => intervalValid(r, interval));
}

let chart = null;

/* ---------- Data fetching ---------- */

// Yahoo blocks direct browser calls (CORS). We try a chain of public proxies.
function proxied(url) {
  return [
    `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
    `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
    `https://thingproxy.freeboard.io/fetch/${url}`,
    url, // last resort: direct (works in some environments)
  ];
}

async function fetchChart(symbol, period, interval) {
  for (const range of candidateRanges(period, interval)) {
    const base = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
      symbol
    )}?range=${range}&interval=${interval}&includePrePost=true`;
    for (const url of proxied(base)) {
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) continue;
        const json = await res.json();
        const result = json?.chart?.result?.[0];
        if (result?.timestamp?.length) return result; // populated bucket found
      } catch (_) {
        /* try next proxy */
      }
    }
  }
  throw new Error("All data sources unavailable");
}

// Keep only points within the timeframe's lookback, measured from the last
// available point (so an off-session market still shows a full window).
function trimToPeriod(series, lookbackMs) {
  if (!lookbackMs || series.length < 2) return series;
  const cutoff = series[series.length - 1].t - lookbackMs;
  const trimmed = series.filter((d) => d.t >= cutoff);
  return trimmed.length >= 2 ? trimmed : series;
}

function parseSeries(result) {
  const ts = result.timestamp;
  const q = result.indicators.quote[0];
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    const close = q.close[i];
    if (close == null) continue;
    out.push({
      t: ts[i] * 1000,
      o: q.open[i],
      h: q.high[i],
      l: q.low[i],
      c: close,
      v: q.volume[i],
    });
  }
  return out;
}

/* ---------- Indicators ---------- */

function sma(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function rsi(values, period = 14) {
  if (values.length < period + 1) return null;
  let gains = 0,
    losses = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/* ---------- Summary / signal engine ---------- */

function buildSummary(series) {
  const closes = series.map((d) => d.c);
  const last = closes[closes.length - 1];
  const first = series[0].c;
  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);
  const r = rsi(closes);
  const rangePct = ((last - first) / first) * 100;

  const signals = [];
  let score = 0;

  // 1. Trend vs SMA20
  if (sma20 != null) {
    if (last > sma20) {
      signals.push(["bull", "Price above 20-period average", `+${(((last - sma20) / sma20) * 100).toFixed(2)}%`]);
      score += 1;
    } else {
      signals.push(["bear", "Price below 20-period average", `${(((last - sma20) / sma20) * 100).toFixed(2)}%`]);
      score -= 1;
    }
  }

  // 2. SMA cross (20 vs 50)
  if (sma20 != null && sma50 != null) {
    if (sma20 > sma50) {
      signals.push(["bull", "Short-term avg above long-term (golden lean)", "20>50"]);
      score += 1;
    } else {
      signals.push(["bear", "Short-term avg below long-term (death lean)", "20<50"]);
      score -= 1;
    }
  }

  // 3. RSI
  if (r != null) {
    if (r > 70) {
      signals.push(["bear", "RSI overbought — pullback risk", r.toFixed(0)]);
      score -= 1;
    } else if (r < 30) {
      signals.push(["bull", "RSI oversold — bounce potential", r.toFixed(0)]);
      score += 1;
    } else {
      signals.push(["neutral", "RSI in neutral zone", r.toFixed(0)]);
    }
  }

  // 4. Momentum over the selected window
  if (rangePct > 1) {
    signals.push(["bull", "Positive momentum over window", `+${rangePct.toFixed(2)}%`]);
    score += 1;
  } else if (rangePct < -1) {
    signals.push(["bear", "Negative momentum over window", `${rangePct.toFixed(2)}%`]);
    score -= 1;
  } else {
    signals.push(["neutral", "Flat / range-bound over window", `${rangePct.toFixed(2)}%`]);
  }

  let verdict, text;
  if (score >= 2) {
    verdict = "buy";
    text = `Indicators lean bullish (score +${score}). Trend and momentum favor accumulation, but confirm on your own timeframe before adding risk.`;
  } else if (score <= -2) {
    verdict = "sell";
    text = `Indicators lean bearish (score ${score}). Trend and momentum suggest caution or trimming exposure. Watch for a reversal signal before re-entering.`;
  } else {
    verdict = "hold";
    text = `Mixed signals (score ${score >= 0 ? "+" : ""}${score}). No decisive edge — holding and waiting for a cleaner setup is reasonable.`;
  }

  return { verdict, text, signals, sma20, sma50, rsi: r };
}

/* ---------- Rendering ---------- */

const $ = (id) => document.getElementById(id);
const fmt = (n, d = 2) =>
  n == null ? "—" : n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });

function renderPrice(series, meta, result) {
  const info = SYMBOLS[state.symbol];
  const last = series[series.length - 1].c;
  const prevClose = result.meta?.chartPreviousClose ?? series[0].c;
  const change = last - prevClose;
  const changePct = (change / prevClose) * 100;
  const up = change >= 0;

  $("symName").textContent = info.name;
  $("symCode").textContent = state.symbol;
  $("price").textContent = info.unit + fmt(last, info.decimals);
  const chgEl = $("change");
  chgEl.textContent = `${up ? "▲" : "▼"} ${fmt(Math.abs(change), info.decimals)} (${up ? "+" : ""}${changePct.toFixed(2)}%)`;
  chgEl.className = "change " + (up ? "up" : "down");

  const highs = series.map((d) => d.h).filter((x) => x != null);
  const lows = series.map((d) => d.l).filter((x) => x != null);
  const vols = series.map((d) => d.v).filter((x) => x != null);
  const stats = [
    ["Open", info.unit + fmt(series[0].o ?? series[0].c, info.decimals)],
    ["High", info.unit + fmt(Math.max(...highs), info.decimals)],
    ["Low", info.unit + fmt(Math.min(...lows), info.decimals)],
    ["Prev Close", info.unit + fmt(prevClose, info.decimals)],
    ["Points", String(series.length)],
    ["Avg Vol", vols.length ? fmt(vols.reduce((a, b) => a + b, 0) / vols.length, 0) : "—"],
  ];
  $("statGrid").innerHTML = stats
    .map(([l, v]) => `<div class="stat"><div class="label">${l}</div><div class="value">${v}</div></div>`)
    .join("");

  // Market state
  const st = result.meta?.marketState || "";
  const stEl = $("marketState");
  if (/REGULAR/.test(st)) {
    stEl.textContent = "Market Open";
    stEl.className = "pill pill-open";
  } else if (st) {
    stEl.textContent = st.replace(/PRE|POST|CLOSED|PREPRE|POSTPOST/g, (m) => ({ PRE: "Pre-Market", POST: "After Hours", CLOSED: "Closed", PREPRE: "Closed", POSTPOST: "Closed" }[m] || m));
    stEl.className = "pill " + (/CLOSED|PRE|POST/.test(st) ? "pill-closed" : "pill-muted");
  }
}

function renderChart(series, summary) {
  const info = SYMBOLS[state.symbol];
  const intraday = /m|h/.test(state.interval);
  const labels = series.map((d) =>
    new Date(d.t).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: intraday ? "numeric" : undefined,
      minute: intraday ? "2-digit" : undefined,
    })
  );
  const closes = series.map((d) => d.c);
  const up = closes[closes.length - 1] >= closes[0];
  const color = up ? "#22c55e" : "#ef4444";

  const ctx = $("chart").getContext("2d");
  const grad = ctx.createLinearGradient(0, 0, 0, 260);
  grad.addColorStop(0, up ? "rgba(34,197,94,0.28)" : "rgba(239,68,68,0.28)");
  grad.addColorStop(1, "rgba(0,0,0,0)");

  const data = {
    labels,
    datasets: [
      {
        label: info.name,
        data: closes,
        borderColor: color,
        backgroundColor: grad,
        borderWidth: 2,
        fill: true,
        pointRadius: 0,
        tension: 0.25,
      },
    ],
  };

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { intersect: false, mode: "index" },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: "#0b0e14",
        borderColor: "#263143",
        borderWidth: 1,
        callbacks: {
          label: (item) => `${info.unit}${fmt(item.parsed.y, info.decimals)}`,
        },
      },
    },
    scales: {
      x: {
        grid: { color: "rgba(38,49,67,0.4)" },
        ticks: { color: "#8a97ab", maxTicksLimit: 8, autoSkip: true },
      },
      y: {
        position: "right",
        grid: { color: "rgba(38,49,67,0.4)" },
        ticks: { color: "#8a97ab", callback: (v) => info.unit + fmt(v, 0) },
      },
    },
  };

  if (chart) {
    chart.data = data;
    chart.options = options;
    chart.update("none");
  } else {
    const existing = Chart.getChart(ctx.canvas); // clear any stale registration
    if (existing) existing.destroy();
    chart = new Chart(ctx, { type: "line", data, options });
  }
}

function renderSummary(summary) {
  $("verdict").textContent = summary.verdict.toUpperCase();
  $("verdict").className = "verdict " + summary.verdict;
  $("summaryText").textContent = summary.text;
  $("signalList").innerHTML = summary.signals
    .map(
      ([tag, desc, val]) =>
        `<li><span class="tag ${tag}">${tag}</span><span>${desc}</span><span class="desc">${val}</span></li>`
    )
    .join("");
}

/* ---------- Orchestration ---------- */

async function load() {
  $("chartLoading").classList.remove("hidden");
  $("chartLoading").textContent = "Fetching live data…";
  try {
    const result = await fetchChart(state.symbol, state.baseRange, state.interval);
    const series = trimToPeriod(parseSeries(result), state.lookbackMs);
    if (series.length < 2) throw new Error("Not enough data");

    renderPrice(series, result.meta, result);
    const summary = buildSummary(series);
    renderSummary(summary);
    renderChart(series, summary);

    $("lastUpdate").textContent = "Updated " + new Date().toLocaleTimeString("en-US");
    $("chartLoading").classList.add("hidden");
  } catch (err) {
    $("chartLoading").textContent =
      "⚠️ Could not load live data (proxy/CORS or market data unavailable). Retrying on next refresh…";
    $("lastUpdate").textContent = "Failed " + new Date().toLocaleTimeString("en-US");
    console.error(err);
  }
}

function setAuto(on) {
  clearInterval(state.autoTimer);
  if (on) state.autoTimer = setInterval(load, 30000);
}

/* ---------- Wiring ---------- */

document.querySelectorAll("#symbolTabs .tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#symbolTabs .tab").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.symbol = btn.dataset.symbol;
    load();
  });
});

document.querySelectorAll("#tfGroup .chip").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#tfGroup .chip").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.tf = btn.dataset.tf;
    Object.assign(state, TIMEFRAMES[state.tf]); // interval, baseRange, lookbackMs
    load();
  });
});

$("refreshBtn").addEventListener("click", load);
$("autoRefresh").addEventListener("change", (e) => setAuto(e.target.checked));

// Boot
load();
setAuto(true);

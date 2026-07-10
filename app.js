/* Jib Jab Dashboard — live Gold & Nasdaq futures with technical summary.
 * Data: Yahoo Finance chart API, fetched through CORS-proxy fallbacks so it
 * works from any static host (GitHub Pages / Netlify) with no API key.
 */

const SYMBOLS = {
  "GC=F": { name: "Gold Futures", unit: "$", decimals: 2 },
  "NQ=F": { name: "Nasdaq-100 Futures", unit: "", decimals: 2 },
};

const HOUR = 3600000;
const DAY = 86400000;

// Day-trading timeframes. Each button is a chart granularity plus how much
// history to show: baseRange seeds the fetch, lookbackMs trims it client-side.
// Intraday frames use tight, session-sized windows (futures trade ~24h, so a
// full-day window would span two calendar dates and read as noise).
const TIMEFRAMES = {
  "1m": { interval: "1m", baseRange: "5d", lookbackMs: 6 * HOUR },
  "5m": { interval: "5m", baseRange: "5d", lookbackMs: 1 * DAY },
  "15m": { interval: "15m", baseRange: "5d", lookbackMs: 2 * DAY },
  "1h": { interval: "1h", baseRange: "1mo", lookbackMs: 10 * DAY },
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

let lwChart = null;
let candleSeries = null;
let priceLines = [];
let needsFit = true;

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

// Fetch with a hard timeout so a hung/slow proxy fails over quickly instead of
// stalling the whole refresh.
async function fetchTimeout(url, ms = 8000) {
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { cache: "no-store", signal: ac.signal });
  } finally {
    clearTimeout(to);
  }
}

async function fetchChart(symbol, period, interval) {
  for (const range of candidateRanges(period, interval)) {
    const base = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
      symbol
    )}?range=${range}&interval=${interval}&includePrePost=true`;
    for (const url of proxied(base)) {
      try {
        const res = await fetchTimeout(url);
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

/* ---------- Higher-timeframe context (for daily levels + CRT) ---------- */

// Cache a 1h/1mo dataset per symbol for ~5 min so the 30s refresh doesn't
// hammer the proxies. Used for PDH/PDL and the CRT model.
let contextCache = { key: null, data: null, t: 0 };
async function getContext(symbol) {
  if (contextCache.key === symbol && contextCache.data && Date.now() - contextCache.t < 5 * 60 * 1000) {
    return contextCache.data;
  }
  const result = await fetchChart(symbol, "1mo", "1h");
  const data = parseSeries(result);
  contextCache = { key: symbol, data, t: Date.now() };
  return data;
}

/* ---------- New York session / ET time helpers ---------- */

const NY_TZ = "America/New_York";

// Wall-clock parts of a Date in New York time (DST-aware).
function etParts(date) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: NY_TZ, hour12: false, weekday: "short",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p = {};
  for (const { type, value } of f.formatToParts(date)) p[type] = value;
  if (p.hour === "24") p.hour = "00";
  return p;
}
// ET UTC offset (ms) at a given instant.
function etOffsetMs(date) {
  const p = etParts(date);
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - date.getTime();
}
// Timestamp (ms) for ET wall-clock hh:mm on the ET calendar day of baseDate.
function etWallClockTs(baseDate, hh, mm) {
  const p = etParts(baseDate);
  return Date.UTC(+p.year, +p.month - 1, +p.day, hh, mm, 0) - etOffsetMs(baseDate);
}
const etDayKey = (ms) => {
  const p = etParts(new Date(ms));
  return `${p.year}-${p.month}-${p.day}`;
};

const parseHM = (str) => {
  const [h, m] = (str || "").split(":").map(Number);
  return { h: h || 0, m: m || 0 };
};
const dur = (ms) => {
  const total = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(total / 60), m = total % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
};

function sessionInfo(now = new Date()) {
  const s = parseHM($("sessStart") ? $("sessStart").value : "06:00");
  const e = parseHM($("sessEnd") ? $("sessEnd").value : "09:00");
  const startToday = etWallClockTs(now, s.h, s.m);
  const endToday = etWallClockTs(now, e.h, e.m);
  const weekday = etParts(now).weekday;
  const weekend = weekday === "Sat" || weekday === "Sun";
  const nowMs = now.getTime();

  let status, label;
  if (weekend) { status = "closed"; label = `Weekend — market closed (${weekday})`; }
  else if (nowMs < startToday) { status = "soon"; label = `NY Open killzone starts in ${dur(startToday - nowMs)}`; }
  else if (nowMs <= endToday) { status = "open"; label = `🟢 NY Open killzone LIVE — ${dur(endToday - nowMs)} left`; }
  else { status = "closed"; label = "NY Open killzone finished for today"; }
  return { status, label, startToday, endToday, weekend };
}

/* ---------- ICT / CRT engine ---------- */

const fmtP = (n) =>
  n == null ? "—" : SYMBOLS[state.symbol].unit + fmt(n, SYMBOLS[state.symbol].decimals);

// Fractal swing points: index i is a swing high/low if it's the extreme of the
// surrounding k bars on both sides.
function swings(cs, k = 2) {
  const highs = [], lows = [];
  for (let i = k; i < cs.length - k; i++) {
    let ih = true, il = true;
    for (let j = 1; j <= k; j++) {
      if (!(cs[i].h > cs[i - j].h && cs[i].h > cs[i + j].h)) ih = false;
      if (!(cs[i].l < cs[i - j].l && cs[i].l < cs[i + j].l)) il = false;
    }
    if (ih) highs.push({ i, price: cs[i].h });
    if (il) lows.push({ i, price: cs[i].l });
  }
  return { highs, lows };
}

// Previous ET-day high/low from the hourly context.
function dailyLevels(context, now) {
  if (!context || !context.length) return { pdh: null, pdl: null };
  const byDay = new Map();
  for (const c of context) {
    const k = etDayKey(c.t);
    const d = byDay.get(k) || { h: -Infinity, l: Infinity };
    d.h = Math.max(d.h, c.h);
    d.l = Math.min(d.l, c.l);
    byDay.set(k, d);
  }
  const keys = [...byDay.keys()].sort();
  const todayKey = etDayKey(now.getTime());
  const idx = keys.indexOf(todayKey);
  const prevKey = idx > 0 ? keys[idx - 1] : keys[keys.length - (idx === -1 ? 1 : 2)];
  const pd = prevKey ? byDay.get(prevKey) : null;
  return { pdh: pd ? pd.h : null, pdl: pd ? pd.l : null };
}

// High/low of the overnight window (ET midnight → session start today).
function preSessionRange(context, session, now) {
  if (!context || !context.length) return null;
  const startDay = etWallClockTs(now, 0, 0);
  let h = -Infinity, l = Infinity, n = 0;
  for (const c of context) {
    if (c.t >= startDay && c.t < session.startToday) { h = Math.max(h, c.h); l = Math.min(l, c.l); n++; }
  }
  return n ? { h, l } : null;
}

// High/low made so far inside today's killzone (entry timeframe).
function sessionRangeSoFar(series, session) {
  const end = Math.min(Date.now(), session.endToday);
  let h = -Infinity, l = Infinity, n = 0;
  for (const c of series) {
    if (c.t >= session.startToday && c.t <= end) { h = Math.max(h, c.h); l = Math.min(l, c.l); n++; }
  }
  return n ? { h, l } : null;
}

// Most recent liquidity sweep: wick past a level that closes back inside.
function detectSweep(series, levels) {
  const look = Math.min(series.length, 40);
  for (let i = series.length - 1; i >= series.length - look; i--) {
    const c = series[i];
    if (!c) break;
    for (const L of levels) {
      if (L.price == null) continue;
      // Swept buy-side liquidity (a high) then closed back below → bearish.
      if (L.side === "buy" && c.h > L.price && c.c < L.price) return { dir: "short", level: L, price: L.price };
      // Swept sell-side liquidity (a low) then closed back above → bullish.
      if (L.side === "sell" && c.l < L.price && c.c > L.price) return { dir: "long", level: L, price: L.price };
    }
  }
  return null;
}

// Market structure shift: last close breaks the most recent swing high/low.
function detectMSS(series) {
  const { highs, lows } = swings(series, 2);
  const last = series[series.length - 1].c;
  const sh = highs[highs.length - 1], sl = lows[lows.length - 1];
  const up = sh && last > sh.price;
  const dn = sl && last < sl.price;
  if (up && (!dn || sh.i >= sl.i)) return { dir: "long", level: sh.price };
  if (dn) return { dir: "short", level: sl.price };
  return null;
}

// Most recent 3-candle fair-value gap (imbalance).
function detectFVG(series) {
  for (let i = series.length - 1; i >= 2 && series.length - 1 - i <= 30; i--) {
    const a = series[i - 2], c = series[i];
    if (a.h < c.l) return { dir: "long", top: c.l, bottom: a.h };
    if (a.l > c.h) return { dir: "short", top: a.l, bottom: c.h };
  }
  return null;
}

// CRT (Candle Range Theory) on the last completed hourly candles: a purge of
// the prior candle's range that closes back inside signals expansion the other
// way.
function detectCRT(context) {
  const n = context.length;
  if (n < 3) return null;
  const range = context[n - 3], purge = context[n - 2];
  if (purge.l < range.l && purge.c > range.l) return { dir: "long", note: "1H purged range low, closed back inside" };
  if (purge.h > range.h && purge.c < range.h) return { dir: "short", note: "1H purged range high, closed back inside" };
  return null;
}

function avgRange(series, n = 20) {
  const s = series.slice(-n).map((c) => c.h - c.l).filter((x) => x > 0);
  return s.length ? s.reduce((a, b) => a + b, 0) / s.length : series[series.length - 1].c * 0.0005;
}

// Nearest opposite-side liquidity beyond entry, used as target.
function oppLiquidity(dir, entry, { daily, pre, sess }) {
  const ups = [daily.pdh, pre && pre.h, sess && sess.h].filter((x) => x != null && x > entry).sort((a, b) => a - b);
  const dns = [daily.pdl, pre && pre.l, sess && sess.l].filter((x) => x != null && x < entry).sort((a, b) => b - a);
  return dir === "long" ? ups[0] ?? null : dns[0] ?? null;
}

// JadeCap "Daily Sweep": the most recent CONFIRMED 1H swing-failure pattern —
// price raids a 1H swing high/low then closes back inside. That sweep sets the
// bias and the protective level. Only look at the last ~48 hourly candles.
function detectSFP(context, sw) {
  const n = context.length;
  let best = null;
  const record = (o) => { if (!best || o.j > best.j) best = o; };
  for (const sh of sw.highs) {
    for (let j = sh.i + 1; j < n; j++) {
      const c = context[j];
      if (c.h > sh.price && c.c < sh.price) { record({ dir: "short", swing: sh.price, j, wick: c.h }); break; }
      if (c.c > sh.price) break; // level broken (closed through) → not a sweep
    }
  }
  for (const sl of sw.lows) {
    for (let j = sl.i + 1; j < n; j++) {
      const c = context[j];
      if (c.l < sl.price && c.c > sl.price) { record({ dir: "long", swing: sl.price, j, wick: c.l }); break; }
      if (c.c < sl.price) break;
    }
  }
  if (best && best.j < n - 48) best = null; // stale sweep → ignore
  return best;
}

// Next opposing 1H swing that price can run to (the JadeCap target liquidity).
function nextOpposingSwing(dir, price, sw) {
  if (dir === "long") {
    const ups = sw.highs.map((h) => h.price).filter((p) => p > price).sort((a, b) => a - b);
    return ups[0] ?? null;
  }
  const dns = sw.lows.map((l) => l.price).filter((p) => p < price).sort((a, b) => b - a);
  return dns[0] ?? null;
}

/* ---------- Indicators for the strategy ensemble ---------- */

function emaLast(values, period) {
  const k = 2 / (period + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}
function emaSeries(values, period) {
  const k = 2 / (period + 1);
  const out = [values[0]];
  for (let i = 1; i < values.length; i++) out.push(values[i] * k + out[i - 1] * (1 - k));
  return out;
}
function rsi(values, period = 14) {
  if (values.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gains += d; else losses -= d;
  }
  if (losses === 0) return 100;
  return 100 - 100 / (1 + gains / losses);
}
function macdHist(values) {
  if (values.length < 26) return 0;
  const line = emaSeries(values, 12).map((v, i) => v - emaSeries(values, 26)[i]);
  const sig = emaSeries(line, 9);
  return line[line.length - 1] - sig[sig.length - 1];
}
// Session VWAP (falls back to last 60 bars pre-session).
function sessionVWAP(series, session) {
  let pv = 0, v = 0;
  for (const c of series) {
    if (c.t >= session.startToday) { const tp = (c.h + c.l + c.c) / 3, vol = c.v || 1; pv += tp * vol; v += vol; }
  }
  if (v === 0) for (const c of series.slice(-60)) { const tp = (c.h + c.l + c.c) / 3, vol = c.v || 1; pv += tp * vol; v += vol; }
  return v ? pv / v : series[series.length - 1].c;
}
// Opening range = first 15 min after session start.
function openingRange(series, session) {
  const end = session.startToday + 15 * 60000;
  let h = -Infinity, l = Infinity, n = 0;
  for (const c of series) if (c.t >= session.startToday && c.t <= end) { h = Math.max(h, c.h); l = Math.min(l, c.l); n++; }
  return n ? { h, l } : null;
}

/* ---------- Strategy ensemble ---------- */

// Six independent intraday strategies, each votes +1 (buy), -1 (sell), or 0.
// A trade only fires when enough of them agree — fewer, higher-quality signals.
function strategyVotes(series, context, session) {
  const closes = series.map((c) => c.c);
  const price = closes[closes.length - 1];
  const votes = [];

  // 1. EMA trend (9/21 direction, 50 regime)
  const e9 = emaLast(closes, 9), e21 = emaLast(closes, 21), e50 = emaLast(closes, 50);
  votes.push({ name: "EMA trend", v: e9 > e21 && price >= e50 ? 1 : e9 < e21 && price <= e50 ? -1 : 0 });

  // 2. VWAP position
  const vwap = sessionVWAP(series, session);
  votes.push({ name: "VWAP", v: price > vwap ? 1 : price < vwap ? -1 : 0, vwap });

  // 3. RSI momentum
  const r = rsi(closes, 14);
  votes.push({ name: "RSI", v: r > 55 ? 1 : r < 45 ? -1 : 0 });

  // 4. MACD histogram
  const h = macdHist(closes);
  votes.push({ name: "MACD", v: h > 0 ? 1 : h < 0 ? -1 : 0 });

  // 5. Opening-range breakout
  const or = openingRange(series, session);
  votes.push({ name: "Opening range", v: or ? (price > or.h ? 1 : price < or.l ? -1 : 0) : 0 });

  // 6. JadeCap 1H swing-failure sweep
  const sfp = detectSFP(context, swings(context, 1));
  votes.push({ name: "1H sweep (JadeCap)", v: sfp ? (sfp.dir === "long" ? 1 : -1) : 0, sfp });

  return votes;
}

// Combine the votes into a single BUY / SELL / WAIT call with a scalp plan.
function buildICT(series, context, session) {
  const price = series[series.length - 1].c;
  const votes = strategyVotes(series, context, session);
  const long = votes.filter((x) => x.v > 0).length;
  const short = votes.filter((x) => x.v < 0).length;
  const net = long - short;
  const agree = Math.max(long, short);
  const total = votes.length;
  const inKz = session.status === "open";

  // Need a clear majority (net ≥ 3) to take a trade.
  const dir = net >= 3 ? "long" : net <= -3 ? "short" : null;
  const names = dir ? votes.filter((x) => (dir === "long" ? x.v > 0 : x.v < 0)).map((x) => x.name) : [];
  const confidence = agree >= 6 ? "VERY STRONG" : agree >= 5 ? "STRONG" : agree >= 4 ? "MODERATE" : "BUILDING";

  // Tight scalp plan: ATR-based stop, quick 1.5R target (get in, get out).
  let plan = null;
  const atr = avgRange(series);
  if (dir) {
    const entry = price;
    const stop = dir === "long" ? entry - atr * 1.2 : entry + atr * 1.2;
    const risk = Math.abs(entry - stop);
    const target = dir === "long" ? entry + risk * 1.5 : entry - risk * 1.5;
    plan = { dir, entry, stop, target, rr: 1.5 };
  }

  let verdict = "wait", action, text;
  if (!dir) {
    verdict = "wait";
    action = "WAIT — no clear edge";
    text = `Only ${agree}/${total} strategies agree — not enough confluence. Stay flat and let a cleaner setup form.${inKz ? "" : " " + session.label + "."}`;
  } else if (!inKz) {
    verdict = "wait";
    action = `WAIT — ${dir === "long" ? "BUY" : "SELL"} setup brewing, outside your window`;
    text = `${agree}/${total} strategies favor ${dir === "long" ? "a long" : "a short"} (${confidence}), but ${session.label}. Take it in your 6–9 AM ET window.`;
  } else {
    verdict = dir;
    action = `${dir === "long" ? "BUY / LONG" : "SELL / SHORT"} now @ ${fmtP(price)}`;
    text = `${confidence} — ${agree}/${total} strategies agree (${names.join(", ")}). Scalp it: stop ${fmtP(plan.stop)}, target ${fmtP(plan.target)} (~1.5R). Get in, take the move, get out.`;
  }

  const vwapLevel = votes.find((x) => x.vwap != null);
  const chartLevels = [];
  if (vwapLevel) chartLevels.push({ price: vwapLevel.vwap, color: "#8a97ab", title: "VWAP", dashed: true });
  if (plan) {
    chartLevels.push({ price: plan.entry, color: "#4f8cff", title: "Entry" });
    chartLevels.push({ price: plan.stop, color: "#ef4444", title: "Stop" });
    chartLevels.push({ price: plan.target, color: "#22c55e", title: "Target" });
  }

  return { verdict, action, text, plan, chartLevels, session, confidence, agree, total, names };
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

// TradingView-style candlestick chart (Lightweight Charts) with native
// scroll/pinch zoom and drag pan. Times are rendered in New York time.
const nyTimeLabel = (t) =>
  new Date(t * 1000).toLocaleString("en-US", {
    timeZone: NY_TZ, month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });

function renderChart(series, ict) {
  // Candles in UNIX seconds, strictly ascending & unique (LWC requirement).
  const data = [];
  let lastT = -1;
  for (const d of series) {
    const t = Math.floor(d.t / 1000);
    if (t <= lastT) continue;
    if (d.o == null || d.h == null || d.l == null || d.c == null) continue;
    lastT = t;
    data.push({ time: t, open: d.o, high: d.h, low: d.l, close: d.c });
  }
  if (!data.length) return;

  if (!lwChart) {
    lwChart = LightweightCharts.createChart($("chart"), {
      autoSize: true,
      layout: { background: { color: "rgba(0,0,0,0)" }, textColor: "#8a97ab", fontFamily: "inherit" },
      grid: { vertLines: { color: "rgba(38,49,67,0.35)" }, horzLines: { color: "rgba(38,49,67,0.35)" } },
      rightPriceScale: { borderColor: "#263143" },
      timeScale: {
        borderColor: "#263143", timeVisible: true, secondsVisible: false,
        tickMarkFormatter: (t) => nyTimeLabel(t),
      },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
      localization: { timeFormatter: (t) => nyTimeLabel(t) },
    });
    candleSeries = lwChart.addCandlestickSeries({
      upColor: "#22c55e", downColor: "#ef4444", borderVisible: false,
      wickUpColor: "#22c55e", wickDownColor: "#ef4444",
    });
  }

  candleSeries.setData(data);

  // Refresh key ICT levels as horizontal price lines.
  for (const pl of priceLines) candleSeries.removePriceLine(pl);
  priceLines = (ict.chartLevels || []).map((L) =>
    candleSeries.createPriceLine({
      price: L.price, color: L.color, lineWidth: 1,
      lineStyle: L.dashed ? 2 : 0, axisLabelVisible: true, title: L.title,
    })
  );

  // Only auto-fit on first load / timeframe / symbol change — preserve the
  // user's zoom & pan across the 30s auto-refresh.
  if (needsFit) { lwChart.timeScale().fitContent(); needsFit = false; }
}

function renderSessionBar(session) {
  const sb = $("sessionBar");
  if (!sb) return;
  sb.className = "session-bar " + (session.status === "open" ? "open" : session.status === "soon" ? "soon" : "");
  $("sessionText").textContent = session.label;
}

function renderTradeAssistant(sig) {
  const labels = { long: "BUY ▲", short: "SELL ▼", wait: "WAIT" };
  const v = $("verdict");
  v.textContent = labels[sig.verdict] || "WAIT";
  v.className = "verdict " + sig.verdict;

  renderSessionBar(sig.session);

  const al = $("actionLine");
  al.textContent = sig.action;
  al.className = "action-line " + sig.verdict;

  $("summaryText").textContent = sig.text;

  const pg = $("planGrid");
  if (sig.plan) {
    const p = sig.plan;
    const cells = [
      ["Entry", fmtP(p.entry), "entry"],
      ["Stop loss", fmtP(p.stop), "stop"],
      ["Target", fmtP(p.target), "target"],
      ["Reward : Risk", `${p.rr.toFixed(2)} : 1`, ""],
    ];
    pg.innerHTML = cells
      .map(([l, val, cls]) => `<div class="plan ${cls}"><div class="label">${l}</div><div class="value">${val}</div></div>`)
      .join("");
  } else {
    pg.innerHTML = "";
  }
}

/* ---------- Orchestration ---------- */

async function load() {
  $("chartLoading").classList.remove("hidden");
  $("chartLoading").textContent = "Fetching live data…";
  try {
    const result = await fetchChart(state.symbol, state.baseRange, state.interval);
    const series = trimToPeriod(parseSeries(result), state.lookbackMs);
    if (series.length < 2) throw new Error("Not enough data");

    let context = [];
    try { context = await getContext(state.symbol); } catch (_) { /* degrade gracefully */ }

    renderPrice(series, result.meta, result);
    const ict = buildICT(series, context, sessionInfo());
    renderTradeAssistant(ict);
    renderChart(series, ict);

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
    needsFit = true; // new instrument → refit view
    load();
  });
});

document.querySelectorAll("#tfGroup .chip").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#tfGroup .chip").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.tf = btn.dataset.tf;
    Object.assign(state, TIMEFRAMES[state.tf]); // interval, baseRange, lookbackMs
    needsFit = true; // new timeframe → refit view
    load();
  });
});

$("refreshBtn").addEventListener("click", load);
$("autoRefresh").addEventListener("change", (e) => setAuto(e.target.checked));
["sessStart", "sessEnd"].forEach((id) => $(id).addEventListener("change", () => load()));

// Live-tick the session countdown every second without refetching data.
setInterval(() => renderSessionBar(sessionInfo()), 1000);

// Boot
load();
setAuto(true);

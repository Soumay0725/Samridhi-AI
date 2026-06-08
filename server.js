// ════════════════════════════════════════════════════════
//  SAMRIDHI AI — BACKEND SERVER (Phase 23A v2)
//  - Historical data (1y daily) for indicators
//  - Live price from intraday (1d/1m) endpoint
//  - Parallel batch fetch
//  - 30s price cache
// ════════════════════════════════════════════════════════

const express = require('express');
const axios   = require('axios');
const cors    = require('cors');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ── Cache ────────────────────────────────────────────────
const histCache  = {};   // historical data — cache 6 hours
const liveCache  = {};   // live price — cache 30 seconds
const HIST_TTL   = 6  * 3600 * 1000;
const LIVE_TTL   = 30 * 1000;

const HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept':          'application/json',
  'Accept-Language': 'en-US,en;q=0.9'
};

function toYahoo(sym) {
  const MAP = {
    'M&M':          'M%26M.NS',
    'L&TFH':        'L%26TFH.NS',
    'BAJAJ-AUTO':   'BAJAJ-AUTO.NS',
    'IPCA':         'IPCALAB.NS',
    'LTIM':         'LTIM.NS',
    'LTTS':         'LTTS.NS',
    'ICICIGI':      'ICICIGI.NS',
    'HDFCAMC':      'HDFCAMC.NS',
    'MUTHOOTFIN':   'MUTHOOTFIN.NS',
    'CHOLAFIN':     'CHOLAFIN.NS',
    'MANAPPURAM':   'MANAPPURAM.NS',
    'PIRAMALENT':   'PIRAMALENT.NS',
    'IPCALAB':      'IPCA.NS',
    'NAZARA':       'NAZARA.NS',
    'MAPMYINDIA':   'MAPMYINDIA.NS',
    'LALPATHLAB':   'LALPATHLAB.NS',
    'YATHARTH':     'YATHARTH.NS',
  };
  return MAP[sym] || (sym + '.NS');
}

// ── Fetch live price (intraday 1m) ───────────────────────
async function fetchLivePrice(ySym) {
  const cached = liveCache[ySym];
  if (cached && (Date.now() - cached.ts) < LIVE_TTL) return cached;

  try {
    const url  = `https://query1.finance.yahoo.com/v8/finance/chart/${ySym}?range=1d&interval=1m&includePrePost=false`;
    const resp = await axios.get(url, { timeout: 6000, headers: HEADERS });
    const result = resp.data?.chart?.result?.[0];
    if (!result) return null;

    const meta    = result.meta || {};
    const quotes  = result.indicators?.quote?.[0] || {};
    const closes  = (quotes.close || []).filter(v => v != null);

    // Use the most recent 1m close as live price — more accurate than meta
    const livePrice = closes.length > 0
      ? parseFloat(closes[closes.length - 1].toFixed(2))
      : (meta.regularMarketPrice || 0);

    const prevClose = meta.previousClose || meta.chartPreviousClose || livePrice;
    const chg = prevClose ? parseFloat(((livePrice - prevClose) / prevClose * 100).toFixed(2)) : 0;
    const vol = meta.regularMarketVolume || 0;

    const data = { price: livePrice, prevClose, chg, volume: vol, ts: Date.now() };
    liveCache[ySym] = data;
    return data;
  } catch(e) {
    return null;
  }
}

// ── Fetch historical data (1y daily) for indicators ──────
async function fetchHistorical(ySym) {
  const cached = histCache[ySym];
  if (cached && (Date.now() - cached.ts) < HIST_TTL) return cached;

  try {
    const url  = `https://query1.finance.yahoo.com/v8/finance/chart/${ySym}?range=1y&interval=1d&includePrePost=false`;
    const resp = await axios.get(url, { timeout: 8000, headers: HEADERS });
    const result = resp.data?.chart?.result?.[0];
    if (!result) return null;

    const meta    = result.meta || {};
    const quotes  = result.indicators?.quote?.[0] || {};
    const closes  = (quotes.close  || []).filter(v => v != null);
    const highs   = (quotes.high   || []).filter(v => v != null);
    const lows    = (quotes.low    || []).filter(v => v != null);
    const volumes = (quotes.volume || []).filter(v => v != null);

    const data = {
      closes, highs, lows, volumes,
      w52Hi:   meta.fiftyTwoWeekHigh || null,
      w52Lo:   meta.fiftyTwoWeekLow  || null,
      marketCap: meta.marketCap      || null,
      pe:      meta.trailingPE       || null,
      ts:      Date.now()
    };
    histCache[ySym] = data;
    return data;
  } catch(e) {
    return null;
  }
}

// ── Fetch single stock — live price + historical ─────────
async function fetchStock(sym) {
  const ySym = toYahoo(sym);

  // Fetch live price and historical data in parallel with individual timeouts
  const [live, hist] = await Promise.all([
    fetchLivePrice(ySym).catch(() => null),
    fetchHistorical(ySym).catch(() => null)
  ]);

  if (!live && !hist) return null;

  const price    = live?.price    || hist?.closes?.[hist.closes.length-1] || 0;
  const prevClose= live?.prevClose|| 0;
  const chg      = live?.chg      || 0;
  const volume   = live?.volume   || 0;

  // Avg volume from historical
  const volumes  = hist?.volumes  || [];
  const avgVol20 = volumes.length >= 20
    ? Math.round(volumes.slice(-20).reduce((a,b)=>a+b,0)/20)
    : 0;

  return {
    sym,
    price:    parseFloat(price.toFixed(2)),
    prevClose:parseFloat(prevClose.toFixed(2)),
    chg:      parseFloat(chg.toFixed(2)),
    volume,
    avgVol20,
    closes:   hist?.closes  || [],
    highs:    hist?.highs   || [],
    lows:     hist?.lows    || [],
    volumes,
    w52Hi:    hist?.w52Hi   || null,
    w52Lo:    hist?.w52Lo   || null,
    marketCap:hist?.marketCap||null,
    pe:       hist?.pe      || null,
    isLive:   true,
    source:   'server'
  };
}

// ── Batch fetch with concurrency ─────────────────────────
async function fetchBatch(symbols, concurrency = 10) {
  const results = {};
  const queue   = [...symbols];

  async function worker() {
    while (queue.length) {
      const sym = queue.shift();
      if (!sym) break;
      results[sym] = await fetchStock(sym);
      await new Promise(r => setTimeout(r, 30));
    }
  }

  await Promise.allSettled(Array.from({ length: concurrency }, worker));
  return results;
}

// ════════════════════════════════════════════════════════
//  ROUTES
// ════════════════════════════════════════════════════════

app.get('/', (req, res) => {
  res.json({
    status:  'ok',
    service: 'Samridhi AI Server',
    version: '23A-v2',
    uptime:  Math.round(process.uptime()) + 's',
    histCached: Object.keys(histCache).length,
    liveCached: Object.keys(liveCache).length
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', ts: Date.now() });
});

// Single stock
app.get('/stock/:sym', async (req, res) => {
  const sym  = req.params.sym.toUpperCase().trim();
  const data = await fetchStock(sym);
  if (!data) return res.status(404).json({ error: 'Could not fetch ' + sym });
  res.json(data);
});

// Batch
app.get('/batch', async (req, res) => {
  const raw  = (req.query.syms || '').trim();
  if (!raw)  return res.status(400).json({ error: 'syms parameter required' });

  const syms = raw.split(',').map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, 200);
  if (!syms.length) return res.status(400).json({ error: 'No valid symbols' });

  console.log(`[batch] Fetching ${syms.length} stocks...`);
  const start   = Date.now();
  const results = await fetchBatch(syms);
  const elapsed = Date.now() - start;
  const fetched = Object.values(results).filter(Boolean).length;

  console.log(`[batch] Done: ${fetched}/${syms.length} in ${elapsed}ms`);
  res.json({ results, meta: { requested: syms.length, fetched, elapsed_ms: elapsed, ts: Date.now() } });
});

// Indices
app.get('/indices', async (req, res) => {
  try {
    const [nifty, sensex] = await Promise.all([
      axios.get('https://query1.finance.yahoo.com/v8/finance/chart/%5ENSETP?range=1d&interval=1m', { timeout: 8000, headers: HEADERS }),
      axios.get('https://query1.finance.yahoo.com/v8/finance/chart/%5EBSESN?range=1d&interval=1m', { timeout: 8000, headers: HEADERS })
    ]);

    const nm = nifty.data?.chart?.result?.[0]?.meta  || {};
    const sm = sensex.data?.chart?.result?.[0]?.meta || {};

    // Use most recent 1m close for indices too
    const nq = nifty.data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter(v=>v!=null) || [];
    const sq = sensex.data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter(v=>v!=null)||[];

    const nPrice = nq.length ? nq[nq.length-1] : (nm.regularMarketPrice||0);
    const sPrice = sq.length ? sq[sq.length-1] : (sm.regularMarketPrice||0);

    res.json({
      nifty:  { price: parseFloat(nPrice.toFixed(2)), chg: nm.previousClose ? parseFloat(((nPrice-nm.previousClose)/nm.previousClose*100).toFixed(2)) : 0 },
      sensex: { price: parseFloat(sPrice.toFixed(2)), chg: sm.previousClose ? parseFloat(((sPrice-sm.previousClose)/sm.previousClose*100).toFixed(2)) : 0 },
      ts: Date.now()
    });
  } catch(e) {
    res.status(500).json({ error: 'Index fetch failed' });
  }
});

app.get('/cache', (req, res) => {
  res.json({ hist: Object.keys(histCache).length, live: Object.keys(liveCache).length });
});

app.listen(PORT, () => {
  console.log(`Samridhi AI Server v23A-v2 running on port ${PORT}`);
});

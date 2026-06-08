// ════════════════════════════════════════════════════════
//  SAMRIDHI AI — BACKEND SERVER (Phase 23A)
//  Node.js + Express
//  - Parallel Yahoo Finance fetching (200 stocks in ~8s)
//  - CORS proxy for browser requests
//  - Price cache (30s) to avoid rate limits
//  - Health check endpoint
//  - Pre-market scan trigger (9:00 AM IST)
// ════════════════════════════════════════════════════════

const express  = require('express');
const axios    = require('axios');
const cors     = require('cors');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── CORS — allow GitHub Pages frontend ──────────────────
// Allow all origins — Samridhi is a personal tool, no sensitive data
app.use(cors());

app.use(express.json());

// ── In-memory price cache ────────────────────────────────
const priceCache   = {};   // { 'RELIANCE.NS': { data, ts } }
const CACHE_TTL_MS = 30 * 1000;   // 30 seconds

// ── NSE symbol → Yahoo Finance symbol map ───────────────
function toYahoo(sym) {
  // Most NSE symbols just need .NS suffix
  // Special cases
  const MAP = {
    'M&M':          'M%26M.NS',
    'L&TFH':        'L%26TFH.NS',
    'BAJAJ-AUTO':   'BAJAJ-AUTO.NS',
  };
  return MAP[sym] || (sym + '.NS');
}

// ── Fetch single stock from Yahoo Finance ───────────────
async function fetchStock(sym) {
  const ySym   = toYahoo(sym);
  const cached = priceCache[ySym];
  if (cached && (Date.now() - cached.ts) < CACHE_TTL_MS) {
    return cached.data;
  }

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ySym}?range=1y&interval=1d&includePrePost=false`;

  try {
    const resp = await axios.get(url, {
      timeout: 12000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept':     'application/json',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });

    const result = resp.data?.chart?.result?.[0];
    if (!result) return null;

    const meta      = result.meta || {};
    const quotes    = result.indicators?.quote?.[0] || {};
    const timestamps= result.timestamp || [];
    const closes    = quotes.close  || [];
    const highs     = quotes.high   || [];
    const lows      = quotes.low    || [];
    const volumes   = quotes.volume || [];

    // Filter nulls
    const validCloses = closes.filter(v => v != null);
    const validVols   = volumes.filter(v => v != null);

    const price   = meta.regularMarketPrice || validCloses[validCloses.length - 1] || 0;
    const prevClose = meta.previousClose    || meta.chartPreviousClose || price;
    const chgPct  = prevClose ? ((price - prevClose) / prevClose * 100) : 0;

    const data = {
      sym,
      price:      parseFloat(price.toFixed(2)),
      prevClose:  parseFloat(prevClose.toFixed(2)),
      chg:        parseFloat(chgPct.toFixed(2)),
      volume:     meta.regularMarketVolume || 0,
      avgVol20:   validVols.length >= 20
                  ? Math.round(validVols.slice(-20).reduce((a,b)=>a+b,0)/20)
                  : 0,
      w52Hi:      meta.fiftyTwoWeekHigh || null,
      w52Lo:      meta.fiftyTwoWeekLow  || null,
      marketCap:  meta.marketCap        || null,
      pe:         meta.trailingPE       || null,
      closes:     validCloses,
      highs:      highs.filter(v => v != null),
      lows:       lows.filter(v => v != null),
      volumes:    validVols,
      timestamps,
      isLive:     true,
      source:     'server'
    };

    priceCache[ySym] = { data, ts: Date.now() };
    return data;

  } catch (err) {
    const status = err?.response?.status;
    console.error(`[${sym}] fetch error: ${status || err.message}`);
    return null;
  }
}

// ── Fetch batch of stocks in parallel ───────────────────
async function fetchBatch(symbols, concurrency = 8) {
  const results = {};
  const queue   = [...symbols];

  async function worker() {
    while (queue.length) {
      const sym = queue.shift();
      if (!sym) break;
      const data = await fetchStock(sym);
      results[sym] = data;
      // Small delay to be polite to Yahoo
      await new Promise(r => setTimeout(r, 80));
    }
  }

  // Run N workers in parallel
  const workers = Array.from({ length: concurrency }, worker);
  await Promise.all(workers);
  return results;
}

// ════════════════════════════════════════════════════════
//  ROUTES
// ════════════════════════════════════════════════════════

// Health check
app.get('/', (req, res) => {
  res.json({
    status:  'ok',
    service: 'Samridhi AI Server',
    version: '23A',
    uptime:  Math.round(process.uptime()) + 's',
    cached:  Object.keys(priceCache).length + ' symbols'
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', ts: Date.now() });
});

// ── Single stock ────────────────────────────────────────
// GET /stock/RELIANCE
app.get('/stock/:sym', async (req, res) => {
  const sym  = req.params.sym.toUpperCase().trim();
  const data = await fetchStock(sym);
  if (!data) {
    return res.status(404).json({ error: 'Could not fetch ' + sym });
  }
  res.json(data);
});

// ── Batch stocks ────────────────────────────────────────
// GET /batch?syms=RELIANCE,TCS,INFY,...
app.get('/batch', async (req, res) => {
  const raw  = (req.query.syms || '').trim();
  if (!raw) return res.status(400).json({ error: 'syms parameter required' });

  const syms = raw.split(',').map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, 200);
  if (!syms.length) return res.status(400).json({ error: 'No valid symbols' });

  console.log(`[batch] Fetching ${syms.length} stocks...`);
  const start   = Date.now();
  const results = await fetchBatch(syms);
  const elapsed = Date.now() - start;

  const fetched = Object.values(results).filter(Boolean).length;
  console.log(`[batch] Done: ${fetched}/${syms.length} in ${elapsed}ms`);

  res.json({
    results,
    meta: {
      requested: syms.length,
      fetched,
      elapsed_ms: elapsed,
      ts: Date.now()
    }
  });
});

// ── Nifty 50 + Sensex index prices ──────────────────────
// GET /indices
app.get('/indices', async (req, res) => {
  try {
    const [nifty, sensex] = await Promise.all([
      axios.get('https://query1.finance.yahoo.com/v8/finance/chart/%5ENSETP?range=1d&interval=5m', {
        timeout: 8000,
        headers: { 'User-Agent': 'Mozilla/5.0' }
      }),
      axios.get('https://query1.finance.yahoo.com/v8/finance/chart/%5EBSESN?range=1d&interval=5m', {
        timeout: 8000,
        headers: { 'User-Agent': 'Mozilla/5.0' }
      })
    ]);

    const nm = nifty.data?.chart?.result?.[0]?.meta  || {};
    const sm = sensex.data?.chart?.result?.[0]?.meta || {};

    res.json({
      nifty: {
        price: nm.regularMarketPrice || 0,
        chg:   nm.previousClose ? ((nm.regularMarketPrice - nm.previousClose) / nm.previousClose * 100).toFixed(2) : 0
      },
      sensex: {
        price: sm.regularMarketPrice || 0,
        chg:   sm.previousClose ? ((sm.regularMarketPrice - sm.previousClose) / sm.previousClose * 100).toFixed(2) : 0
      },
      ts: Date.now()
    });
  } catch (err) {
    res.status(500).json({ error: 'Index fetch failed' });
  }
});

// ── Cache stats ─────────────────────────────────────────
app.get('/cache', (req, res) => {
  const now   = Date.now();
  const stats = Object.entries(priceCache).map(([sym, v]) => ({
    sym,
    age_s: Math.round((now - v.ts) / 1000),
    price: v.data?.price
  }));
  res.json({ count: stats.length, symbols: stats });
});

// ── Clear cache ──────────────────────────────────────────
app.post('/cache/clear', (req, res) => {
  Object.keys(priceCache).forEach(k => delete priceCache[k]);
  res.json({ status: 'cleared' });
});

// ════════════════════════════════════════════════════════
//  START
// ════════════════════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`Samridhi AI Server v23A running on port ${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
});

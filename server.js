// ════════════════════════════════════════════════════════
//  SAMRIDHI AI — UPSTOX SERVER (Phase 23A)
//  - Handles Upstox OAuth token exchange
//  - Fetches live NSE prices (paisa accurate)
//  - Batch quotes for all 200 stocks
//  - CORS enabled for GitHub Pages
// ════════════════════════════════════════════════════════

const express = require('express');
const axios   = require('axios');
const cors    = require('cors');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ── Upstox credentials ───────────────────────────────────
const UPSTOX_API_KEY    = process.env.UPSTOX_API_KEY    || 'f1a6b64f-7cad-41fa-88dc-395a473de524';
const UPSTOX_API_SECRET = process.env.UPSTOX_API_SECRET || 'bnf4eobcdu';
const REDIRECT_URI      = 'https://soumay0725.github.io/Samridhi-AI/';

// ── Token store ──────────────────────────────────────────
let accessToken  = null;
let tokenExpiry  = null;

// ── Price cache (15 seconds) ─────────────────────────────
const priceCache = {};
const CACHE_TTL  = 15 * 1000;

// ── NSE instrument key map ───────────────────────────────
// Upstox uses NSE_EQ|SYMBOL format
function toUpstoxKey(sym) {
  return 'NSE_EQ|' + sym;
}

// ════════════════════════════════════════════════════════
//  ROUTES
// ════════════════════════════════════════════════════════

app.get('/health', (req, res) => {
  res.json({
    status:    'ok',
    service:   'Samridhi AI Upstox Server',
    version:   '23A',
    hasToken:  !!accessToken,
    tokenExp:  tokenExpiry ? new Date(tokenExpiry).toISOString() : null,
    cached:    Object.keys(priceCache).length
  });
});

// ── Step 1: Get Upstox OAuth login URL ──────────────────
// Frontend opens this URL to let user login to Upstox
app.get('/auth/url', (req, res) => {
  const url = `https://api.upstox.com/v2/login/authorization/dialog`
    + `?client_id=${UPSTOX_API_KEY}`
    + `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`
    + `&response_type=code`
    + `&state=samridhi`;
  res.json({ url });
});

// ── Step 2: Exchange auth code for access token ──────────
// Frontend sends the code it received after login
app.post('/auth/token', async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'code required' });

  try {
    // Upstox requires form-encoded body
    // Upstox v2 token endpoint uses 'client_id' and 'client_secret'
    const params = new URLSearchParams();
    params.append('code',          code);
    params.append('client_id',     UPSTOX_API_KEY);
    params.append('client_secret', UPSTOX_API_SECRET);
    params.append('redirect_uri',  REDIRECT_URI);
    params.append('grant_type',    'authorization_code');

    console.log('[Auth] Exchanging code with client_id:', UPSTOX_API_KEY);

    const resp = await axios.post(
      'https://api.upstox.com/v2/login/authorization/token',
      params.toString(),
      {
        headers: {
          'Content-Type':  'application/x-www-form-urlencoded',
          'Accept':        'application/json',
          'Api-Version':   '2.0'
        }
      }
    );

    accessToken = resp.data.access_token;
    // Upstox tokens expire at midnight IST — set expiry to midnight
    const now = new Date();
    const midnight = new Date();
    midnight.setHours(23, 59, 0, 0);
    tokenExpiry = midnight.getTime();

    console.log('[Auth] Token obtained, expires:', new Date(tokenExpiry).toISOString());
    res.json({ status: 'ok', expires: tokenExpiry });
  } catch(e) {
    console.error('[Auth] Token exchange failed:', e?.response?.data || e.message);
    res.status(500).json({ error: 'Token exchange failed', details: e?.response?.data });
  }
});

// ── Manual token input (paste from developer console) ───
app.post('/auth/manual', (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'token required' });
  accessToken = token;
  const midnight = new Date();
  midnight.setHours(23, 59, 0, 0);
  tokenExpiry = midnight.getTime();
  console.log('[Auth] Manual token set, expires:', new Date(tokenExpiry).toISOString());
  res.json({ status: 'ok', expires: tokenExpiry });
});

// ── Token status ─────────────────────────────────────────
app.get('/auth/status', (req, res) => {
  const valid = accessToken && tokenExpiry && Date.now() < tokenExpiry;
  res.json({ authenticated: !!valid, expires: tokenExpiry });
});

// ── Live quote for single stock ──────────────────────────
// GET /quote/TCS
app.get('/quote/:sym', async (req, res) => {
  if (!accessToken) return res.status(401).json({ error: 'Not authenticated' });

  const sym    = req.params.sym.toUpperCase();
  const cached = priceCache[sym];
  if (cached && (Date.now() - cached.ts) < CACHE_TTL) return res.json(cached.data);

  try {
    const key  = toUpstoxKey(sym);
    const resp = await axios.get(`https://api.upstox.com/v2/market-quote/ltp`, {
      params:  { instrument_key: key },
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      timeout: 8000
    });

    const d    = resp.data?.data?.[key] || resp.data?.data?.[`NSE_EQ:${sym}`];
    if (!d)    return res.status(404).json({ error: 'No data for ' + sym });

    const data = {
      sym,
      price:     d.last_price,
      open:      d.ohlc?.open  || d.last_price,
      high:      d.ohlc?.high  || d.last_price,
      low:       d.ohlc?.low   || d.last_price,
      close:     d.ohlc?.close || d.last_price,
      prevClose: d.ohlc?.close || d.last_price,
      chg:       d.ohlc?.close ? parseFloat(((d.last_price - d.ohlc.close) / d.ohlc.close * 100).toFixed(2)) : 0,
      volume:    d.volume || 0,
      isLive:    true,
      source:    'upstox'
    };

    priceCache[sym] = { data, ts: Date.now() };
    res.json(data);
  } catch(e) {
    console.error(`[Quote] ${sym} failed:`, e?.response?.data || e.message);
    res.status(500).json({ error: 'Quote failed for ' + sym });
  }
});

// ── Batch live quotes for all 200 stocks ─────────────────
// GET /batch?syms=RELIANCE,TCS,INFY,...
app.get('/batch', async (req, res) => {
  if (!accessToken) return res.status(401).json({ error: 'Not authenticated', needsAuth: true });

  const raw  = (req.query.syms || '').trim();
  if (!raw)  return res.status(400).json({ error: 'syms required' });

  const syms = raw.split(',').map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, 200);

  // Check cache first
  const results   = {};
  const toFetch   = [];
  const now       = Date.now();

  syms.forEach(sym => {
    const cached = priceCache[sym];
    if (cached && (now - cached.ts) < CACHE_TTL) {
      results[sym] = cached.data;
    } else {
      toFetch.push(sym);
    }
  });

  if (toFetch.length > 0) {
    // Upstox supports up to 500 instrument keys per request
    const chunkSize = 100;
    for (let i = 0; i < toFetch.length; i += chunkSize) {
      const chunk = toFetch.slice(i, i + chunkSize);
      const keys  = chunk.map(toUpstoxKey).join(',');

      try {
        const resp = await axios.get('https://api.upstox.com/v2/market-quote/ltp', {
          params:  { instrument_key: keys },
          headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
          timeout: 15000
        });

        const dataMap = resp.data?.data || {};
        chunk.forEach(sym => {
          const key = toUpstoxKey(sym);
          const d   = dataMap[key] || dataMap[`NSE_EQ:${sym}`];
          if (d && d.last_price) {
            const data = {
              sym,
              price:     parseFloat(d.last_price.toFixed(2)),
              open:      d.ohlc?.open  || d.last_price,
              high:      d.ohlc?.high  || d.last_price,
              low:       d.ohlc?.low   || d.last_price,
              prevClose: d.ohlc?.close || d.last_price,
              chg:       d.ohlc?.close ? parseFloat(((d.last_price - d.ohlc.close) / d.ohlc.close * 100).toFixed(2)) : 0,
              volume:    d.volume || 0,
              isLive:    true,
              source:    'upstox'
            };
            results[sym]        = data;
            priceCache[sym]     = { data, ts: now };
          }
        });
      } catch(e) {
        console.error(`[Batch] Chunk ${i}-${i+chunkSize} failed:`, e?.response?.data || e.message);
      }
    }
  }

  const fetched = Object.keys(results).length;
  console.log(`[Batch] ${fetched}/${syms.length} quotes returned`);
  res.json({ results, meta: { requested: syms.length, fetched, ts: now } });
});

// ── Historical data (Yahoo proxy — for indicators only) ──
// Historical OHLCV for RSI/MACD/SMA computation
// Upstox historical needs different endpoint — use Yahoo for history, Upstox for live price
app.get('/history/:sym', async (req, res) => {
  const sym  = req.params.sym.toUpperCase();
  const ySym = sym + '.NS';

  try {
    const url  = `https://query1.finance.yahoo.com/v8/finance/chart/${ySym}?range=1y&interval=1d`;
    const resp = await axios.get(url, {
      timeout: 12000,
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
    });

    const result = resp.data?.chart?.result?.[0];
    if (!result) return res.status(404).json({ error: 'No history for ' + sym });

    const quotes  = result.indicators?.quote?.[0] || {};
    const closes  = (quotes.close  || []).filter(v => v != null);
    const highs   = (quotes.high   || []).filter(v => v != null);
    const lows    = (quotes.low    || []).filter(v => v != null);
    const volumes = (quotes.volume || []).filter(v => v != null);

    res.json({ sym, closes, highs, lows, volumes, ts: Date.now() });
  } catch(e) {
    res.status(500).json({ error: 'History failed for ' + sym });
  }
});

// ── Full stock data (history + live price merged) ────────
// GET /stock/TCS — combines Yahoo history with Upstox live price
app.get('/stock/:sym', async (req, res) => {
  const sym = req.params.sym.toUpperCase();

  try {
    // Fetch history and live price in parallel
    const histPromise  = axios.get(`http://localhost:${PORT}/history/${sym}`, { timeout: 15000 }).catch(() => null);
    const livePromise  = accessToken
      ? axios.get(`http://localhost:${PORT}/quote/${sym}`, { timeout: 8000 }).catch(() => null)
      : Promise.resolve(null);

    const [histResp, liveResp] = await Promise.all([histPromise, livePromise]);

    const hist = histResp?.data;
    const live = liveResp?.data;

    if (!hist && !live) return res.status(404).json({ error: 'No data for ' + sym });

    res.json({
      sym,
      price:     live?.price     || hist?.closes?.[hist.closes.length - 1] || 0,
      prevClose: live?.prevClose || 0,
      chg:       live?.chg       || 0,
      volume:    live?.volume    || 0,
      closes:    hist?.closes    || [],
      highs:     hist?.highs     || [],
      lows:      hist?.lows      || [],
      volumes:   hist?.volumes   || [],
      isLive:    !!live,
      source:    live ? 'upstox' : 'yahoo'
    });
  } catch(e) {
    res.status(500).json({ error: 'Stock fetch failed for ' + sym });
  }
});

app.listen(PORT, () => {
  console.log(`Samridhi AI Upstox Server v23A running on port ${PORT}`);
  console.log(`Auth required: GET /auth/url to start login`);
});

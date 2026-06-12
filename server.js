// ════════════════════════════════════════════════════════
//  SAMRIDHI AI — UPSTOX SERVER (Phase 23C)
//  - Fixed /quote and /batch with correct Upstox key format
//  - Phase 23C: One-tap BUY/SELL order placement
//  - Auto stop loss placement after order
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
let accessToken = null;
let tokenExpiry = null;

// ── Price cache (15 seconds) ─────────────────────────────
const priceCache = {};
const CACHE_TTL  = 15 * 1000;

// ── Upstox instrument key ────────────────────────────────
// Upstox v2 uses NSE_EQ|SYMBOL format
function toUpstoxKey(sym) {
  return 'NSE_EQ|' + sym.toUpperCase();
}

// ── Extract price data from Upstox response ──────────────
// Upstox returns data keyed by instrument key — handles both formats
function extractFromUpstoxData(dataMap, sym) {
  const key1 = 'NSE_EQ|' + sym;
  const key2 = 'NSE_EQ:' + sym;
  return dataMap[key1] || dataMap[key2] || null;
}

// ════════════════════════════════════════════════════════
//  HEALTH
// ════════════════════════════════════════════════════════

app.get('/health', (req, res) => {
  res.json({
    status:   'ok',
    service:  'Samridhi AI Upstox Server',
    version:  '23C',
    hasToken: !!accessToken,
    tokenExp: tokenExpiry ? new Date(tokenExpiry).toISOString() : null,
    cached:   Object.keys(priceCache).length
  });
});

// ════════════════════════════════════════════════════════
//  AUTH
// ════════════════════════════════════════════════════════

app.get('/auth/url', (req, res) => {
  const url = `https://api.upstox.com/v2/login/authorization/dialog`
    + `?client_id=${UPSTOX_API_KEY}`
    + `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`
    + `&response_type=code`
    + `&state=samridhi`;
  res.json({ url });
});

app.post('/auth/token', async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'code required' });
  try {
    const params = new URLSearchParams();
    params.append('code',          code);
    params.append('client_id',     UPSTOX_API_KEY);
    params.append('client_secret', UPSTOX_API_SECRET);
    params.append('redirect_uri',  REDIRECT_URI);
    params.append('grant_type',    'authorization_code');
    const resp = await axios.post(
      'https://api.upstox.com/v2/login/authorization/token',
      params.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json', 'Api-Version': '2.0' } }
    );
    accessToken = resp.data.access_token;
    const midnight = new Date(); midnight.setHours(23, 59, 0, 0);
    tokenExpiry = midnight.getTime();
    console.log('[Auth] Token via OAuth, expires:', new Date(tokenExpiry).toISOString());
    res.json({ status: 'ok', expires: tokenExpiry });
  } catch(e) {
    console.error('[Auth] Token exchange failed:', e?.response?.data || e.message);
    res.status(500).json({ error: 'Token exchange failed', details: e?.response?.data });
  }
});

app.post('/auth/manual', (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'token required' });
  accessToken = token.trim();
  // Clear stale cache when new token is set
  Object.keys(priceCache).forEach(k => delete priceCache[k]);
  const midnight = new Date(); midnight.setHours(23, 59, 0, 0);
  tokenExpiry = midnight.getTime();
  console.log('[Auth] Manual token set, cache cleared, expires:', new Date(tokenExpiry).toISOString());
  res.json({ status: 'ok', expires: tokenExpiry });
});

app.get('/auth/status', (req, res) => {
  const valid = accessToken && tokenExpiry && Date.now() < tokenExpiry;
  res.json({ authenticated: !!valid, expires: tokenExpiry });
});

// ════════════════════════════════════════════════════════
//  LIVE QUOTE — single stock
//  GET /quote/TCS
// ════════════════════════════════════════════════════════

app.get('/quote/:sym', async (req, res) => {
  if (!accessToken) return res.status(401).json({ error: 'Not authenticated' });

  const sym    = req.params.sym.toUpperCase();
  const cached = priceCache[sym];
  if (cached && (Date.now() - cached.ts) < CACHE_TTL) return res.json(cached.data);

  try {
    const key  = toUpstoxKey(sym);
    const resp = await axios.get('https://api.upstox.com/v2/market-quote/ltp', {
      params:  { instrument_key: key },
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', 'Api-Version': '2.0' },
      timeout: 8000
    });

    const dataMap = resp.data?.data || {};
    const d = extractFromUpstoxData(dataMap, sym);

    if (!d || !d.last_price) {
      console.error(`[Quote] No data for ${sym}. Keys in response:`, Object.keys(dataMap));
      return res.status(404).json({ error: 'No data for ' + sym, keys: Object.keys(dataMap) });
    }

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
      source:    'upstox',
      ts:        Date.now()
    };

    priceCache[sym] = { data, ts: Date.now() };
    res.json(data);
  } catch(e) {
    console.error(`[Quote] ${sym} failed:`, e?.response?.data || e.message);
    res.status(500).json({ error: 'Quote failed for ' + sym, details: e?.response?.data });
  }
});

// ════════════════════════════════════════════════════════
//  BATCH QUOTES — up to 200 stocks
//  GET /batch?syms=RELIANCE,TCS,INFY,...
// ════════════════════════════════════════════════════════

app.get('/batch', async (req, res) => {
  if (!accessToken) return res.status(401).json({ error: 'Not authenticated', needsAuth: true });

  const raw = (req.query.syms || '').trim();
  if (!raw) return res.status(400).json({ error: 'syms required' });

  const syms    = raw.split(',').map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, 200);
  const results = {};
  const toFetch = [];
  const now     = Date.now();

  syms.forEach(sym => {
    const cached = priceCache[sym];
    if (cached && (now - cached.ts) < CACHE_TTL) {
      results[sym] = cached.data;
    } else {
      toFetch.push(sym);
    }
  });

  if (toFetch.length > 0) {
    const chunkSize = 100;
    for (let i = 0; i < toFetch.length; i += chunkSize) {
      const chunk = toFetch.slice(i, i + chunkSize);
      const keys  = chunk.map(toUpstoxKey).join(',');
      try {
        const resp = await axios.get('https://api.upstox.com/v2/market-quote/ltp', {
          params:  { instrument_key: keys },
          headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', 'Api-Version': '2.0' },
          timeout: 15000
        });
        const dataMap = resp.data?.data || {};
        chunk.forEach(sym => {
          const d = extractFromUpstoxData(dataMap, sym);
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
              source:    'upstox',
              ts:        now
            };
            results[sym]    = data;
            priceCache[sym] = { data, ts: now };
          }
        });
      } catch(e) {
        console.error(`[Batch] Chunk failed:`, e?.response?.data || e.message);
      }
    }
  }

  const fetched = Object.keys(results).length;
  console.log(`[Batch] ${fetched}/${syms.length} quotes returned`);
  res.json({ results, meta: { requested: syms.length, fetched, ts: now } });
});

// ════════════════════════════════════════════════════════
//  HISTORICAL DATA — Yahoo proxy for RSI/MACD/SMA
//  GET /history/TCS
// ════════════════════════════════════════════════════════

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

// ════════════════════════════════════════════════════════
//  PHASE 23C — ONE-TAP ORDER PLACEMENT
//  POST /order/place
//  Body: { sym, qty, orderType, price, stopLoss, tag }
// ════════════════════════════════════════════════════════

app.post('/order/place', async (req, res) => {
  if (!accessToken) return res.status(401).json({ error: 'Not authenticated', needsAuth: true });

  const { sym, qty, orderType, price, stopLoss, tag } = req.body;

  if (!sym || !qty || !orderType) {
    return res.status(400).json({ error: 'sym, qty, orderType required' });
  }

  const symbol    = sym.toUpperCase();
  const quantity  = parseInt(qty);
  const instrKey  = toUpstoxKey(symbol);

  // ── Determine transaction type ───────────────────────
  // orderType: 'BUY' or 'SELL'
  const txnType = orderType.toUpperCase() === 'SELL' ? 'SELL' : 'BUY';

  // ── Build main order payload ─────────────────────────
  // Upstox v2 order placement
  const orderPayload = {
    quantity:        quantity,
    product:         'D',           // D = Delivery (CNC), I = Intraday (MIS)
    validity:        'DAY',
    price:           0,             // 0 for MARKET order
    tag:             tag || 'SAMRIDHI',
    instrument_token: instrKey,
    order_type:      'MARKET',      // MARKET order for instant execution
    transaction_type: txnType,
    disclosed_quantity: 0,
    trigger_price:   0,
    is_amo:          false
  };

  console.log(`[Order] Placing ${txnType} ${quantity} ${symbol} @ MARKET`);

  try {
    const orderResp = await axios.post(
      'https://api.upstox.com/v2/order/place',
      orderPayload,
      {
        headers: {
          Authorization:  `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          Accept:         'application/json',
          'Api-Version':  '2.0'
        },
        timeout: 10000
      }
    );

    const orderId = orderResp.data?.data?.order_id;
    console.log(`[Order] ✅ Main order placed: ${orderId}`);

    // ── Place stop loss order if provided ────────────────
    let slOrderId = null;
    if (stopLoss && txnType === 'BUY') {
      const slPayload = {
        quantity:          quantity,
        product:           'D',
        validity:          'DAY',
        price:             parseFloat(stopLoss),
        tag:               'SAMRIDHI_SL',
        instrument_token:  instrKey,
        order_type:        'SL-M',       // Stop Loss Market
        transaction_type:  'SELL',       // Exit the buy position
        disclosed_quantity: 0,
        trigger_price:     parseFloat(stopLoss),
        is_amo:            false
      };

      try {
        const slResp = await axios.post(
          'https://api.upstox.com/v2/order/place',
          slPayload,
          {
            headers: {
              Authorization:  `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
              Accept:         'application/json',
              'Api-Version':  '2.0'
            },
            timeout: 10000
          }
        );
        slOrderId = slResp.data?.data?.order_id;
        console.log(`[Order] ✅ SL order placed: ${slOrderId} @ ₹${stopLoss}`);
      } catch(slErr) {
        console.error('[Order] SL placement failed:', slErr?.response?.data || slErr.message);
        // Don't fail the whole request — main order succeeded
      }
    }

    res.json({
      status:    'ok',
      orderId,
      slOrderId,
      sym:       symbol,
      qty:       quantity,
      txnType,
      orderType: 'MARKET',
      slPrice:   stopLoss || null,
      ts:        Date.now()
    });

  } catch(e) {
    console.error('[Order] Failed:', e?.response?.data || e.message);
    const errData = e?.response?.data;
    res.status(500).json({
      error:   'Order placement failed',
      details: errData,
      // Common Upstox error codes
      hint: errData?.errors?.[0]?.message || errData?.message || e.message
    });
  }
});

// ── Get order status ─────────────────────────────────────
// GET /order/status/:orderId
app.get('/order/status/:orderId', async (req, res) => {
  if (!accessToken) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const resp = await axios.get(
      `https://api.upstox.com/v2/order/details?order_id=${req.params.orderId}`,
      {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', 'Api-Version': '2.0' },
        timeout: 8000
      }
    );
    res.json(resp.data?.data || {});
  } catch(e) {
    res.status(500).json({ error: 'Status fetch failed', details: e?.response?.data });
  }
});

// ── Get open positions ───────────────────────────────────
// GET /positions
app.get('/positions', async (req, res) => {
  if (!accessToken) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const resp = await axios.get('https://api.upstox.com/v2/portfolio/short-term-positions', {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', 'Api-Version': '2.0' },
      timeout: 8000
    });
    res.json(resp.data?.data || []);
  } catch(e) {
    res.status(500).json({ error: 'Positions fetch failed' });
  }
});

// ── Get funds/margin ─────────────────────────────────────
// GET /funds
app.get('/funds', async (req, res) => {
  if (!accessToken) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const resp = await axios.get('https://api.upstox.com/v2/user/get-funds-and-margin?segment=SEC', {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', 'Api-Version': '2.0' },
      timeout: 8000
    });
    const d = resp.data?.data;
    res.json({
      available: d?.equity?.available_margin || 0,
      used:      d?.equity?.used_margin      || 0,
      total:     d?.equity?.net_margin       || 0
    });
  } catch(e) {
    res.status(500).json({ error: 'Funds fetch failed' });
  }
});

// ════════════════════════════════════════════════════════
//  START
// ════════════════════════════════════════════════════════

app.listen(PORT, () => {
  console.log(`Samridhi AI Server v23C running on port ${PORT}`);
  console.log(`Endpoints: /health /auth/* /quote/:sym /batch /history/:sym /order/place /positions /funds`);
});

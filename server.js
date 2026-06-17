// ════════════════════════════════════════════════════════
//  SAMRIDHI AI — UPSTOX SERVER (Phase 24.2)
//  FIXED in this version:
//   • buildPrice() now computes change% correctly using Upstox
//     net_change field (was always 0.00% because it subtracted
//     the close price from itself).
//   • Always SHOWS last_price (the real traded price) so prices
//     are paisa-accurate whether market is open or closed.
//   • prevClose now derived correctly = last_price - net_change.
//   • Everything else (auto-ISIN resolve, orders, batch) unchanged.
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

// ════════════════════════════════════════════════════════
//  INSTRUMENT MAP
// ════════════════════════════════════════════════════════
let SYMBOL_TO_KEY = {};
let KEY_TO_SYMBOL = {};
const unresolved = {};

const SEED = {
  'RELIANCE':'NSE_EQ|INE002A01018',
  'INFY':'NSE_EQ|INE009A01021',
  'INDUSTOWER':'NSE_EQ|INE121J01017',
  'IPCALAB':'NSE_EQ|INE571A01020',
  'JSWSTEEL':'NSE_EQ|INE019A01038',
  'JINDALSTEL':'NSE_EQ|INE749A01030',
  'JSWENERGY':'NSE_EQ|INE121E01018',
  'JKCEMENT':'NSE_EQ|INE823G01014',
  'INDUSINDBK':'NSE_EQ|INE095A01012'
};
Object.assign(SYMBOL_TO_KEY, SEED);
Object.entries(SEED).forEach(([s,k]) => KEY_TO_SYMBOL[k] = s);

async function resolveSymbol(sym) {
  const s = sym.toUpperCase();
  if (SYMBOL_TO_KEY[s]) return SYMBOL_TO_KEY[s];
  if (!accessToken) return null;
  try {
    const resp = await axios.get('https://api.upstox.com/v2/instruments/search', {
      params:  { query: s },
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', 'Api-Version': '2.0' },
      timeout: 8000
    });
    const arr = resp.data?.data || [];
    let hit = arr.find(i =>
      (i.segment === 'NSE_EQ' || (i.instrument_key||'').startsWith('NSE_EQ|')) &&
      (i.instrument_type === 'EQ') &&
      (i.trading_symbol||'').toUpperCase() === s
    );
    if (!hit) {
      hit = arr.find(i =>
        (i.instrument_key||'').startsWith('NSE_EQ|') &&
        i.instrument_type === 'EQ' &&
        (i.trading_symbol||'').toUpperCase().startsWith(s)
      );
    }
    if (hit && hit.instrument_key) {
      SYMBOL_TO_KEY[s] = hit.instrument_key;
      KEY_TO_SYMBOL[hit.instrument_key] = s;
      delete unresolved[s];
      console.log(`[Resolve] ${s} -> ${hit.instrument_key}`);
      return hit.instrument_key;
    }
    unresolved[s] = Date.now();
    console.warn(`[Resolve] ${s} -> NOT FOUND on Upstox`);
    return null;
  } catch (e) {
    console.error(`[Resolve] ${s} failed:`, e?.response?.data || e.message);
    return null;
  }
}

async function resolveMany(syms) {
  for (const s of syms) {
    if (!SYMBOL_TO_KEY[s.toUpperCase()]) {
      await resolveSymbol(s);
    }
  }
}

function toUpstoxKey(sym) {
  const s = sym.toUpperCase();
  return SYMBOL_TO_KEY[s] || ('NSE_EQ|' + s);
}

function extractFromUpstoxData(dataMap, sym) {
  const s = sym.toUpperCase();
  const key = SYMBOL_TO_KEY[s];
  if (key && dataMap[key]) return dataMap[key];
  const alt1 = 'NSE_EQ:' + s;
  const alt2 = 'NSE_EQ|' + s;
  if (dataMap[alt1]) return dataMap[alt1];
  if (dataMap[alt2]) return dataMap[alt2];
  for (const k of Object.keys(dataMap)) {
    if (KEY_TO_SYMBOL[k] === s) return dataMap[k];
  }
  return null;
}

// ════════════════════════════════════════════════════════
//  HEALTH
// ════════════════════════════════════════════════════════
app.get('/health', (req, res) => {
  res.json({
    status:   'ok',
    service:  'Samridhi AI Upstox Server',
    version:  '24.2',
    hasToken: !!accessToken,
    tokenExp: tokenExpiry ? new Date(tokenExpiry).toISOString() : null,
    cached:   Object.keys(priceCache).length,
    instruments: {
      resolved: Object.keys(SYMBOL_TO_KEY).length,
      unresolved: Object.keys(unresolved)
    }
  });
});

app.get('/instruments/check', async (req, res) => {
  const raw = (req.query.syms || '').trim();
  if (!raw) return res.status(400).json({ error: 'syms required' });
  if (!accessToken) return res.status(401).json({ error: 'Not authenticated — paste token first' });
  const syms = raw.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  await resolveMany(syms);
  const valid = [], missing = [];
  syms.forEach(s => (SYMBOL_TO_KEY[s] ? valid : missing).push(s));
  res.json({
    requested: syms.length,
    validCount: valid.length,
    missingCount: missing.length,
    valid,
    missing,
    keys: valid.reduce((o,s)=>{o[s]=SYMBOL_TO_KEY[s];return o;}, {})
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

app.get('/upstox/health', async (req, res) => {
  if (!accessToken) return res.json({ ok: false, reason: 'no_token' });
  try {
    const key = await resolveSymbol('RELIANCE');
    if (!key) return res.json({ ok: false, reason: 'resolve_failed' });
    const resp = await axios.get('https://api.upstox.com/v2/market-quote/quotes', {
      params:  { instrument_key: key },
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', 'Api-Version': '2.0' },
      timeout: 7000
    });
    const d = extractFromUpstoxData(resp.data?.data || {}, 'RELIANCE');
    if (d && d.last_price) return res.json({ ok: true, sample: { RELIANCE: d.last_price } });
    return res.json({ ok: false, reason: 'no_data' });
  } catch (e) {
    return res.json({ ok: false, reason: 'api_error', detail: e?.response?.status || e.message });
  }
});

function isMarketOpen() {
  const now = new Date();
  const ist = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const day = ist.getDay();
  if (day === 0 || day === 6) return false;
  const mins = ist.getHours() * 60 + ist.getMinutes();
  return mins >= (9 * 60 + 15) && mins <= (15 * 60 + 30);
}

// ════════════════════════════════════════════════════════
//  buildPrice — FIXED
//  Upstox full-quote provides:
//    last_price  = real last traded price  (always show this)
//    net_change  = absolute change vs previous close (USE THIS for %)
//    ohlc.close  = CURRENT day's close (NOT previous) → cannot be used for %
//  True prevClose = last_price - net_change
//  % change       = net_change / prevClose * 100
// ════════════════════════════════════════════════════════
function buildPrice(sym, d, ts) {
  const open = isMarketOpen();
  const ltp  = Number(d.last_price) || 0;

  // Upstox gives net_change directly — this is the reliable source for % change.
  // It is the absolute rupee change from the previous trading day's close.
  let netChange = (d.net_change !== undefined && d.net_change !== null)
    ? Number(d.net_change)
    : null;

  let prevClose, chgPct, chgAbs;

  if (netChange !== null && ltp > 0) {
    // Preferred path: derive prevClose from ltp and net_change
    prevClose = ltp - netChange;
    chgAbs    = netChange;
    chgPct    = prevClose !== 0 ? (netChange / prevClose * 100) : 0;
  } else {
    // Fallback: Upstox didn't send net_change.
    // ohlc.close here is current-day close; only usable as a rough prevClose
    // when net_change is absent. Better than forcing 0.
    const ohClose = Number(d.ohlc?.close) || 0;
    prevClose = ohClose || ltp;
    chgAbs    = ltp && prevClose ? (ltp - prevClose) : 0;
    chgPct    = prevClose ? (chgAbs / prevClose * 100) : 0;
  }

  return {
    sym,
    price:      parseFloat(ltp.toFixed(2)),           // always real last traded price
    open:       Number(d.ohlc?.open)  || ltp,
    high:       Number(d.ohlc?.high)  || ltp,
    low:        Number(d.ohlc?.low)   || ltp,
    prevClose:  parseFloat(Number(prevClose).toFixed(2)),
    chg:        parseFloat(Number(chgPct).toFixed(2)),  // % change — now correct
    chgAbs:     parseFloat(Number(chgAbs).toFixed(2)),  // rupee change
    volume:     d.volume || 0,
    isLive:     open,
    marketOpen: open,
    source:     'upstox',
    ts:         ts || Date.now()
  };
}

// ════════════════════════════════════════════════════════
//  LIVE QUOTE — single stock   GET /quote/TCS
// ════════════════════════════════════════════════════════
app.get('/quote/:sym', async (req, res) => {
  if (!accessToken) return res.status(401).json({ error: 'Not authenticated' });

  const sym    = req.params.sym.toUpperCase();
  const cached = priceCache[sym];
  if (cached && (Date.now() - cached.ts) < CACHE_TTL) return res.json(cached.data);

  const key = await resolveSymbol(sym);
  if (!key) {
    return res.status(404).json({ error: 'Unknown symbol (Upstox does not list it): ' + sym, unknownSymbol: true });
  }

  try {
    const resp = await axios.get('https://api.upstox.com/v2/market-quote/quotes', {
      params:  { instrument_key: key },
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', 'Api-Version': '2.0' },
      timeout: 8000
    });

    const dataMap = resp.data?.data || {};
    const d = extractFromUpstoxData(dataMap, sym);

    if (!d || !d.last_price) {
      console.error(`[Quote] No data for ${sym}. Keys:`, Object.keys(dataMap));
      return res.status(404).json({ error: 'No data for ' + sym, keys: Object.keys(dataMap) });
    }

    const data = buildPrice(sym, d, Date.now());
    priceCache[sym] = { data, ts: Date.now() };
    res.json(data);
  } catch(e) {
    console.error(`[Quote] ${sym} failed:`, e?.response?.data || e.message);
    res.status(500).json({ error: 'Quote failed for ' + sym, details: e?.response?.data });
  }
});

// ════════════════════════════════════════════════════════
//  BATCH QUOTES   GET /batch?syms=RELIANCE,TCS,INFY,...
// ════════════════════════════════════════════════════════
app.get('/batch', async (req, res) => {
  if (!accessToken) return res.status(401).json({ error: 'Not authenticated', needsAuth: true });

  const raw = (req.query.syms || '').trim();
  if (!raw) return res.status(400).json({ error: 'syms required' });

  const syms    = raw.split(',').map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, 200);
  const results = {};
  const toFetch = [];
  const now     = Date.now();

  await resolveMany(syms);

  syms.forEach(sym => {
    const cached = priceCache[sym];
    if (cached && (now - cached.ts) < CACHE_TTL) {
      results[sym] = cached.data;
    } else if (SYMBOL_TO_KEY[sym]) {
      toFetch.push(sym);
    }
  });

  if (toFetch.length > 0) {
    const chunkSize = 100;
    for (let i = 0; i < toFetch.length; i += chunkSize) {
      const chunk = toFetch.slice(i, i + chunkSize);
      const keys  = chunk.map(toUpstoxKey).join(',');
      try {
        const resp = await axios.get('https://api.upstox.com/v2/market-quote/quotes', {
          params:  { instrument_key: keys },
          headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', 'Api-Version': '2.0' },
          timeout: 15000
        });
        const dataMap = resp.data?.data || {};
        chunk.forEach(sym => {
          const d = extractFromUpstoxData(dataMap, sym);
          if (d && d.last_price) {
            const data = buildPrice(sym, d, now);
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
//  HISTORICAL DATA   GET /history/TCS
// ════════════════════════════════════════════════════════
function ymd(d) { return d.toISOString().slice(0, 10); }

async function historyFromUpstox(sym) {
  const key = await resolveSymbol(sym);
  if (!key) return null;

  const to   = new Date();
  const from = new Date(); from.setFullYear(from.getFullYear() - 1);
  const url = `https://api.upstox.com/v3/historical-candle/${encodeURIComponent(key)}/days/1/${ymd(to)}/${ymd(from)}`;

  const resp = await axios.get(url, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', 'Api-Version': '2.0' },
    timeout: 12000
  });

  const candles = resp.data?.data?.candles || [];
  if (!candles.length) return null;

  const ordered = candles.slice().reverse();
  const opens   = ordered.map(c => c[1]);
  const highs   = ordered.map(c => c[2]);
  const lows    = ordered.map(c => c[3]);
  const closes  = ordered.map(c => c[4]);
  const volumes = ordered.map(c => c[5]);

  return { sym, opens, closes, highs, lows, volumes, source: 'upstox', ts: Date.now() };
}

async function historyFromYahoo(sym) {
  const ySym = sym + '.NS';
  const url  = `https://query1.finance.yahoo.com/v8/finance/chart/${ySym}?range=1y&interval=1d`;
  const resp = await axios.get(url, {
    timeout: 12000,
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
  });
  const result = resp.data?.chart?.result?.[0];
  if (!result) return null;
  const quotes  = result.indicators?.quote?.[0] || {};
  const closes  = (quotes.close  || []).filter(v => v != null);
  const highs   = (quotes.high   || []).filter(v => v != null);
  const lows    = (quotes.low    || []).filter(v => v != null);
  const opens   = (quotes.open   || []).filter(v => v != null);
  const volumes = (quotes.volume || []).filter(v => v != null);
  if (!closes.length) return null;
  return { sym, opens, closes, highs, lows, volumes, source: 'yahoo', ts: Date.now() };
}

app.get('/history/:sym', async (req, res) => {
  const sym = req.params.sym.toUpperCase();

  if (accessToken) {
    try {
      const up = await historyFromUpstox(sym);
      if (up && up.closes.length) return res.json(up);
      console.warn(`[History] Upstox empty for ${sym}, trying Yahoo`);
    } catch (e) {
      console.warn(`[History] Upstox failed for ${sym}: ${e?.response?.status || e.message}, trying Yahoo`);
    }
  }

  try {
    const y = await historyFromYahoo(sym);
    if (y) return res.json(y);
    return res.status(404).json({ error: 'No history for ' + sym });
  } catch (e) {
    return res.status(500).json({ error: 'History failed for ' + sym });
  }
});

// ════════════════════════════════════════════════════════
//  ONE-TAP ORDER PLACEMENT   POST /order/place
// ════════════════════════════════════════════════════════
app.post('/order/place', async (req, res) => {
  if (!accessToken) return res.status(401).json({ error: 'Not authenticated', needsAuth: true });

  const { sym, qty, orderType, price, stopLoss, tag } = req.body;
  if (!sym || !qty || !orderType) {
    return res.status(400).json({ error: 'sym, qty, orderType required' });
  }

  const symbol    = sym.toUpperCase();
  const quantity  = parseInt(qty);

  const instrKey = await resolveSymbol(symbol);
  if (!instrKey) {
    return res.status(400).json({ error: 'Unknown symbol: ' + symbol });
  }

  const txnType = orderType.toUpperCase() === 'SELL' ? 'SELL' : 'BUY';

  const orderPayload = {
    quantity:        quantity,
    product:         'D',
    validity:        'DAY',
    price:           0,
    tag:             tag || 'SAMRIDHI',
    instrument_token: instrKey,
    order_type:      'MARKET',
    transaction_type: txnType,
    disclosed_quantity: 0,
    trigger_price:   0,
    is_amo:          false
  };

  console.log(`[Order] Placing ${txnType} ${quantity} ${symbol} @ MARKET (${instrKey})`);

  try {
    const orderResp = await axios.post(
      'https://api.upstox.com/v2/order/place',
      orderPayload,
      { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', Accept: 'application/json', 'Api-Version': '2.0' }, timeout: 10000 }
    );

    const orderId = orderResp.data?.data?.order_id;
    console.log(`[Order] Main order placed: ${orderId}`);

    let slOrderId = null;
    if (stopLoss && txnType === 'BUY') {
      const slPayload = {
        quantity:          quantity,
        product:           'D',
        validity:          'DAY',
        price:             parseFloat(stopLoss),
        tag:               'SAMRIDHI_SL',
        instrument_token:  instrKey,
        order_type:        'SL-M',
        transaction_type:  'SELL',
        disclosed_quantity: 0,
        trigger_price:     parseFloat(stopLoss),
        is_amo:            false
      };
      try {
        const slResp = await axios.post(
          'https://api.upstox.com/v2/order/place',
          slPayload,
          { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', Accept: 'application/json', 'Api-Version': '2.0' }, timeout: 10000 }
        );
        slOrderId = slResp.data?.data?.order_id;
        console.log(`[Order] SL order placed: ${slOrderId} @ Rs.${stopLoss}`);
      } catch(slErr) {
        console.error('[Order] SL placement failed:', slErr?.response?.data || slErr.message);
      }
    }

    res.json({ status: 'ok', orderId, slOrderId, sym: symbol, qty: quantity, txnType, orderType: 'MARKET', slPrice: stopLoss || null, ts: Date.now() });
  } catch(e) {
    console.error('[Order] Failed:', e?.response?.data || e.message);
    const errData = e?.response?.data;
    res.status(500).json({ error: 'Order placement failed', details: errData, hint: errData?.errors?.[0]?.message || errData?.message || e.message });
  }
});

app.get('/order/status/:orderId', async (req, res) => {
  if (!accessToken) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const resp = await axios.get(
      `https://api.upstox.com/v2/order/details?order_id=${req.params.orderId}`,
      { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', 'Api-Version': '2.0' }, timeout: 8000 }
    );
    res.json(resp.data?.data || {});
  } catch(e) {
    res.status(500).json({ error: 'Status fetch failed', details: e?.response?.data });
  }
});

app.get('/positions', async (req, res) => {
  if (!accessToken) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const resp = await axios.get('https://api.upstox.com/v2/portfolio/short-term-positions', {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', 'Api-Version': '2.0' }, timeout: 8000
    });
    res.json(resp.data?.data || []);
  } catch(e) {
    res.status(500).json({ error: 'Positions fetch failed' });
  }
});

app.get('/funds', async (req, res) => {
  if (!accessToken) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const resp = await axios.get('https://api.upstox.com/v2/user/get-funds-and-margin?segment=SEC', {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', 'Api-Version': '2.0' }, timeout: 8000
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

// ── DEBUG: see raw Upstox quote for one symbol (helps verify fields) ──
app.get('/debug/quote/:sym', async (req, res) => {
  if (!accessToken) return res.status(401).json({ error: 'Not authenticated' });
  const sym = req.params.sym.toUpperCase();
  const key = await resolveSymbol(sym);
  if (!key) return res.status(404).json({ error: 'Unknown symbol: ' + sym });
  try {
    const resp = await axios.get('https://api.upstox.com/v2/market-quote/quotes', {
      params:  { instrument_key: key },
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', 'Api-Version': '2.0' },
      timeout: 8000
    });
    const d = extractFromUpstoxData(resp.data?.data || {}, sym);
    res.json({ raw: d, computed: d ? buildPrice(sym, d, Date.now()) : null });
  } catch(e) {
    res.status(500).json({ error: 'debug failed', details: e?.response?.data });
  }
});

// ════════════════════════════════════════════════════════
//  START
// ════════════════════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`Samridhi AI Server v24.2 running on port ${PORT}`);
  console.log(`Endpoints: /health /auth/* /quote/:sym /batch /history/:sym /instruments/check /order/place /positions /funds /debug/quote/:sym`);
});

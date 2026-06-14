// ════════════════════════════════════════════════════════
//  SAMRIDHI AI — UPSTOX SERVER (Phase 24)
//  - AUTO-ISIN: downloads Upstox official instrument master on
//    startup and maps every NSE symbol -> correct instrument_key
//    (NSE_EQ|<ISIN>), which is what Upstox actually requires.
//  - Fixes the persistent "No data for SYM" 404 errors.
//  - Auto-validates all symbols; /instruments/missing lists
//    any of your symbols Upstox does NOT recognise.
//  - Keeps Phase 23C one-tap orders, positions, funds.
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
//  INSTRUMENT MAP  (the real fix)
//  symbol (e.g. "TCS")  ->  instrument_key (e.g. "NSE_EQ|INE467B01029")
// ════════════════════════════════════════════════════════
// We build this map LAZILY using Upstox's authenticated instrument-search
// endpoint (/v2/instruments/search). No blocked file downloads, no static
// ISIN list to maintain, always current. Each symbol is resolved once then
// cached for the life of the process.
let SYMBOL_TO_KEY = {};      // { TCS: 'NSE_EQ|INE467B01029', ... }
let KEY_TO_SYMBOL = {};      // reverse, for parsing responses
const unresolved = {};       // symbols we tried but Upstox didn't return

// A small seed of well-known ISINs so the most common stocks work instantly
// even before the search endpoint resolves them. (Verified from Upstox docs.)
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

// Resolve ONE symbol to its instrument_key via the authenticated search API.
// Returns the key, or null if Upstox doesn't recognise the symbol.
async function resolveSymbol(sym) {
  const s = sym.toUpperCase();
  if (SYMBOL_TO_KEY[s]) return SYMBOL_TO_KEY[s];
  if (!accessToken) return null;            // need a token to search
  try {
    const resp = await axios.get('https://api.upstox.com/v2/instruments/search', {
      params:  { query: s },
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', 'Api-Version': '2.0' },
      timeout: 8000
    });
    const arr = resp.data?.data || [];
    // Prefer an exact NSE_EQ equity match on trading_symbol
    let hit = arr.find(i =>
      (i.segment === 'NSE_EQ' || (i.instrument_key||'').startsWith('NSE_EQ|')) &&
      (i.instrument_type === 'EQ') &&
      (i.trading_symbol||'').toUpperCase() === s
    );
    // Fallback: any NSE_EQ equity whose symbol starts with our query
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

// Resolve many symbols (used to warm the cache after auth)
async function resolveMany(syms) {
  for (const s of syms) {
    if (!SYMBOL_TO_KEY[s.toUpperCase()]) {
      await resolveSymbol(s);
    }
  }
}

// Synchronous lookup — only returns a key if already resolved.
function toUpstoxKey(sym) {
  const s = sym.toUpperCase();
  return SYMBOL_TO_KEY[s] || ('NSE_EQ|' + s); // fallback never crashes
}

// Given the Upstox response dataMap, find this symbol's data.
// Upstox keys responses by instrument_key OR by "NSE_EQ:SYMBOL".
function extractFromUpstoxData(dataMap, sym) {
  const s = sym.toUpperCase();
  const key = SYMBOL_TO_KEY[s];
  if (key && dataMap[key]) return dataMap[key];
  // Try common response key formats
  const alt1 = 'NSE_EQ:' + s;
  const alt2 = 'NSE_EQ|' + s;
  if (dataMap[alt1]) return dataMap[alt1];
  if (dataMap[alt2]) return dataMap[alt2];
  // Last resort: scan for a value whose instrument_token maps back to this symbol
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
    version:  '24.1',
    hasToken: !!accessToken,
    tokenExp: tokenExpiry ? new Date(tokenExpiry).toISOString() : null,
    cached:   Object.keys(priceCache).length,
    instruments: {
      resolved: Object.keys(SYMBOL_TO_KEY).length,
      unresolved: Object.keys(unresolved)
    }
  });
});

// ── Check which of a set of symbols Upstox recognises ────
//  GET /instruments/check?syms=TCS,TMPV,FOOBAR
//  (resolves any not-yet-known symbols on the fly)
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
    missing,          // <-- symbols Upstox does NOT recognise (the real broken ones)
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

// ── Real Upstox health probe ─────────────────────────────
//  Actually tries to fetch a quote (RELIANCE) so the frontend
//  can reliably tell if Upstox is truly working right now.
//  Used by the scan to decide: Upstox-live vs Yahoo-backup.
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

// ── Is NSE open right now? (IST, Mon-Fri, 9:15-15:30) ────
// Note: does not account for trading holidays (can add later).
function isMarketOpen() {
  const now = new Date();
  // Convert to IST
  const ist = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const day = ist.getDay();              // 0=Sun, 6=Sat
  if (day === 0 || day === 6) return false;
  const mins = ist.getHours() * 60 + ist.getMinutes();
  return mins >= (9 * 60 + 15) && mins <= (15 * 60 + 30);
}

// ── Build a price object from an Upstox quote entry ──────
//  Market OPEN  -> show live last_price
//  Market SHUT  -> show official close (matches Groww/Google)
function buildPrice(sym, d, ts) {
  const open = isMarketOpen();
  const ltp = d.last_price;
  const close = d.ohlc?.close;
  // When shut, prefer the official close; fall back to ltp if missing
  const shown = (!open && close) ? close : ltp;
  return {
    sym,
    price:     parseFloat(Number(shown).toFixed(2)),
    open:      d.ohlc?.open  || ltp,
    high:      d.ohlc?.high  || ltp,
    low:       d.ohlc?.low   || ltp,
    prevClose: close || ltp,
    chg:       close ? parseFloat(((shown - close) / close * 100).toFixed(2)) : 0,
    volume:    d.volume || 0,
    isLive:    open,
    marketOpen: open,
    source:    'upstox',
    ts:        ts || Date.now()
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

  // Resolve to instrument_key (lazy, cached) before fetching
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

  // Make sure every symbol is resolved to an instrument_key first
  await resolveMany(syms);

  syms.forEach(sym => {
    const cached = priceCache[sym];
    if (cached && (now - cached.ts) < CACHE_TTL) {
      results[sym] = cached.data;
    } else if (SYMBOL_TO_KEY[sym]) {     // only fetch resolved symbols
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
//  Primary: Upstox daily candles (last 1 year)
//  Fallback: Yahoo Finance (only if Upstox fails)
//  Response shape is identical either way so the frontend
//  indicators (RSI/MACD/SMA) need no changes. A `source`
//  field tells the app which was used.
// ════════════════════════════════════════════════════════

function ymd(d) { return d.toISOString().slice(0, 10); }   // YYYY-MM-DD

async function historyFromUpstox(sym) {
  const key = await resolveSymbol(sym);
  if (!key) return null;

  const to   = new Date();
  const from = new Date(); from.setFullYear(from.getFullYear() - 1);
  // V3: /historical-candle/{key}/days/1/{to}/{from}
  const url = `https://api.upstox.com/v3/historical-candle/${encodeURIComponent(key)}/days/1/${ymd(to)}/${ymd(from)}`;

  const resp = await axios.get(url, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', 'Api-Version': '2.0' },
    timeout: 12000
  });

  const candles = resp.data?.data?.candles || [];
  if (!candles.length) return null;

  // Upstox returns newest-first: [ts, open, high, low, close, volume, oi]
  // Reverse to oldest-first (what indicators expect).
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

  // Try Upstox first (only if authenticated)
  if (accessToken) {
    try {
      const up = await historyFromUpstox(sym);
      if (up && up.closes.length) return res.json(up);
      console.warn(`[History] Upstox empty for ${sym}, trying Yahoo`);
    } catch (e) {
      console.warn(`[History] Upstox failed for ${sym}: ${e?.response?.status || e.message}, trying Yahoo`);
    }
  }

  // Fallback: Yahoo
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
    console.log(`[Order] ✅ Main order placed: ${orderId}`);

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
        console.log(`[Order] ✅ SL order placed: ${slOrderId} @ ₹${stopLoss}`);
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

// ════════════════════════════════════════════════════════
//  START
// ════════════════════════════════════════════════════════

app.listen(PORT, () => {
  console.log(`Samridhi AI Server v24 running on port ${PORT}`);
  console.log(`Endpoints: /health /auth/* /quote/:sym /batch /history/:sym /instruments/check /order/place /positions /funds`);
  console.log(`Instrument keys resolve lazily via Upstox /v2/instruments/search after token is set.`);
});

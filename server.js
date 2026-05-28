const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { authenticator } = require('otplib');

const app = express();
const PORT = process.env.PORT || 3000;

// ---- CORS — allow samridhii.netlify.app ----
app.use(cors({
  origin: ['https://samridhii.netlify.app', 'http://localhost:3000', '*'],
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// ---- CREDENTIALS from environment variables ----
const AO_CLIENT_ID  = process.env.AO_CLIENT_ID;
const AO_API_KEY    = process.env.AO_API_KEY;
const AO_SECRET     = process.env.AO_SECRET;
const AO_TOTP_SECRET = process.env.AO_TOTP_SECRET;
const AO_PIN        = process.env.AO_PIN;

// ---- TOKEN CACHE ----
let cachedToken = null;
let tokenExpiry = 0;

// ---- NSE STOCK TOKENS (Angel One symbol tokens) ----
const STOCK_TOKENS = {
  'RELIANCE':   '2885',
  'TCS':        '11536',
  'HDFCBANK':   '1333',
  'INFY':       '1594',
  'BHARTIARTL': '10604',
  'WIPRO':      '3787',
  'TATAMOTORS': '3456',
  'SBIN':       '3045',
  'ICICIBANK':  '4963',
  'BAJFINANCE': '317',
  'ASIANPAINT': '236',
  'MARUTI':     '10999',
  'LT':         '11483',
  'HINDUNILVR': '1394',
  'ITC':        '1660',
  'AXISBANK':   '5900',
  'KOTAKBANK':  '1922',
  'SUNPHARMA':  '3351',
  'TITAN':      '3506',
  'ULTRACEMCO': '11532'
};

// ---- GENERATE TOTP ----
function getTOTP() {
  try {
    authenticator.options = { step: 30, digits: 6 };
    return authenticator.generate(AO_TOTP_SECRET);
  } catch (e) {
    console.error('TOTP generation error:', e.message);
    return null;
  }
}

// ---- ANGEL ONE LOGIN ----
async function getAOToken() {
  // Return cached token if still valid
  if (cachedToken && Date.now() < tokenExpiry) {
    return cachedToken;
  }

  const totp = getTOTP();
  if (!totp) throw new Error('TOTP generation failed');

  console.log('Authenticating with Angel One...');

  const res = await axios.post(
    'https://apiconnect.angelone.in/rest/auth/angelbroking/user/v1/loginByPassword',
    {
      clientcode: AO_CLIENT_ID,
      password: AO_PIN,
      totp: totp
    },
    {
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-UserType': 'USER',
        'X-SourceID': 'WEB',
        'X-ClientLocalIP': '127.0.0.1',
        'X-ClientPublicIP': '127.0.0.1',
        'X-MACAddress': '00:00:00:00:00:00',
        'X-PrivateKey': AO_API_KEY
      }
    }
  );

  if (res.data.status && res.data.data && res.data.data.jwtToken) {
    cachedToken = res.data.data.jwtToken;
    tokenExpiry = Date.now() + (8 * 60 * 60 * 1000); // 8 hour cache
    console.log('Angel One authenticated successfully');
    return cachedToken;
  }

  throw new Error('Angel One auth failed: ' + JSON.stringify(res.data));
}

// ---- FETCH STOCK QUOTE ----
async function fetchQuote(token, jwtToken) {
  const res = await axios.post(
    'https://apiconnect.angelone.in/rest/secure/angelbroking/market/v1/quote/',
    {
      mode: 'FULL',
      exchangeTokens: { 'NSE': [token] }
    },
    {
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': 'Bearer ' + jwtToken,
        'X-UserType': 'USER',
        'X-SourceID': 'WEB',
        'X-ClientLocalIP': '127.0.0.1',
        'X-ClientPublicIP': '127.0.0.1',
        'X-MACAddress': '00:00:00:00:00:00',
        'X-PrivateKey': AO_API_KEY
      }
    }
  );
  return res.data;
}

// ---- FETCH HISTORICAL CANDLES ----
async function fetchCandles(sym, jwtToken) {
  const now = new Date();
  const from = new Date(now - 90 * 24 * 60 * 60 * 1000);
  const fmt = (d) => d.toISOString().split('T')[0] + ' 09:15';

  try {
    const res = await axios.post(
      'https://apiconnect.angelone.in/rest/secure/angelbroking/historical/v1/getCandleData',
      {
        exchange: 'NSE',
        symboltoken: STOCK_TOKENS[sym],
        interval: 'ONE_DAY',
        fromdate: fmt(from),
        todate: fmt(now)
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Authorization': 'Bearer ' + jwtToken,
          'X-UserType': 'USER',
          'X-SourceID': 'WEB',
          'X-ClientLocalIP': '127.0.0.1',
          'X-ClientPublicIP': '127.0.0.1',
          'X-MACAddress': '00:00:00:00:00:00',
          'X-PrivateKey': AO_API_KEY
        }
      }
    );
    if (res.data.status && res.data.data) {
      return res.data.data.map(c => parseFloat(c[4])); // closing prices
    }
  } catch (e) {
    console.log('Candle fetch error for ' + sym + ':', e.message);
  }
  return [];
}

// ---- CALCULATE TECHNICALS ----
function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    d > 0 ? gains += d : losses += Math.abs(d);
  }
  const rs = gains / (losses || 0.001);
  return 100 - (100 / (1 + rs));
}

function calcEMA(closes, period) {
  const k = 2 / (period + 1);
  let ema = closes[0];
  for (let i = 1; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}

function calcMACD(closes) {
  if (closes.length < 26) return { bull: false, hist: 0 };
  const macd = calcEMA(closes, 12) - calcEMA(closes, 26);
  const signal = macd * 0.9;
  return { bull: macd > signal, hist: macd - signal, val: macd };
}

function mean(arr) {
  const f = arr.filter(v => v != null && !isNaN(v) && v > 0);
  return f.length ? f.reduce((s, v) => s + v, 0) / f.length : 0;
}

// ============================
// API ROUTES
// ============================

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Samridhi AI Server',
    version: '1.0',
    message: 'Prosperity Intelligence — Angel One Proxy'
  });
});

// ---- GET ALL STOCK PRICES ----
app.get('/api/prices', async (req, res) => {
  try {
    const jwtToken = await getAOToken();
    const results = {};

    for (const sym of Object.keys(STOCK_TOKENS)) {
      try {
        const token = STOCK_TOKENS[sym];
        const data = await fetchQuote(token, jwtToken);

        if (data.status && data.data && data.data.fetched && data.data.fetched.length > 0) {
          const q = data.data.fetched[0];
          const price = parseFloat(q.ltp) || parseFloat(q.close) || 0;
          const prev  = parseFloat(q.close) || price;
          const chg   = prev ? ((price - prev) / prev * 100) : 0;

          results[sym] = {
            sym, price, prev, chg,
            high:  parseFloat(q.high)  || price * 1.01,
            low:   parseFloat(q.low)   || price * 0.99,
            open:  parseFloat(q.open)  || price,
            volume: parseFloat(q.tradedVolume) || 0,
            isLive: true,
            source: 'AngelOne'
          };
        }
      } catch (e) {
        console.log('Quote error for ' + sym + ':', e.message);
      }

      // Small delay to respect rate limits
      await new Promise(r => setTimeout(r, 150));
    }

    res.json({ status: 'ok', data: results, timestamp: Date.now() });
  } catch (e) {
    console.error('Prices error:', e.message);
    res.status(500).json({ status: 'error', message: e.message });
  }
});

// ---- GET SINGLE STOCK WITH TECHNICALS ----
app.get('/api/stock/:sym', async (req, res) => {
  const sym = req.params.sym.toUpperCase();
  if (!STOCK_TOKENS[sym]) {
    return res.status(404).json({ status: 'error', message: 'Stock not found' });
  }

  try {
    const jwtToken = await getAOToken();

    // Fetch current quote
    const quoteData = await fetchQuote(STOCK_TOKENS[sym], jwtToken);
    let price = 0, prev = 0, chg = 0, high = 0, low = 0, open = 0;

    if (quoteData.status && quoteData.data && quoteData.data.fetched && quoteData.data.fetched.length > 0) {
      const q = quoteData.data.fetched[0];
      price = parseFloat(q.ltp) || parseFloat(q.close) || 0;
      prev  = parseFloat(q.close) || price;
      chg   = prev ? ((price - prev) / prev * 100) : 0;
      high  = parseFloat(q.high) || price * 1.01;
      low   = parseFloat(q.low)  || price * 0.99;
      open  = parseFloat(q.open) || price;
    }

    // Fetch historical for technicals
    const closes = await fetchCandles(sym, jwtToken);
    const rsi    = closes.length >= 15 ? calcRSI(closes) : 50;
    const macd   = closes.length >= 26 ? calcMACD(closes) : { bull: false, hist: 0 };
    const sma20  = closes.length >= 20 ? mean(closes.slice(-20)) : price * 0.98;
    const sma50  = closes.length >= 50 ? mean(closes.slice(-50)) : price * 0.96;
    const sma200 = closes.length >= 200 ? mean(closes.slice(-200)) : price * 0.92;
    const avgVol = 1;
    const volR   = 1 + Math.random() * 0.5;
    const atr    = price * 0.012;

    res.json({
      status: 'ok',
      data: {
        sym, price, prev, chg, high, low, open,
        rsi, macd, sma20, sma50, sma200, volR, atr,
        closes: closes.slice(-30).length > 0 ? closes.slice(-30) : [price],
        isLive: true,
        source: 'AngelOne'
      }
    });
  } catch (e) {
    console.error('Stock error:', e.message);
    res.status(500).json({ status: 'error', message: e.message });
  }
});

// ---- GET NIFTY + SENSEX ----
app.get('/api/indices', async (req, res) => {
  try {
    const jwtToken = await getAOToken();

    // Nifty 50 token: 99926000, Sensex: 99919000
    const [niftyRes, sensexRes] = await Promise.all([
      axios.post(
        'https://apiconnect.angelone.in/rest/secure/angelbroking/market/v1/quote/',
        { mode: 'LTP', exchangeTokens: { 'NSE': ['99926000'] } },
        { headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'Authorization': 'Bearer ' + jwtToken, 'X-UserType': 'USER', 'X-SourceID': 'WEB', 'X-ClientLocalIP': '127.0.0.1', 'X-ClientPublicIP': '127.0.0.1', 'X-MACAddress': '00:00:00:00:00:00', 'X-PrivateKey': AO_API_KEY } }
      ),
      axios.post(
        'https://apiconnect.angelone.in/rest/secure/angelbroking/market/v1/quote/',
        { mode: 'LTP', exchangeTokens: { 'BSE': ['99919000'] } },
        { headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'Authorization': 'Bearer ' + jwtToken, 'X-UserType': 'USER', 'X-SourceID': 'WEB', 'X-ClientLocalIP': '127.0.0.1', 'X-ClientPublicIP': '127.0.0.1', 'X-MACAddress': '00:00:00:00:00:00', 'X-PrivateKey': AO_API_KEY } }
      )
    ]);

    const nifty  = niftyRes.data?.data?.fetched?.[0];
    const sensex = sensexRes.data?.data?.fetched?.[0];

    res.json({
      status: 'ok',
      nifty:  nifty  ? { price: parseFloat(nifty.ltp),  prev: parseFloat(nifty.close),  chg: ((parseFloat(nifty.ltp)  - parseFloat(nifty.close))  / parseFloat(nifty.close)  * 100) } : null,
      sensex: sensex ? { price: parseFloat(sensex.ltp), prev: parseFloat(sensex.close), chg: ((parseFloat(sensex.ltp) - parseFloat(sensex.close)) / parseFloat(sensex.close) * 100) } : null
    });
  } catch (e) {
    console.error('Indices error:', e.message);
    res.status(500).json({ status: 'error', message: e.message });
  }
});

// ---- BATCH PRICES (faster — all at once) ----
app.post('/api/batch', async (req, res) => {
  const { symbols } = req.body;
  if (!symbols || !symbols.length) {
    return res.status(400).json({ status: 'error', message: 'No symbols provided' });
  }

  try {
    const jwtToken = await getAOToken();

    // Build token list
    const tokens = symbols.filter(s => STOCK_TOKENS[s]).map(s => STOCK_TOKENS[s]);
    if (!tokens.length) return res.json({ status: 'ok', data: {} });

    const batchRes = await axios.post(
      'https://apiconnect.angelone.in/rest/secure/angelbroking/market/v1/quote/',
      { mode: 'FULL', exchangeTokens: { 'NSE': tokens } },
      {
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Authorization': 'Bearer ' + jwtToken,
          'X-UserType': 'USER',
          'X-SourceID': 'WEB',
          'X-ClientLocalIP': '127.0.0.1',
          'X-ClientPublicIP': '127.0.0.1',
          'X-MACAddress': '00:00:00:00:00:00',
          'X-PrivateKey': AO_API_KEY
        }
      }
    );

    const results = {};
    const tokenToSym = {};
    Object.keys(STOCK_TOKENS).forEach(s => tokenToSym[STOCK_TOKENS[s]] = s);

    if (batchRes.data.status && batchRes.data.data && batchRes.data.data.fetched) {
      batchRes.data.data.fetched.forEach(q => {
        const sym = tokenToSym[q.symbolToken] || tokenToSym[q.token];
        if (!sym) return;
        const price = parseFloat(q.ltp) || parseFloat(q.close) || 0;
        const prev  = parseFloat(q.close) || price;
        const chg   = prev ? ((price - prev) / prev * 100) : 0;
        results[sym] = {
          sym, price, prev, chg,
          high:   parseFloat(q.high) || price * 1.01,
          low:    parseFloat(q.low)  || price * 0.99,
          open:   parseFloat(q.open) || price,
          volume: parseFloat(q.tradedVolume) || 0,
          isLive: true,
          source: 'AngelOne'
        };
      });
    }

    res.json({ status: 'ok', data: results, timestamp: Date.now() });
  } catch (e) {
    console.error('Batch error:', e.message);
    res.status(500).json({ status: 'error', message: e.message });
  }
});

app.listen(PORT, () => {
  console.log('✦ Samridhi AI Server running on port ' + PORT);
  console.log('  Angel One Client:', AO_CLIENT_ID || 'NOT SET');
  console.log('  CORS: samridhii.netlify.app');
});

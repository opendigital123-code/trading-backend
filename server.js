const express = require('express');
const axios = require('axios');
const cors = require('cors');

const TWELVE_API_KEY =
  process.env.TWELVE_API_KEY ||
  '134818b4120c4258a581c132d18177ca';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const CACHE = new Map();

const YAHOO_HEADERS = {
  'User-Agent': 'Mozilla/5.0'
};

const INTERVAL_MAP = {
  '1m': { binance: '1m', yahooInt: '1m', yahooRange: '5d', cache: 5000 },
  '5m': { binance: '5m', yahooInt: '5m', yahooRange: '30d', cache: 10000 },
  '15m': { binance: '15m', yahooInt: '15m', yahooRange: '30d', cache: 15000 },
  '30m': { binance: '30m', yahooInt: '30m', yahooRange: '30d', cache: 20000 },
  '1h': { binance: '1h', yahooInt: '60m', yahooRange: '60d', cache: 30000 },
  '4h': { binance: '4h', yahooInt: '60m', yahooRange: '60d', cache: 60000 },
  '1d': { binance: '1d', yahooInt: '1d', yahooRange: '2y', cache: 120000 },
  '1w': { binance: '1w', yahooInt: '1wk', yahooRange: '5y', cache: 300000 }
};

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return 0;
  return Number(value.toFixed(digits));
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function formatPrice(value) {
  if (!Number.isFinite(value)) return null;

  const abs = Math.abs(value);

  if (abs >= 1000) {
    return Number(value.toFixed(2)).toLocaleString('en-US');
  }

  if (abs >= 1) {
    return Number(value.toFixed(4)).toLocaleString('en-US');
  }

  return Number(value.toFixed(8)).toString();
}

function calculateRSI(prices, period = 14) {
  if (prices.length <= period) return 50;

  let avgGain = 0;
  let avgLoss = 0;

  for (let i = 1; i <= period; i++) {
    const diff = prices[i] - prices[i - 1];
    avgGain += Math.max(diff, 0);
    avgLoss += Math.max(-diff, 0);
  }

  avgGain /= period;
  avgLoss /= period;

  for (let i = period + 1; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
  }

  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + avgGain / avgLoss));
}

function calculateEMA(prices, period) {
  if (prices.length < period) {
    return prices.map(() => prices[prices.length - 1] || 0);
  }

  let ema = average(prices.slice(0, period));
  const k = 2 / (period + 1);

  const result = Array(period - 1).fill(null);
  result.push(ema);

  for (let i = period; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
    result.push(ema);
  }

  return result;
}

function calculateATR(candles, period = 14) {
  if (candles.length <= period) return 0;

  const tr = [];

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];

    tr.push(
      Math.max(
        c.high - c.low,
        Math.abs(c.high - p.close),
        Math.abs(c.low - p.close)
      )
    );
  }

  return average(tr.slice(-period));
}

function calculateVWAP(candles, period = 30) {
  const recent = candles.slice(-period);

  let pv = 0;
  let vol = 0;

  for (const c of recent) {
    const typical = (c.high + c.low + c.close) / 3;
    pv += typical * c.volume;
    vol += c.volume;
  }

  return vol > 0 ? pv / vol : recent.at(-1)?.close || 0;
}

function calculateVolumeRatio(candles, period = 20) {
  const vols = candles.map(c => c.volume);

  if (vols.length < period + 1) return 1;

  const current = vols.at(-1);
  const base = average(vols.slice(-(period + 1), -1));

  return base > 0 ? current / base : 1;
}

function calculateMomentum(prices, period = 5) {
  if (prices.length <= period) return 0;

  const current = prices.at(-1);
  const previous = prices.at(-(period + 1));

  return previous ? ((current - previous) / previous) * 100 : 0;
}

function calculateSupportResistance(candles, period = 30) {
  const recent = candles.slice(-period);

  return {
    support: Math.min(...recent.map(c => c.low)),
    resistance: Math.max(...recent.map(c => c.high))
  };
}

function normalizeNewsScore(news = '') {
  const text = String(news).toLowerCase();

  const bull = ['bullish','breakout','surge','rally','upgrade','adoption'];
  const bear = ['bearish','crash','dump','lawsuit','hack','ban'];

  let score = 0;

  for (const w of bull) if (text.includes(w)) score++;
  for (const w of bear) if (text.includes(w)) score--;

  return Math.max(-10, Math.min(10, score * 2));
}

function generateScalpingSignal(candles, options = {}) {
  if (candles.length < 60) {
    return {
      signal: 'HOLD',
      strength: 'FAIBLE',
      confidence: 0,
      score: 0,
      reasons: ['Pas assez de donnees']
    };
  }

  const closes = candles.map(c => c.close);
  const price = candles.at(-1).close;

  const ema9 = calculateEMA(closes, 9).at(-1);
  const ema21 = calculateEMA(closes, 21).at(-1);
  const ema50 = calculateEMA(closes, 50).at(-1);

  const rsi7 = calculateRSI(closes, 7);
  const rsi14 = calculateRSI(closes, 14);

  const vwap = calculateVWAP(candles, 30);
  const momentum = calculateMomentum(closes, 5);

  const { support, resistance } = calculateSupportResistance(candles);

  let score = 0;
  const reasons = [];

  if (ema9 > ema21 && ema21 > ema50) {
    score += 25;
    reasons.push('Tendance haussiere');
  }

  if (price > vwap) score += 10;
  if (rsi7 > 52) score += 10;
  if (momentum > 0.15) score += 10;

  score += normalizeNewsScore(options.news);

  let signal = 'HOLD';
  if (score >= 45) signal = 'BUY';
  if (score <= -45) signal = 'SELL';

  return {
    signal,
    confidence: Math.min(95, Math.abs(score)),
    score: round(score, 1),
    indicators: {
      rsi7: round(rsi7, 2),
      rsi14: round(rsi14, 2),
      ema50: formatPrice(ema50),
      vwap: formatPrice(vwap),
      support: formatPrice(support),
      resistance: formatPrice(resistance)
    },
    reasons
  };
}

function yahooCandlesFromResult(result) {
  const quote = result?.indicators?.quote?.[0];
  const timestamps = result?.timestamp || [];

  if (!quote) return [];

  return timestamps.map((t, i) => ({
    time: t * 1000,
    open: quote.open[i],
    high: quote.high[i],
    low: quote.low[i],
    close: quote.close[i],
    volume: quote.volume[i] || 0
  })).filter(c => c.close);
}

// ================= ROOT
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Trading backend is running'
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// ================= MARKET ROUTE (CORRIGÉE)
app.get('/market', async (req, res) => {
  try {
    let {
      symbol,
      type = 'crypto',
      interval = '15m',
      news = ''
    } = req.query;

    if (!symbol) {
      return res.status(400).json({ error: 'Symbol requis' });
    }

    symbol = symbol.toUpperCase().trim();
    type = String(type).toLowerCase().trim();

    if (!INTERVAL_MAP[interval]) {
      interval = '15m';
    }

    const timeConfig = INTERVAL_MAP[interval];
    const cacheKey = `${type}-${symbol}-${interval}`;

    if (CACHE.has(cacheKey)) {
      const cached = CACHE.get(cacheKey);
      if (Date.now() - cached.timestamp < timeConfig.cache) {
        return res.json(cached.data);
      }
    }

    let candles = [];
    let source = '';

    // ===== CRYPTO
    if (type === 'crypto') {
      let cryptoSymbol = `${symbol.replace(/[^A-Z]/g, '')}USDT`;

      const response = await axios.get(
        'https://api.binance.com/api/v3/klines',
        {
          params: { symbol: cryptoSymbol, interval: timeConfig.binance, limit: 300 }
        }
      );

      candles = response.data.map(c => ({
        time: c[0],
        open: +c[1],
        high: +c[2],
        low: +c[3],
        close: +c[4],
        volume: +c[5]
      }));

      source = 'Binance';
    }

    if (candles.length < 60) {
      return res.status(404).json({ error: 'Donnees insuffisantes' });
    }
if (!candles || candles.length === 0) {
  return res.status(404).json({
    error: 'Aucune donnée disponible'
  });
}
    const currentPrice = candles.at(-1).close;

    const analysis = generateScalpingSignal(candles, { news });

    const data = {
      symbol,
      type,
      interval,
      marketPrice: currentPrice,
      formattedPrice: formatPrice(currentPrice),
      source,
      ...analysis,
      timestamp: new Date().toISOString()
    };

    CACHE.set(cacheKey, { data, timestamp: Date.now() });

    return res.json(data);

  } catch (error) {
    console.error(error.message);
    return res.status(500).json({ error: 'Impossible de charger les donnees' });
  }
});

app.listen(PORT, () => {
  console.log(`Serveur lance sur port ${PORT}`);
});

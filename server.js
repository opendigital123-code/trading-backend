require('dotenv').config({ quiet: true });

const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

app.set('trust proxy', 1);
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json());

const CACHE = new Map();
const SIGNAL_LOCKS = new Map();
const AXIOS_TIMEOUT = Number(process.env.MARKET_TIMEOUT_MS || 8000);
const SIGNAL_COOLDOWN_MS = 5 * 60 * 1000; // ← Cooldown de 5 min entre deux signaux forts

const HTTP = axios.create({
  timeout: AXIOS_TIMEOUT,
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    Accept: 'application/json,text/plain,*/*'
  }
});

const INTERVAL_MAP = {
  '1m': {
    intervalMs: 60 * 1000,
    binance: '1m',
    bybit: '1',
    yahooInt: '1m',
    yahooRange: '5d',
    coinbaseGranularity: 60,
    bitstampStep: 60,
    cache: 5000
  },
  '5m': {
    intervalMs: 5 * 60 * 1000,
    binance: '5m',
    bybit: '5',
    yahooInt: '5m',
    yahooRange: '30d',
    coinbaseGranularity: 300,
    bitstampStep: 300,
    cache: 10000
  },
  '15m': {
    intervalMs: 15 * 60 * 1000,
    binance: '15m',
    bybit: '15',
    yahooInt: '15m',
    yahooRange: '30d',
    coinbaseGranularity: 900,
    bitstampStep: 900,
    cache: 15000
  },
  '30m': {
    intervalMs: 30 * 60 * 1000,
    binance: '30m',
    bybit: '30',
    yahooInt: '30m',
    yahooRange: '60d',
    coinbaseGranularity: null,
    bitstampStep: 1800,
    cache: 20000
  },
  '1h': {
    intervalMs: 60 * 60 * 1000,
    binance: '1h',
    bybit: '60',
    yahooInt: '60m',
    yahooRange: '60d',
    coinbaseGranularity: 3600,
    bitstampStep: 3600,
    cache: 30000
  },
  '4h': {
    intervalMs: 4 * 60 * 60 * 1000,
    binance: '4h',
    bybit: '240',
    yahooInt: '60m',
    yahooRange: '60d',
    coinbaseGranularity: 21600,
    bitstampStep: 14400,
    aggregateMs: 4 * 60 * 60 * 1000,
    cache: 60000
  },
  '1d': {
    intervalMs: 24 * 60 * 60 * 1000,
    binance: '1d',
    bybit: 'D',
    yahooInt: '1d',
    yahooRange: '2y',
    coinbaseGranularity: 86400,
    bitstampStep: 86400,
    cache: 120000
  },
  '1w': {
    intervalMs: 7 * 24 * 60 * 60 * 1000,
    binance: '1w',
    bybit: 'W',
    yahooInt: '1wk',
    yahooRange: '5y',
    coinbaseGranularity: null,
    bitstampStep: 86400,
    bitstampAggregateMs: 7 * 24 * 60 * 60 * 1000,
    cache: 300000
  }
};

const YAHOO_SYMBOL_ALIASES = {
  US100: '^NDX',
  NAS100: '^NDX',
  NASDAQ100: '^NDX',
  NDX100: '^NDX',
  USTECH100: '^NDX',
  USTEC: '^NDX',
  TECH100: '^NDX',
  'US TECH 100': '^NDX',
  'NASDAQ 100': '^NDX',
  NQ: 'NQ=F',
  NQF: 'NQ=F',
  SPX500: 'ES=F',
  US500: 'ES=F',
  SP500: 'ES=F',
  US30: 'YM=F',
  DJI: 'YM=F',
  DJ30: 'YM=F',
  GER40: '^GDAXI',
  DAX40: '^GDAXI',
  UK100: '^FTSE',
  XAUUSD: 'GC=F',
  GOLD: 'GC=F',
  XAGUSD: 'SI=F',
  SILVER: 'SI=F',
  USOIL: 'CL=F',
  WTI: 'CL=F',
  BRENT: 'BZ=F'
};

// ─── Utilitaires ────────────────────────────────────────────────────────────

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return 0;
  return Number(value.toFixed(digits));
}

function average(values) {
  const valid = values.filter(Number.isFinite);
  if (!valid.length) return 0;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function median(values) {
  const valid = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!valid.length) return 0;
  const mid = Math.floor(valid.length / 2);
  return valid.length % 2 ? valid[mid] : (valid[mid - 1] + valid[mid]) / 2;
}

function formatPrice(value) {
  if (!Number.isFinite(value)) return null;
  const abs = Math.abs(value);
  if (abs >= 1000) return Number(value.toFixed(2)).toLocaleString('en-US');
  if (abs >= 1)    return Number(value.toFixed(4)).toLocaleString('en-US');
  return Number(value.toFixed(8)).toString();
}

function priceDigits(value) {
  const abs = Math.abs(Number(value));
  if (abs >= 1000) return 2;
  if (abs >= 1)    return 4;
  return 8;
}

function formatPlanPrice(value, reference) {
  const ref = Number.isFinite(reference) ? reference : value;
  return round(value, priceDigits(ref));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// ─── Indicateurs ────────────────────────────────────────────────────────────

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
  return 100 - 100 / (1 + avgGain / avgLoss);
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

function calculateMACD(prices) {
  const ema12 = calculateEMA(prices, 12);
  const ema26 = calculateEMA(prices, 26);
  const macdLine = prices.map((_, i) => {
    if (!Number.isFinite(ema12[i]) || !Number.isFinite(ema26[i])) return null;
    return ema12[i] - ema26[i];
  });
  const validMacd = macdLine.filter(Number.isFinite);
  const signalLine = calculateEMA(validMacd, 9);

  const histValues = [];
  for (let i = Math.max(0, validMacd.length - 5); i < validMacd.length; i++) {
    const sig = signalLine[i - (validMacd.length - signalLine.length)];
    if (Number.isFinite(sig)) histValues.push(validMacd[i] - sig);
  }

  return {
    macd:        macdLine.at(-1) || 0,
    signal:      signalLine.at(-1) || 0,
    histogram:   (macdLine.at(-1) || 0) - (signalLine.at(-1) || 0),
    histValues
  };
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
  let pv = 0, vol = 0;
  for (const c of recent) {
    const typical = (c.high + c.low + c.close) / 3;
    pv  += typical * c.volume;
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
  const current  = prices.at(-1);
  const previous = prices.at(-(period + 1));
  return previous ? ((current - previous) / previous) * 100 : 0;
}

function calculateSupportResistance(candles, period = 40) {
  const recent = candles.slice(-period);
  return {
    support:    Math.min(...recent.map(c => c.low)),
    resistance: Math.max(...recent.map(c => c.high))
  };
}

function detectRSIDivergence(prices, period = 14, lookback = 10) {
  if (prices.length < period + lookback + 2) return null;

  const rsiValues = [];
  for (let i = prices.length - lookback - 1; i < prices.length; i++) {
    rsiValues.push(calculateRSI(prices.slice(0, i + 1), period));
  }

  const priceSlice = prices.slice(-(lookback + 1));

  const priceLow  = Math.min(...priceSlice);
  const priceHigh = Math.max(...priceSlice);
  const rsiLow    = Math.min(...rsiValues);
  const rsiHigh   = Math.max(...rsiValues);

  const lastPrice = priceSlice.at(-1);
  const lastRsi   = rsiValues.at(-1);

  const isBullishDiv =
    lastPrice <= priceLow * 1.005 &&
    lastRsi > rsiLow + 3 &&
    lastRsi < 45;

  const isBearishDiv =
    lastPrice >= priceHigh * 0.995 &&
    lastRsi < rsiHigh - 3 &&
    lastRsi > 55;

  if (isBullishDiv) return { type: 'bullish', rsi: round(lastRsi, 2) };
  if (isBearishDiv) return { type: 'bearish', rsi: round(lastRsi, 2) };
  return null;
}

function detectMACDDivergence(prices, histValues, lookback = 8) {
  if (!histValues || histValues.length < 4) return null;
  if (prices.length < lookback + 2) return null;

  const recentPrices = prices.slice(-lookback);
  const priceMin = Math.min(...recentPrices);
  const priceMax = Math.max(...recentPrices);
  const histMin  = Math.min(...histValues);
  const histMax  = Math.max(...histValues);

  const lastPrice = recentPrices.at(-1);
  const lastHist  = histValues.at(-1);

  const isBullish = lastPrice <= priceMin * 1.005 && lastHist > histMin + Math.abs(histMin) * 0.15;
  const isBearish = lastPrice >= priceMax * 0.995 && lastHist < histMax - Math.abs(histMax) * 0.15;

  if (isBullish) return { type: 'bullish' };
  if (isBearish) return { type: 'bearish' };
  return null;
}

// ─── Patterns chandelier ────────────────────────────────────────────────────

function getClosedCandles(candles, intervalMs, now = Date.now()) {
  if (!intervalMs) return candles;
  // Ajout d'une marge de tolérance de 10 secondes pour compenser les désynchronisations d'horloge mineures
  const closed = candles.filter(c => c.time + intervalMs <= now + 10000);
  if (closed.length < 30) return candles.slice(0, -1);
  return closed;
}

function candleBody(candle) {
  return Math.abs(candle.close - candle.open);
}

function candleRange(candle) {
  return Math.max(candle.high - candle.low, 0);
}

function isBullish(candle) {
  return candle.close > candle.open;
}

function isBearish(candle) {
  return candle.close < candle.open;
}

function detectSingleCandlePattern(candle) {
  const range = candleRange(candle);
  if (!range) return null;

  const body       = candleBody(candle);
  const upperWick  = candle.high - Math.max(candle.open, candle.close);
  const lowerWick  = Math.min(candle.open, candle.close) - candle.low;
  const bodyRatio  = body / range;

  if (bodyRatio <= 0.35 && lowerWick >= body * 2.2 && upperWick <= body * 0.9) {
    return { direction: 'bullish', name: 'Hammer / rejet acheteur' };
  }

  if (bodyRatio <= 0.35 && upperWick >= body * 2.2 && lowerWick <= body * 0.9) {
    return { direction: 'bearish', name: 'Shooting star / rejet vendeur' };
  }

  return null;
}

function detectCandlestickSetup(candles) {
  if (candles.length < 4) return null;

  const patternCandle   = candles.at(-2);
  const confirmation    = candles.at(-1);
  const previous        = candles.at(-3);
  const beforePrevious  = candles.at(-4);
  const avgBody = average(candles.slice(-22, -2).map(candleBody));
  const minBody = Math.max(avgBody * 0.45, patternCandle.close * 0.00015);
  let setup = null;

  const bullishEngulfing =
    isBearish(previous) &&
    isBullish(patternCandle) &&
    candleBody(patternCandle) >= minBody &&
    patternCandle.open <= previous.close &&
    patternCandle.close >= previous.open;

  const bearishEngulfing =
    isBullish(previous) &&
    isBearish(patternCandle) &&
    candleBody(patternCandle) >= minBody &&
    patternCandle.open >= previous.close &&
    patternCandle.close <= previous.open;

  const morningStar =
    isBearish(beforePrevious) &&
    candleBody(previous) <= candleBody(beforePrevious) * 0.65 &&
    isBullish(patternCandle) &&
    patternCandle.close > (beforePrevious.open + beforePrevious.close) / 2;

  const eveningStar =
    isBullish(beforePrevious) &&
    candleBody(previous) <= candleBody(beforePrevious) * 0.65 &&
    isBearish(patternCandle) &&
    patternCandle.close < (beforePrevious.open + beforePrevious.close) / 2;

  if (bullishEngulfing) setup = { direction: 'bullish', name: 'Bullish engulfing' };
  if (bearishEngulfing) setup = { direction: 'bearish', name: 'Bearish engulfing' };
  if (morningStar)      setup = { direction: 'bullish', name: 'Morning star' };
  if (eveningStar)      setup = { direction: 'bearish', name: 'Evening star' };

  const single = detectSingleCandlePattern(patternCandle);
  if (!setup && single) setup = single;
  if (!setup) return null;

  const bullishConfirmation =
    setup.direction === 'bullish' &&
    isBullish(confirmation) &&
    confirmation.close > patternCandle.high;

  const bearishConfirmation =
    setup.direction === 'bearish' &&
    isBearish(confirmation) &&
    confirmation.close < patternCandle.low;

  return {
    ...setup,
    confirmed: bullishConfirmation || bearishConfirmation,
    patternCandle,
    confirmationCandle: confirmation
  };
}

// ─── Scoring ────────────────────────────────────────────────────────────────

function normalizeNewsScore(news = '') {
  const text = String(news).toLowerCase();
  const bull = ['bullish', 'breakout', 'surge', 'rally', 'upgrade', 'adoption'];
  const bear = ['bearish', 'crash', 'dump', 'lawsuit', 'hack', 'ban'];
  let score = 0;
  for (const w of bull) if (text.includes(w)) score++;
  for (const w of bear) if (text.includes(w)) score--;
  return Math.max(-8, Math.min(8, score * 2));
}

function strengthFromConfidence(confidence) {
  if (confidence >= 75) return 'FORTE';
  if (confidence >= 50) return 'MOYENNE';
  return 'FAIBLE';
}

// ─── Trade plan ─────────────────────────────────────────────────────────────

function createScalpingTradePlan({
  signal, score, price, atr, support, resistance, confirmationCandle
}) {
  const direction = signal === 'SELL' || (signal === 'HOLD' && score < 0) ? 'SELL' : 'BUY';
  const isBuy     = direction === 'BUY';
  const usableAtr = Number.isFinite(atr) && atr > 0 ? atr : price * 0.002;
  const minRisk   = price * 0.0006;
  const maxRisk   = price * 0.006;
  const baseRisk  = clamp(usableAtr * 0.65, minRisk, maxRisk);
  let risk = baseRisk;

  if (isBuy && Number.isFinite(support) && support > 0 && support < price) {
    const supportRisk = price - support;
    if (supportRisk <= baseRisk * 1.5)
      risk = Math.max(baseRisk, supportRisk + baseRisk * 0.12);
  }

  if (!isBuy && Number.isFinite(resistance) && resistance > price) {
    const resistanceRisk = resistance - price;
    if (resistanceRisk <= baseRisk * 1.5)
      risk = Math.max(baseRisk, resistanceRisk + baseRisk * 0.12);
  }

  const entryPad      = clamp(usableAtr * 0.12, price * 0.00015, price * 0.0012);
  const pendingEntry  =
    signal === 'BUY'  && confirmationCandle ? confirmationCandle.high + entryPad :
    signal === 'SELL' && confirmationCandle ? confirmationCandle.low  - entryPad :
    price;
  const entry       = pendingEntry;
  const stopLoss    = isBuy ? entry - risk : entry + risk;
  const takeProfit1 = isBuy ? entry + risk * 0.85 : entry - risk * 0.85;
  const takeProfit2 = isBuy ? entry + risk * 1.45 : entry - risk * 1.45;
  const entryLow    = isBuy ? entry - entryPad : entry + entryPad;
  const entryHigh   = isBuy ? entry + entryPad : entry - entryPad;

  const safeSupport    = Number.isFinite(support)    && support    > 0 ? support    : isBuy ? stopLoss    : takeProfit2;
  const safeResistance = Number.isFinite(resistance) && resistance > 0 ? resistance : isBuy ? takeProfit2 : stopLoss;
  const action         = signal === 'HOLD' ? `WAIT_${direction}` : direction;

  return {
    action,
    entry:      formatPlanPrice(entry, price),
    entryZone:  `${formatPlanPrice(Math.min(entryLow, entryHigh), price)} - ${formatPlanPrice(Math.max(entryLow, entryHigh), price)}`,
    stopLoss:   formatPlanPrice(stopLoss, price),
    sl:         formatPlanPrice(stopLoss, price),
    takeProfit1: formatPlanPrice(takeProfit1, price),
    takeProfit2: formatPlanPrice(takeProfit2, price),
    tp1:        formatPlanPrice(takeProfit1, price),
    tp2:        formatPlanPrice(takeProfit2, price),
    takeProfit: [formatPlanPrice(takeProfit1, price), formatPlanPrice(takeProfit2, price)],
    targets:    [formatPlanPrice(takeProfit1, price), formatPlanPrice(takeProfit2, price)],
    support:    formatPlanPrice(safeSupport, price),
    resistance: formatPlanPrice(safeResistance, price),
    invalidation: formatPlanPrice(stopLoss, price),
    riskReward: {
      tp1: round(Math.abs(takeProfit1 - entry) / Math.abs(entry - stopLoss), 2),
      tp2: round(Math.abs(takeProfit2 - entry) / Math.abs(entry - stopLoss), 2)
    },
    orderType:
      signal === 'BUY'  ? 'BUY_STOP'  :
      signal === 'SELL' ? 'SELL_STOP' :
      'WAIT',
    triggerNote:
      signal === 'HOLD'
        ? 'Aucun ordre: confiance inferieure au seuil requis.'
        : 'Placer un ordre stop chez le broker: il ne doit etre execute que lorsque le prix touche ENTRY.',
    exitPlan:
      'Scalping: securiser a TP1, remonter le SL vers entry, sortir vite si la bougie casse le momentum.'
  };
}

// ─── Normalisation des données ───────────────────────────────────────────────

function normalizeCandles(candles) {
  return candles
    .map(c => ({
      time:   Number(c.time),
      open:   Number(c.open),
      high:   Number(c.high),
      low:    Number(c.low),
      close:  Number(c.close),
      volume: Number(c.volume || 0)
    }))
    .filter(
      c =>
        Number.isFinite(c.time)  &&
        Number.isFinite(c.open)  &&
        Number.isFinite(c.high)  &&
        Number.isFinite(c.low)   &&
        Number.isFinite(c.close) &&
        c.open > 0 && c.high > 0 && c.low > 0 && c.close > 0
    )
    .sort((a, b) => a.time - b.time);
}

function applyCurrentPrice(candles, currentPrice) {
  if (!candles.length || !Number.isFinite(currentPrice) || currentPrice <= 0) return candles;
  const updated = candles.map(c => ({ ...c }));
  const last = updated.at(-1);
  last.close = currentPrice;
  last.high  = Math.max(last.high, currentPrice);
  last.low   = Math.min(last.low,  currentPrice);
  return updated;
}

function aggregateCandles(candles, bucketMs) {
  if (!bucketMs) return candles;
  const grouped = new Map();
  for (const candle of candles) {
    const bucket  = Math.floor(candle.time / bucketMs) * bucketMs;
    const current = grouped.get(bucket);
    if (!current) {
      grouped.set(bucket, { ...candle, time: bucket });
      continue;
    }
    current.high   = Math.max(current.high, candle.high);
    current.low    = Math.min(current.low,  candle.low);
    current.close  = candle.close;
    current.volume += candle.volume || 0;
  }
  return [...grouped.values()].sort((a, b) => a.time - b.time);
}

// ─── Symboles ────────────────────────────────────────────────────────────────

function splitTradingViewSymbol(rawSymbol) {
  const raw   = String(rawSymbol || '').trim();
  const parts = raw.split(':');
  if (parts.length > 1) return { exchange: parts[0].toLowerCase(), symbol: parts.slice(1).join(':') };
  return { exchange: '', symbol: raw };
}

function compactSymbol(symbol) {
  return String(symbol || '')
    .toUpperCase()
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\.P$/, '')
    .replace(/PERP$/, '');
}

function normalizeCryptoPair(rawSymbol) {
  const { exchange, symbol } = splitTradingViewSymbol(rawSymbol);
  const upperSymbol = String(symbol || '').toUpperCase();
  const isPerp = /\.P$/.test(upperSymbol) || upperSymbol.includes('PERP');
  const cleaned = compactSymbol(symbol).replace(/[-/_\s]/g, '').replace(/[^A-Z0-9]/g, '');
  const quotes  = ['USDT', 'USDC', 'BUSD', 'USD', 'EUR', 'BTC', 'ETH'];
  const quote   = quotes.find(q => cleaned.endsWith(q) && cleaned.length > q.length);
  const base    = quote ? cleaned.slice(0, -quote.length) : cleaned;
  const stableQuote = quote && quote !== 'USD' ? quote : 'USDT';
  return {
    exchange,
    base,
    quote:           quote || 'USDT',
    binanceSymbol:   `${base}${stableQuote}`,
    bybitSymbol:     `${base}${stableQuote}`,
    coinbaseProduct: `${base}-${quote === 'EUR' ? 'EUR' : 'USD'}`,
    bitstampPair:    `${base}${quote === 'EUR' ? 'EUR' : 'USD'}`.toLowerCase(),
    isPerp
  };
}

function resolveYahooSymbol(rawSymbol, type) {
  const { symbol }    = splitTradingViewSymbol(rawSymbol);
  const normalized    = compactSymbol(symbol);
  const aliasKey      = normalized.replace(/[-/_^=.\s]/g, '');
  if (YAHOO_SYMBOL_ALIASES[normalized]) return YAHOO_SYMBOL_ALIASES[normalized];
  if (YAHOO_SYMBOL_ALIASES[aliasKey])   return YAHOO_SYMBOL_ALIASES[aliasKey];
  if (normalized.includes('=') || normalized.startsWith('^')) return normalized;
  const compact = normalized.replace(/[-/_\s]/g, '');
  if (type === 'forex' && /^[A-Z]{6}$/.test(compact)) return `${compact}=X`;
  return normalized;
}

function providerOrder(provider, exchange) {
  const preferred = String(provider || exchange || '').toLowerCase();
  if (preferred.includes('coinbase'))  return ['coinbase', 'binance', 'bybit'];
  if (preferred.includes('bitstamp'))  return ['bitstamp', 'coinbase', 'binance', 'bybit'];
  if (preferred.includes('bybit'))     return ['bybit', 'binance', 'coinbase'];
  if (preferred.includes('yahoo'))     return ['yahoo'];
  return ['binance', 'bybit', 'coinbase'];
}

// ─── Fetchers de marché ──────────────────────────────────────────────────────

async function fetchBinanceCrypto(pair, timeConfig) {
  const baseUrl = pair.isPerp
    ? 'https://fapi.binance.com/fapi/v1'
    : 'https://api.binance.com/api/v3';
  const [klinesResponse, tickerResponse] = await Promise.all([
    HTTP.get(`${baseUrl}/klines`, {
      params: { symbol: pair.binanceSymbol, interval: timeConfig.binance, limit: 500 }
    }),
    HTTP.get(`${baseUrl}/ticker/price`, { params: { symbol: pair.binanceSymbol } }).catch(() => null)
  ]);
  const candles = normalizeCandles(
    klinesResponse.data.map(c => ({
      time: c[0], open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5]
    }))
  );
  const currentPrice = Number(tickerResponse?.data?.price);
  return {
    candles: applyCurrentPrice(candles, currentPrice),
    currentPrice,
    source: `Binance ${pair.isPerp ? 'USDT-M Futures' : 'Spot'} (${pair.binanceSymbol})`
  };
}

async function fetchBybitCrypto(pair, timeConfig) {
  const category = pair.isPerp ? 'linear' : 'spot';
  const [response, tickerResponse] = await Promise.all([
    HTTP.get('https://api.bybit.com/v5/market/kline', {
      params: { category, symbol: pair.bybitSymbol, interval: timeConfig.bybit, limit: 500 }
    }),
    HTTP.get('https://api.bybit.com/v5/market/tickers', {
      params: { category, symbol: pair.bybitSymbol }
    }).catch(() => null)
  ]);
  if (response.data?.retCode !== 0) throw new Error(response.data?.retMsg || 'Bybit error');
  const candles = normalizeCandles(
    (response.data?.result?.list || []).map(c => ({
      time: c[0], open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5]
    }))
  );
  const currentPrice = Number(tickerResponse?.data?.result?.list?.[0]?.lastPrice);
  return {
    candles: applyCurrentPrice(candles, currentPrice),
    currentPrice,
    source: `Bybit ${pair.isPerp ? 'Linear' : 'Spot'} (${pair.bybitSymbol})`
  };
}

async function fetchCoinbaseCrypto(pair, timeConfig) {
  if (!timeConfig.coinbaseGranularity) throw new Error('Intervalle non supporte par Coinbase');
  const end   = Math.floor(Date.now() / 1000);
  const start = end - timeConfig.coinbaseGranularity * 300;
  const [response, tickerResponse] = await Promise.all([
    HTTP.get(`https://api.exchange.coinbase.com/products/${pair.coinbaseProduct}/candles`, {
      params: {
        start: new Date(start * 1000).toISOString(),
        end:   new Date(end   * 1000).toISOString(),
        granularity: timeConfig.coinbaseGranularity
      }
    }),
    HTTP.get(`https://api.exchange.coinbase.com/products/${pair.coinbaseProduct}/ticker`).catch(() => null)
  ]);
  const candles = normalizeCandles(
    response.data.map(c => ({
      time: c[0] * 1000, low: c[1], high: c[2], open: c[3], close: c[4], volume: c[5]
    }))
  );
  const currentPrice = Number(tickerResponse?.data?.price);
  return {
    candles: applyCurrentPrice(candles, currentPrice),
    currentPrice,
    source: `Coinbase Exchange (${pair.coinbaseProduct})`
  };
}

async function fetchBitstampCrypto(pair, timeConfig) {
  if (!timeConfig.bitstampStep) throw new Error('Intervalle non supporte par Bitstamp');
  const [ohlcResponse, tickerResponse] = await Promise.all([
    HTTP.get(`https://www.bitstamp.net/api/v2/ohlc/${pair.bitstampPair}/`, {
      params: { step: timeConfig.bitstampStep, limit: 1000 }
    }),
    HTTP.get(`https://www.bitstamp.net/api/v2/ticker/${pair.bitstampPair}/`).catch(() => null)
  ]);
  let candles = normalizeCandles(
    (ohlcResponse.data?.data?.ohlc || []).map(c => ({
      time:   Number(c.timestamp) * 1000,
      open:   c.open,
      high:   c.high,
      low:    c.low,
      close:  c.close,
      volume: c.volume
    }))
  );
  candles = aggregateCandles(candles, timeConfig.bitstampAggregateMs);
  const currentPrice = Number(tickerResponse?.data?.last);
  return {
    candles: applyCurrentPrice(candles, currentPrice),
    currentPrice,
    source: `Bitstamp (${pair.bitstampPair.toUpperCase()})`
  };
}

async function fetchYahooMarket(rawSymbol, type, timeConfig) {
  const yahooSymbol = resolveYahooSymbol(rawSymbol, type);
  const response = await HTTP.get(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}`,
    {
      params: {
        interval:       timeConfig.yahooInt,
        range:          timeConfig.yahooRange,
        includePrePost: true,
        events:         'history'
      }
    }
  );
  const result = response.data?.chart?.result?.[0];
  const error  = response.data?.chart?.error;
  if (!result || error) throw new Error(error?.description || 'Yahoo Finance error');
  const quote      = result?.indicators?.quote?.[0];
  const timestamps = result?.timestamp || [];
  if (!quote) throw new Error('Yahoo Finance quote vide');
  let candles = normalizeCandles(
    timestamps.map((t, i) => ({
      time:   t * 1000,
      open:   quote.open?.[i],
      high:   quote.high?.[i],
      low:    quote.low?.[i],
      close:  quote.close?.[i],
      volume: quote.volume?.[i] || 0
    }))
  );
  candles = aggregateCandles(candles, timeConfig.aggregateMs);
  const currentPrice = Number(result?.meta?.regularMarketPrice);
  return {
    candles: applyCurrentPrice(candles, currentPrice),
    currentPrice,
    source: `Yahoo Finance (${yahooSymbol})`
  };
}

async function fetchCryptoMarket(rawSymbol, timeConfig, provider) {
  const pair     = normalizeCryptoPair(rawSymbol);
  const attempts = providerOrder(provider, pair.exchange);
  const errors   = [];
  for (const attempt of attempts) {
    try {
      if (attempt === 'bitstamp') return await fetchBitstampCrypto(pair, timeConfig);
      if (attempt === 'binance')  return await fetchBinanceCrypto(pair, timeConfig);
      if (attempt === 'bybit')    return await fetchBybitCrypto(pair, timeConfig);
      if (attempt === 'coinbase') return await fetchCoinbaseCrypto(pair, timeConfig);
    } catch (error) {
      errors.push(`${attempt}: ${error.message}`);
    }
  }
  throw new Error(errors.join(' | ') || 'Aucune source crypto disponible');
}

async function fetchMarketData({ symbol, type, timeConfig, provider }) {
  if (type === 'crypto') return fetchCryptoMarket(symbol, timeConfig, provider);
  return fetchYahooMarket(symbol, type, timeConfig);
}

// ─── Moteur de signal ────────────────────────────────────────────────────────

function generateScalpingSignal(candles, options = {}) {
  const analysisCandles = getClosedCandles(candles, options.intervalMs);

  if (analysisCandles.length < 60) {
    return {
      signal:     'HOLD',
      strength:   'FAIBLE',
      confidence: 0,
      score:      0,
      reasons:    ['Pas assez de donnees']
    };
  }

  const closes   = analysisCandles.map(c => c.close);
  const last     = analysisCandles.at(-1);
  const previous = analysisCandles.at(-2);
  const price    = last.close;

  // — Indicateurs —
  const ema9   = calculateEMA(closes, 9).at(-1);
  const ema21  = calculateEMA(closes, 21).at(-1);
  const ema50  = calculateEMA(closes, 50).at(-1);
  const ema200 = calculateEMA(closes, 200).at(-1);

  const rsi7  = calculateRSI(closes, 7);
  const rsi14 = calculateRSI(closes, 14);
  const macd  = calculateMACD(closes);
  const atr   = calculateATR(analysisCandles, 14);
  const atrPercent = price ? (atr / price) * 100 : 0;

  const vwap        = calculateVWAP(analysisCandles, 30);
  const volumeRatio = calculateVolumeRatio(analysisCandles, 20);
  const momentum    = calculateMomentum(closes, 5);
  const momentumThreshold = Math.max(0.08, Math.min(0.35, atrPercent * 0.2));

  const { support, resistance } = calculateSupportResistance(analysisCandles);
  const range           = Math.max(resistance - support, atr || 0);
  const nearSupport     = range ? (price - support) / range : 0.5;
  const nearResistance  = range ? (resistance - price) / range : 0.5;

  const candlestickSetup  = detectCandlestickSetup(analysisCandles);

  const rsiDivergence  = detectRSIDivergence(closes, 14, 10);
  const macdDivergence = detectMACDDivergence(closes, macd.histValues, 8);

  let score = 0;
  const reasons = [];

  // — Tendance EMA —
  if (ema9 > ema21 && ema21 > ema50) {
    score += 22;
    reasons.push('Tendance courte haussiere');
  } else if (ema9 < ema21 && ema21 < ema50) {
    score -= 22;
    reasons.push('Tendance courte baissiere');
  }

  if (ema9 > ema21 && !(ema21 > ema50)) {
    score += 8;
    reasons.push('EMA9 > EMA21 (tendance courte naissante)');
  } else if (ema9 < ema21 && !(ema21 < ema50)) {
    score -= 8;
  }

  if (Number.isFinite(ema200) && price > ema200) {
    score += 8;
  } else if (Number.isFinite(ema200) && price < ema200) {
    score -= 8;
  }

  if (price > vwap) score += 9;
  if (price < vwap) score -= 9;

  // — MACD —
  if (macd.histogram > 0 && macd.macd > macd.signal) {
    score += 10;
    reasons.push('MACD positif');
  } else if (macd.histogram < 0 && macd.macd < macd.signal) {
    score -= 10;
    reasons.push('MACD negatif');
  }

  // — RSI étendu —
  if (rsi14 >= 55 && rsi14 <= 70) score += 9;
  if (rsi14 <= 45 && rsi14 >= 30) score -= 9;

  if (rsi7 > 80) {
    score -= 14;
    reasons.push('RSI7 suracheté (>80): risque de retournement');
  } else if (rsi7 > 74) {
    score -= 7;
  }

  if (rsi7 < 20) {
    score += 14;
    reasons.push('RSI7 survendu (<20): potentiel rebond');
  } else if (rsi7 < 26) {
    score += 7;
  }

  if (rsi14 > 78 && score > 0) {
    score *= 0.6;
    reasons.push('RSI14 suracheté: signal BUY attenue');
  }
  if (rsi14 < 22 && score < 0) {
    score *= 0.6;
    reasons.push('RSI14 survendu: signal SELL attenue');
  }

  // — Momentum —
  if (momentum > momentumThreshold) {
    score += 10;
    reasons.push('Momentum acheteur');
  } else if (momentum < -momentumThreshold) {
    score -= 10;
    reasons.push('Momentum vendeur');
  }

  // — Volumes (Optimisés) —
  if (volumeRatio > 1.5 && last.close > last.open) {
    score += 10;
    reasons.push('Volume fort haussier');
  } else if (volumeRatio > 1.15 && last.close > last.open) {
    score += 5;
  }
  if (volumeRatio > 1.5 && last.close < last.open) {
    score -= 10;
    reasons.push('Volume fort baissier');
  } else if (volumeRatio > 1.15 && last.close < last.open) {
    score -= 5;
  }

  if (volumeRatio < 0.5) {
    score *= 0.90; // Pénalité adoucie (0.90 au lieu de 0.8) pour ne pas bloquer les tendances lentes
    reasons.push('Volume faible: signal attenue');
  }

  // — Support / résistance —
  if (nearSupport < 0.18 && price > previous.close)    score += 5;
  if (nearResistance < 0.18 && price < previous.close) score -= 5;

  // — Patterns chandeliers (Optimisés) —
  if (candlestickSetup?.confirmed) {
    const isBullishSetup = candlestickSetup.direction === 'bullish';
    score += isBullishSetup ? 24 : -24;
    reasons.push(`${candlestickSetup.name} confirme par la bougie suivante`);

    if (isBullishSetup && price > ema21 && price > vwap) {
      score += 8;
      reasons.push('Confirmation haussiere alignee avec EMA/VWAP');
    }
    if (!isBullishSetup && price < ema21 && price < vwap) {
      score -= 8;
      reasons.push('Confirmation baissiere alignee avec EMA/VWAP');
    }
  } else if (candlestickSetup) {
    reasons.push(`${candlestickSetup.name} detecte sans confirmation`);
    score *= 0.85; // Adouci à 0.85 (au lieu de 0.82)
  } else {
    // Suppression de l'ancienne réduction de score arbitraire (score *= 0.92)
    // L'absence de pattern n'est pas un contre-signal mais un état neutre.
  }

  // — Divergences —
  if (rsiDivergence?.type === 'bullish') {
    score += 18;
    reasons.push(`Divergence RSI haussiere (RSI ${rsiDivergence.rsi})`);
  } else if (rsiDivergence?.type === 'bearish') {
    score -= 18;
    reasons.push(`Divergence RSI baissiere (RSI ${rsiDivergence.rsi})`);
  }

  if (macdDivergence?.type === 'bullish') {
    score += 12;
    reasons.push('Divergence MACD haussiere');
  } else if (macdDivergence?.type === 'bearish') {
    score -= 12;
    reasons.push('Divergence MACD baissiere');
  }

  // — Volatilité —
  if (atrPercent > 4) {
    score *= 0.85;
    reasons.push('Volatilite elevee');
  }

  if (atrPercent < 0.1) {
    score *= 0.75; // Pénalité adoucie (0.75 au lieu de 0.5) pour permettre le trading de paires à faible spread
    reasons.push('ATR tres faible: marche plat, scalping risque');
  }

  // — News —
  score += normalizeNewsScore(options.news);

  // — Confiance & Signaux (Ajustés pour réduire le "HOLD" constant) —
  const absScore = Math.abs(score);
  
  // Calibrage de la sigmoïde pour être alignée avec le seuil réactif de 60
  const confidence = Math.min(95, Math.round(
    95 / (1 + Math.exp(-0.08 * (absScore - 45)))
  ));

  // Ajustement du seuil de déclenchement de 75 à 60
  let signal = 'HOLD';
  if (score >= 60 && confidence >= 50) signal = 'BUY';
  if (score <= -60 && confidence >= 50) signal = 'SELL';

  if (signal === 'HOLD' && confidence < 50) {
    reasons.push('Confiance insuffisante: HOLD obligatoire');
  }

  if (!reasons.length) reasons.push('Marche neutre ou signaux contradictoires');

  const tradePlan = createScalpingTradePlan({
    signal,
    score,
    price,
    atr,
    support,
    resistance,
    confirmationCandle: candlestickSetup?.confirmed ? candlestickSetup.confirmationCandle : null
  });

  return {
    signal,
    strength:   strengthFromConfidence(confidence),
    confidence,
    score:      round(score, 1),
    tradePlan,
    indicators: {
      rsi7:        round(rsi7, 2),
      rsi14:       round(rsi14, 2),
      ema9:        formatPrice(ema9),
      ema21:       formatPrice(ema21),
      ema50:       formatPrice(ema50),
      ema200:      formatPrice(ema200),
      macd:        round(macd.macd, 6),
      macdSignal:  round(macd.signal, 6),
      atr:         formatPrice(atr),
      atrPercent:  round(atrPercent, 2),
      vwap:        formatPrice(vwap),
      volumeRatio: round(volumeRatio, 2),
      momentum:    round(momentum, 3),
      support:     formatPrice(support),
      resistance:  formatPrice(resistance)
    },
    candlestickPattern: candlestickSetup
      ? { name: candlestickSetup.name, direction: candlestickSetup.direction, confirmed: candlestickSetup.confirmed }
      : null,
    divergences: {
      rsi:  rsiDivergence  || null,
      macd: macdDivergence || null
    },
    candleAnalysis: {
      requestedCandles:      candles.length,
      closedCandles:         analysisCandles.length,
      lastClosedCandleTime:  new Date(last.time).toISOString()
    },
    reasons
  };
}

// ─── Cooldown ────────────────────────────────────────────────────────────────

function applySignalCooldown(data, lockKey) {
  const now        = Date.now();
  const activeLock = SIGNAL_LOCKS.get(lockKey);

  if (activeLock && activeLock.until <= now) {
    SIGNAL_LOCKS.delete(lockKey);
  }

  if (!['BUY', 'SELL'].includes(data.signal)) {
    return {
      ...data,
      cooldown: {
        active:           Boolean(activeLock && activeLock.until > now),
        secondsRemaining: activeLock && activeLock.until > now
          ? Math.ceil((activeLock.until - now) / 1000)
          : 0
      }
    };
  }

  const currentLock = SIGNAL_LOCKS.get(lockKey);
  if (currentLock && currentLock.until > now) {
    const secondsRemaining = Math.ceil((currentLock.until - now) / 1000);
    return {
      ...data,
      signal:     'HOLD',
      strength:   'FAIBLE',
      confidence: 0,
      tradePlan:  null,
      cooldown: {
        active:           true,
        secondsRemaining,
        lockedSignal:     currentLock.signal,
        lockedAt:         new Date(currentLock.createdAt).toISOString()
      },
      reasons: [
        `Signal ${currentLock.signal} deja emis: generation bloquee encore ${secondsRemaining}s`,
        ...(data.reasons || [])
      ]
    };
  }

  SIGNAL_LOCKS.set(lockKey, {
    signal:    data.signal,
    createdAt: now,
    until:     now + SIGNAL_COOLDOWN_MS
  });

  return {
    ...data,
    cooldown: {
      active:           true,
      secondsRemaining: SIGNAL_COOLDOWN_MS / 1000,
      lockedSignal:     data.signal,
      lockedAt:         new Date(now).toISOString()
    }
  };
}

// ─── Routes ──────────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Trading backend is running' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: round(process.uptime(), 2), timestamp: new Date().toISOString() });
});

app.get('/market', async (req, res) => {
  try {
    let {
      symbol,
      type     = 'crypto',
      interval = '15m',
      news     = '',
      provider = ''
    } = req.query;

    if (!symbol) return res.status(400).json({ error: 'Symbol requis' });

    symbol = String(symbol).trim();
    type   = String(type).toLowerCase().trim();

    if (type === 'indice')  type = 'index';
    if (type === 'indices') type = 'index';

    if (!INTERVAL_MAP[interval]) interval = '15m';

    const timeConfig    = INTERVAL_MAP[interval];
    const cacheKey      = `${type}-${symbol}-${interval}-${provider}`;
    const signalLockKey = `${type}-${compactSymbol(symbol)}-${interval}-${provider}`;

    if (CACHE.has(cacheKey)) {
      const cached = CACHE.get(cacheKey);
      if (Date.now() - cached.timestamp < timeConfig.cache) {
        return res.json(applySignalCooldown(cached.data, signalLockKey));
      }
    }

    const market = await fetchMarketData({ symbol, type, timeConfig, provider });

    if (!market.candles || market.candles.length < 60) {
      return res.status(404).json({
        error:   'Donnees insuffisantes',
        source:  market.source,
        candles: market.candles?.length || 0
      });
    }

    const closes       = market.candles.map(c => c.close);
    const currentPrice =
      Number.isFinite(market.currentPrice) && market.currentPrice > 0
        ? market.currentPrice
        : median(closes.slice(-3));

    const candles  = applyCurrentPrice(market.candles, currentPrice);
    const analysis = generateScalpingSignal(candles, {
      news,
      intervalMs: timeConfig.intervalMs
    });

    const data = {
      symbol:        compactSymbol(symbol),
      type,
      interval,
      marketPrice:   currentPrice,
      formattedPrice: formatPrice(currentPrice),
      source:        market.source,
      priceMode:
        type === 'crypto'
          ? 'OHLC + ticker natifs de l exchange, alignes avec TradingView si le meme exchange/symbole est choisi'
          : 'Yahoo Finance chart + regularMarketPrice',
      ...analysis,
      timestamp: new Date().toISOString()
    };

    CACHE.set(cacheKey, { data, timestamp: Date.now() });

    return res.json(applySignalCooldown(data, signalLockKey));
  } catch (error) {
    console.error('Market error:', error.message);
    return res.status(502).json({
      error:   'Impossible de charger les donnees',
      details: process.env.NODE_ENV === 'production' ? undefined : error.message
    });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`Serveur lance sur ${HOST}:${PORT}`);
});

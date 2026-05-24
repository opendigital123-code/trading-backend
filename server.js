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
const AXIOS_TIMEOUT = Number(process.env.MARKET_TIMEOUT_MS || 8000);

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
    binance: '1m', bybit: '1', yahooInt: '1m', yahooRange: '5d',
    coinbaseGranularity: 60, bitstampStep: 60, cache: 5000
  },
  '5m': {
    binance: '5m', bybit: '5', yahooInt: '5m', yahooRange: '30d',
    coinbaseGranularity: 300, bitstampStep: 300, cache: 10000
  },
  '15m': {
    binance: '15m', bybit: '15', yahooInt: '15m', yahooRange: '30d',
    coinbaseGranularity: 900, bitstampStep: 900, cache: 15000
  },
  '30m': {
    binance: '30m', bybit: '30', yahooInt: '30m', yahooRange: '60d',
    coinbaseGranularity: null, bitstampStep: 1800, cache: 20000
  },
  '1h': {
    binance: '1h', bybit: '60', yahooInt: '60m', yahooRange: '60d',
    coinbaseGranularity: 3600, bitstampStep: 3600, cache: 30000
  },
  '4h': {
    binance: '4h', bybit: '240', yahooInt: '60m', yahooRange: '60d',
    coinbaseGranularity: 21600, bitstampStep: 14400,
    aggregateMs: 4 * 60 * 60 * 1000, cache: 60000
  },
  '1d': {
    binance: '1d', bybit: 'D', yahooInt: '1d', yahooRange: '2y',
    coinbaseGranularity: 86400, bitstampStep: 86400, cache: 120000
  },
  '1w': {
    binance: '1w', bybit: 'W', yahooInt: '1wk', yahooRange: '5y',
    coinbaseGranularity: null, bitstampStep: 86400,
    bitstampAggregateMs: 7 * 24 * 60 * 60 * 1000, cache: 300000
  }
};

const YAHOO_SYMBOL_ALIASES = {
  US100: '^NDX', NAS100: '^NDX', NASDAQ100: '^NDX', NDX100: '^NDX',
  USTECH100: '^NDX', USTEC: '^NDX', TECH100: '^NDX',
  'US TECH 100': '^NDX', 'NASDAQ 100': '^NDX',
  NQ: 'NQ=F', NQF: 'NQ=F', SPX500: 'ES=F', US500: 'ES=F',
  SP500: 'ES=F', US30: 'YM=F', DJI: 'YM=F', DJ30: 'YM=F',
  GER40: '^GDAXI', DAX40: '^GDAXI', UK100: '^FTSE',
  XAUUSD: 'GC=F', GOLD: 'GC=F', XAGUSD: 'SI=F', SILVER: 'SI=F',
  USOIL: 'CL=F', WTI: 'CL=F', BRENT: 'BZ=F'
};

// ============================================================
// MATH UTILITIES
// ============================================================

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return 0;
  return Number(value.toFixed(digits));
}

function average(values) {
  const valid = values.filter(Number.isFinite);
  if (!valid.length) return 0;
  return valid.reduce((s, v) => s + v, 0) / valid.length;
}

function median(values) {
  const valid = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!valid.length) return 0;
  const mid = Math.floor(valid.length / 2);
  return valid.length % 2 ? valid[mid] : (valid[mid - 1] + valid[mid]) / 2;
}

function stdDev(values) {
  const valid = values.filter(Number.isFinite);
  if (valid.length < 2) return 0;
  const mean = average(valid);
  return Math.sqrt(valid.reduce((s, v) => s + (v - mean) ** 2, 0) / valid.length);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function formatPrice(value) {
  if (!Number.isFinite(value)) return null;
  const abs = Math.abs(value);
  if (abs >= 1000) return Number(value.toFixed(2)).toLocaleString('en-US');
  if (abs >= 1) return Number(value.toFixed(4)).toLocaleString('en-US');
  return Number(value.toFixed(8)).toString();
}

function priceDigits(value) {
  const abs = Math.abs(Number(value));
  if (abs >= 1000) return 2;
  if (abs >= 1) return 4;
  return 8;
}

function formatPlanPrice(value, reference) {
  const ref = Number.isFinite(reference) ? reference : value;
  return round(value, priceDigits(ref));
}

// ============================================================
// TECHNICAL INDICATORS
// ============================================================

/**
 * RSI with Wilder smoothing (standard)
 */
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

/**
 * Full RSI series (for divergence detection)
 */
function calculateRSISeries(prices, period = 14) {
  const result = new Array(prices.length).fill(null);
  if (prices.length <= period) return result;

  let avgGain = 0;
  let avgLoss = 0;

  for (let i = 1; i <= period; i++) {
    const diff = prices[i] - prices[i - 1];
    avgGain += Math.max(diff, 0);
    avgLoss += Math.max(-diff, 0);
  }

  avgGain /= period;
  avgLoss /= period;
  result[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
    result[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }

  return result;
}

/**
 * Stochastic RSI — more reactive than RSI alone, critical for scalping
 */
function calculateStochRSI(prices, rsiPeriod = 14, stochPeriod = 14, kSmooth = 3, dSmooth = 3) {
  const rsiSeries = calculateRSISeries(prices, rsiPeriod);
  const validRsi = rsiSeries.filter(v => v !== null);

  if (validRsi.length < stochPeriod) return { k: 50, d: 50 };

  const stochSeries = [];

  for (let i = stochPeriod - 1; i < validRsi.length; i++) {
    const window = validRsi.slice(i - stochPeriod + 1, i + 1);
    const lo = Math.min(...window);
    const hi = Math.max(...window);
    stochSeries.push(hi === lo ? 50 : ((validRsi[i] - lo) / (hi - lo)) * 100);
  }

  const kSeries = [];
  for (let i = kSmooth - 1; i < stochSeries.length; i++) {
    kSeries.push(average(stochSeries.slice(i - kSmooth + 1, i + 1)));
  }

  const dSeries = [];
  for (let i = dSmooth - 1; i < kSeries.length; i++) {
    dSeries.push(average(kSeries.slice(i - dSmooth + 1, i + 1)));
  }

  return {
    k: kSeries.at(-1) ?? 50,
    d: dSeries.at(-1) ?? 50,
    kPrev: kSeries.at(-2) ?? 50,
    dPrev: dSeries.at(-2) ?? 50
  };
}

/**
 * EMA — exponential moving average series
 */
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

/**
 * MACD with full histogram series for divergence
 */
function calculateMACD(prices, fast = 12, slow = 26, signal = 9) {
  const emaFast = calculateEMA(prices, fast);
  const emaSlow = calculateEMA(prices, slow);

  const macdLine = prices.map((_, i) => {
    if (!Number.isFinite(emaFast[i]) || !Number.isFinite(emaSlow[i])) return null;
    return emaFast[i] - emaSlow[i];
  });

  const validMacd = macdLine.filter(v => v !== null);
  const signalLine = calculateEMA(validMacd, signal);

  const lastMacd = macdLine.at(-1) ?? 0;
  const lastSignal = signalLine.at(-1) ?? 0;
  const prevMacd = macdLine.at(-2) ?? 0;
  const prevSignal = signalLine.at(-2) ?? 0;

  // Bullish crossover: MACD crosses above signal
  const bullCross = prevMacd <= (signalLine.at(-2) ?? 0) && lastMacd > lastSignal;
  // Bearish crossover: MACD crosses below signal
  const bearCross = prevMacd >= (signalLine.at(-2) ?? 0) && lastMacd < lastSignal;

  return {
    macd: lastMacd,
    signal: lastSignal,
    histogram: lastMacd - lastSignal,
    prevHistogram: prevMacd - prevSignal,
    bullCross,
    bearCross,
    histogramSeries: macdLine.map((m, i) => {
      const s = i >= macdLine.filter((v, j) => v !== null && j <= i).length - 1
        ? signalLine.at(-(macdLine.length - i))
        : null;
      return m !== null && s !== null ? m - s : null;
    })
  };
}

/**
 * ATR — Average True Range
 */
function calculateATR(candles, period = 14) {
  if (candles.length <= period) return 0;

  const tr = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    tr.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }

  return average(tr.slice(-period));
}

/**
 * Bollinger Bands — essential for scalping entries at extremes
 */
function calculateBollingerBands(prices, period = 20, multiplier = 2) {
  if (prices.length < period) {
    const last = prices.at(-1) || 0;
    return { upper: last, middle: last, lower: last, width: 0, percentB: 0.5 };
  }

  const recent = prices.slice(-period);
  const middle = average(recent);
  const std = stdDev(recent);
  const upper = middle + multiplier * std;
  const lower = middle - multiplier * std;
  const width = upper - lower;
  const price = prices.at(-1);
  const percentB = width > 0 ? (price - lower) / width : 0.5;

  return { upper, middle, lower, width, percentB, std };
}

/**
 * VWAP with standard deviation bands
 */
function calculateVWAP(candles, period = 30) {
  const recent = candles.slice(-period);

  let pv = 0;
  let vol = 0;
  const typicals = [];

  for (const c of recent) {
    const typical = (c.high + c.low + c.close) / 3;
    pv += typical * c.volume;
    vol += c.volume;
    typicals.push(typical);
  }

  const vwap = vol > 0 ? pv / vol : recent.at(-1)?.close || 0;

  // VWAP deviation bands
  const variance = vol > 0
    ? recent.reduce((s, c, i) => {
        const typical = typicals[i];
        return s + c.volume * (typical - vwap) ** 2;
      }, 0) / vol
    : 0;

  const std = Math.sqrt(variance);

  return {
    vwap,
    upper1: vwap + std,
    lower1: vwap - std,
    upper2: vwap + 2 * std,
    lower2: vwap - 2 * std
  };
}

/**
 * Volume ratio vs recent average
 */
function calculateVolumeRatio(candles, period = 20) {
  const vols = candles.map(c => c.volume);
  if (vols.length < period + 1) return 1;
  const current = vols.at(-1);
  const base = average(vols.slice(-(period + 1), -1));
  return base > 0 ? current / base : 1;
}

/**
 * Volume trend: is volume increasing or decreasing over last N candles?
 */
function calculateVolumeTrend(candles, period = 5) {
  const vols = candles.slice(-period).map(c => c.volume);
  if (vols.length < 2) return 0;
  let increasing = 0;
  for (let i = 1; i < vols.length; i++) {
    if (vols[i] > vols[i - 1]) increasing++;
  }
  return (increasing / (vols.length - 1)) * 2 - 1; // -1 to 1
}

/**
 * Momentum (Rate of Change)
 */
function calculateMomentum(prices, period = 5) {
  if (prices.length <= period) return 0;
  const current = prices.at(-1);
  const previous = prices.at(-(period + 1));
  return previous ? ((current - previous) / previous) * 100 : 0;
}

/**
 * Advanced Support & Resistance using swing points (pivot highs/lows)
 * More reliable than simple min/max
 */
function calculateSupportResistance(candles, lookback = 60, swingStrength = 3) {
  const recent = candles.slice(-lookback);

  const swingHighs = [];
  const swingLows = [];

  for (let i = swingStrength; i < recent.length - swingStrength; i++) {
    const pivot = recent[i];

    const isSwingHigh = recent
      .slice(i - swingStrength, i + swingStrength + 1)
      .every((c, j) => j === swingStrength || c.high <= pivot.high);

    const isSwingLow = recent
      .slice(i - swingStrength, i + swingStrength + 1)
      .every((c, j) => j === swingStrength || c.low >= pivot.low);

    if (isSwingHigh) swingHighs.push(pivot.high);
    if (isSwingLow) swingLows.push(pivot.low);
  }

  const price = candles.at(-1).close;

  // Nearest resistance above price
  const resistances = swingHighs.filter(h => h > price).sort((a, b) => a - b);
  const supports = swingLows.filter(l => l < price).sort((a, b) => b - a);

  // Fallback to simple range if no swing points found
  const fallbackSupport = Math.min(...recent.map(c => c.low));
  const fallbackResistance = Math.max(...recent.map(c => c.high));

  return {
    support: supports[0] ?? fallbackSupport,
    resistance: resistances[0] ?? fallbackResistance,
    supports: supports.slice(0, 3),
    resistances: resistances.slice(0, 3)
  };
}

/**
 * Market structure: detect HH/HL (uptrend) or LH/LL (downtrend)
 * Critical for scalping in trend direction only
 */
function detectMarketStructure(candles, period = 30) {
  const recent = candles.slice(-period);

  if (recent.length < 6) return { trend: 'NEUTRAL', strength: 0 };

  const highs = recent.map(c => c.high);
  const lows = recent.map(c => c.low);

  const lastHighs = highs.slice(-4);
  const lastLows = lows.slice(-4);

  // Higher Highs and Higher Lows = uptrend
  const hh = lastHighs[3] > lastHighs[1] && lastHighs[1] > lastHighs[0];
  const hl = lastLows[3] > lastLows[1] && lastLows[1] > lastLows[0];

  // Lower Highs and Lower Lows = downtrend
  const lh = lastHighs[3] < lastHighs[1] && lastHighs[1] < lastHighs[0];
  const ll = lastLows[3] < lastLows[1] && lastLows[1] < lastLows[0];

  if (hh && hl) return { trend: 'BULLISH', strength: 2 };
  if (hh || hl) return { trend: 'BULLISH', strength: 1 };
  if (lh && ll) return { trend: 'BEARISH', strength: 2 };
  if (lh || ll) return { trend: 'BEARISH', strength: 1 };

  return { trend: 'NEUTRAL', strength: 0 };
}

/**
 * RSI divergence detection (bullish/bearish)
 * One of the most powerful reversal signals for scalping
 */
function detectRSIDivergence(candles, rsiSeries, lookback = 20) {
  const recent = candles.slice(-lookback);
  const recentRsi = rsiSeries.filter(v => v !== null).slice(-lookback);

  if (recent.length < 4 || recentRsi.length < 4) {
    return { bullish: false, bearish: false };
  }

  const prices = recent.map(c => c.close);
  const n = Math.min(prices.length, recentRsi.length);

  // Find local price lows and RSI lows
  let priceLow1 = Infinity, priceLow2 = Infinity;
  let rsiAtLow1 = 50, rsiAtLow2 = 50;
  let priceHigh1 = -Infinity, priceHigh2 = -Infinity;
  let rsiAtHigh1 = 50, rsiAtHigh2 = 50;

  const mid = Math.floor(n / 2);

  for (let i = 1; i < mid; i++) {
    if (prices[i] < priceLow1) { priceLow1 = prices[i]; rsiAtLow1 = recentRsi[i]; }
    if (prices[i] > priceHigh1) { priceHigh1 = prices[i]; rsiAtHigh1 = recentRsi[i]; }
  }

  for (let i = mid; i < n - 1; i++) {
    if (prices[i] < priceLow2) { priceLow2 = prices[i]; rsiAtLow2 = recentRsi[i]; }
    if (prices[i] > priceHigh2) { priceHigh2 = prices[i]; rsiAtHigh2 = recentRsi[i]; }
  }

  // Bullish divergence: price makes lower low, RSI makes higher low
  const bullish = priceLow2 < priceLow1 && rsiAtLow2 > rsiAtLow1 && rsiAtLow2 < 45;

  // Bearish divergence: price makes higher high, RSI makes lower high
  const bearish = priceHigh2 > priceHigh1 && rsiAtHigh2 < rsiAtHigh1 && rsiAtHigh2 > 55;

  return { bullish, bearish };
}

/**
 * Candlestick pattern detection — pure price action signals
 */
function detectCandlePatterns(candles) {
  const n = candles.length;
  if (n < 3) return { bullish: [], bearish: [] };

  const bullish = [];
  const bearish = [];

  const c0 = candles.at(-1);
  const c1 = candles.at(-2);
  const c2 = candles.at(-3);

  const body0 = Math.abs(c0.close - c0.open);
  const body1 = Math.abs(c1.close - c1.open);
  const range0 = c0.high - c0.low;
  const range1 = c1.high - c1.low;
  const upperWick0 = c0.high - Math.max(c0.close, c0.open);
  const lowerWick0 = Math.min(c0.close, c0.open) - c0.low;

  // Hammer / Pin Bar (bullish): small body, long lower wick
  if (
    lowerWick0 >= body0 * 2.5 &&
    upperWick0 <= body0 * 0.5 &&
    range0 > 0 &&
    c1.close < c1.open // Previous candle bearish
  ) {
    bullish.push('Hammer/Pin Bar');
  }

  // Shooting Star (bearish): small body, long upper wick
  if (
    upperWick0 >= body0 * 2.5 &&
    lowerWick0 <= body0 * 0.5 &&
    range0 > 0 &&
    c1.close > c1.open // Previous candle bullish
  ) {
    bearish.push('Shooting Star');
  }

  // Bullish Engulfing
  if (
    c1.close < c1.open &&
    c0.close > c0.open &&
    c0.open <= c1.close &&
    c0.close >= c1.open &&
    body0 > body1
  ) {
    bullish.push('Engulfing Haussier');
  }

  // Bearish Engulfing
  if (
    c1.close > c1.open &&
    c0.close < c0.open &&
    c0.open >= c1.close &&
    c0.close <= c1.open &&
    body0 > body1
  ) {
    bearish.push('Engulfing Baissier');
  }

  // Doji (indecision) — avoid trading
  if (body0 < range0 * 0.1 && range0 > 0) {
    // Flag as indecision — handled in signal logic
    bullish.push('Doji');
    bearish.push('Doji');
  }

  // Bullish Marubozu (strong bullish candle, no wicks)
  if (
    c0.close > c0.open &&
    upperWick0 < body0 * 0.05 &&
    lowerWick0 < body0 * 0.05 &&
    body0 > (range1 * 0.7)
  ) {
    bullish.push('Marubozu Haussier');
  }

  // Bearish Marubozu
  if (
    c0.close < c0.open &&
    upperWick0 < body0 * 0.05 &&
    lowerWick0 < body0 * 0.05 &&
    body0 > (range1 * 0.7)
  ) {
    bearish.push('Marubozu Baissier');
  }

  // Morning Star (3-candle bullish reversal)
  if (
    c2.close < c2.open && // First: bearish
    Math.abs(c1.close - c1.open) < (c1.high - c1.low) * 0.3 && // Second: doji/small
    c0.close > c0.open && // Third: bullish
    c0.close > (c2.open + c2.close) / 2 // Closes above midpoint of first
  ) {
    bullish.push('Morning Star');
  }

  // Evening Star (3-candle bearish reversal)
  if (
    c2.close > c2.open &&
    Math.abs(c1.close - c1.open) < (c1.high - c1.low) * 0.3 &&
    c0.close < c0.open &&
    c0.close < (c2.open + c2.close) / 2
  ) {
    bearish.push('Evening Star');
  }

  return { bullish: [...new Set(bullish)], bearish: [...new Set(bearish)] };
}

/**
 * Squeeze Momentum (Lazybear adaptation)
 * Detects when Bollinger Bands contract inside Keltner Channels — explosive move incoming
 */
function detectSqueeze(candles, bbPeriod = 20, keltnerPeriod = 20, keltnerMult = 1.5) {
  const closes = candles.map(c => c.close);
  const bb = calculateBollingerBands(closes, bbPeriod, 2);
  const atr = calculateATR(candles, keltnerPeriod);
  const ema = calculateEMA(closes, keltnerPeriod).at(-1) || closes.at(-1);
  const keltnerUpper = ema + keltnerMult * atr;
  const keltnerLower = ema - keltnerMult * atr;

  // Squeeze ON: BB inside Keltner — low volatility, big move incoming
  const squeezeOn = bb.upper < keltnerUpper && bb.lower > keltnerLower;

  // Momentum value for squeeze direction
  const highestHigh = Math.max(...candles.slice(-keltnerPeriod).map(c => c.high));
  const lowestLow = Math.min(...candles.slice(-keltnerPeriod).map(c => c.low));
  const midpoint = (highestHigh + lowestLow) / 2;
  const delta = closes.at(-1) - ((midpoint + ema) / 2);

  return {
    squeezeOn,
    squeezeMomentum: delta,
    squeezeBullish: delta > 0,
    squeezeBearish: delta < 0
  };
}

/**
 * Multi-timeframe simulation: use longer EMA periods to simulate higher TF bias
 */
function calculateHTFBias(candles) {
  const closes = candles.map(c => c.close);
  const price = closes.at(-1);

  // Simulate daily bias via EMA 100 & 200
  const ema100 = calculateEMA(closes, 100).at(-1);
  const ema200 = calculateEMA(closes, 200).at(-1);

  if (!Number.isFinite(ema100) || !Number.isFinite(ema200)) return 'NEUTRAL';
  if (price > ema100 && price > ema200 && ema100 > ema200) return 'BULLISH';
  if (price < ema100 && price < ema200 && ema100 < ema200) return 'BEARISH';
  return 'NEUTRAL';
}

/**
 * News sentiment score
 */
function normalizeNewsScore(news = '') {
  const text = String(news).toLowerCase();
  const bull = ['bullish', 'breakout', 'surge', 'rally', 'upgrade', 'adoption', 'buy', 'long', 'record', 'ath'];
  const bear = ['bearish', 'crash', 'dump', 'lawsuit', 'hack', 'ban', 'sell', 'short', 'correction', 'warning'];

  let score = 0;
  for (const w of bull) if (text.includes(w)) score++;
  for (const w of bear) if (text.includes(w)) score--;

  return Math.max(-8, Math.min(8, score * 2));
}

function strengthFromConfidence(confidence) {
  if (confidence >= 72) return 'FORTE';
  if (confidence >= 50) return 'MOYENNE';
  return 'FAIBLE';
}

// ============================================================
// TRADE PLAN — optimized R:R for scalping (min 1.5:1)
// ============================================================

function createScalpingTradePlan({ signal, score, price, atr, support, resistance, bb }) {
  const direction = signal === 'SELL' || (signal === 'HOLD' && score < 0) ? 'SELL' : 'BUY';
  const isBuy = direction === 'BUY';

  const usableAtr = Number.isFinite(atr) && atr > 0 ? atr : price * 0.002;

  // Risk calibrated tighter for scalping: 0.5–1× ATR
  const minRisk = price * 0.0005;
  const maxRisk = price * 0.008;
  const baseRisk = clamp(usableAtr * 0.55, minRisk, maxRisk);
  let risk = baseRisk;

  // Anchor SL to nearest S/R level if close enough
  if (isBuy && Number.isFinite(support) && support > 0 && support < price) {
    const supportRisk = price - support;
    if (supportRisk <= baseRisk * 1.8) {
      risk = Math.max(baseRisk, supportRisk * 1.05); // 5% buffer below support
    }
  }

  if (!isBuy && Number.isFinite(resistance) && resistance > price) {
    const resistanceRisk = resistance - price;
    if (resistanceRisk <= baseRisk * 1.8) {
      risk = Math.max(baseRisk, resistanceRisk * 1.05);
    }
  }

  const entry = price;
  const entryPad = clamp(usableAtr * 0.10, price * 0.00010, price * 0.0010);
  const stopLoss = isBuy ? entry - risk : entry + risk;

  // TP1 at 1.2:1, TP2 at 2.2:1, TP3 at 3.5:1 (trail to TP3 on strong momentum)
  const takeProfit1 = isBuy ? entry + risk * 1.2 : entry - risk * 1.2;
  const takeProfit2 = isBuy ? entry + risk * 2.2 : entry - risk * 2.2;
  const takeProfit3 = isBuy ? entry + risk * 3.5 : entry - risk * 3.5;

  // Use Bollinger midline as TP1 alt if closer
  if (bb && Number.isFinite(bb.middle)) {
    if (isBuy && bb.middle > entry && bb.middle < takeProfit1) {
      // TP1 is already closer — keep as-is, BB mid is intermediate
    }
  }

  const entryLow = isBuy ? entry - entryPad : entry + entryPad;
  const entryHigh = isBuy ? entry + entryPad : entry - entryPad;

  const safeSupport = Number.isFinite(support) && support > 0 ? support : stopLoss;
  const safeResistance = Number.isFinite(resistance) && resistance > 0 ? resistance : takeProfit2;

  const riskPerUnit = Math.abs(entry - stopLoss);

  return {
    action: signal === 'HOLD' ? `WAIT_${direction}` : direction,
    entry: formatPlanPrice(entry, price),
    entryZone: `${formatPlanPrice(Math.min(entryLow, entryHigh), price)} – ${formatPlanPrice(Math.max(entryLow, entryHigh), price)}`,
    stopLoss: formatPlanPrice(stopLoss, price),
    sl: formatPlanPrice(stopLoss, price),
    takeProfit1: formatPlanPrice(takeProfit1, price),
    takeProfit2: formatPlanPrice(takeProfit2, price),
    takeProfit3: formatPlanPrice(takeProfit3, price),
    tp1: formatPlanPrice(takeProfit1, price),
    tp2: formatPlanPrice(takeProfit2, price),
    tp3: formatPlanPrice(takeProfit3, price),
    takeProfit: [
      formatPlanPrice(takeProfit1, price),
      formatPlanPrice(takeProfit2, price),
      formatPlanPrice(takeProfit3, price)
    ],
    targets: [
      formatPlanPrice(takeProfit1, price),
      formatPlanPrice(takeProfit2, price),
      formatPlanPrice(takeProfit3, price)
    ],
    support: formatPlanPrice(safeSupport, price),
    resistance: formatPlanPrice(safeResistance, price),
    invalidation: formatPlanPrice(stopLoss, price),
    riskReward: {
      tp1: round(Math.abs(takeProfit1 - entry) / riskPerUnit, 2),
      tp2: round(Math.abs(takeProfit2 - entry) / riskPerUnit, 2),
      tp3: round(Math.abs(takeProfit3 - entry) / riskPerUnit, 2)
    },
    exitPlan: [
      'TP1 (1.2R): fermer 40% de la position, deplacer SL au breakeven.',
      'TP2 (2.2R): fermer 40% supplementaire, laisser 20% courir vers TP3.',
      'TP3 (3.5R): sortie totale ou trailing stop de 0.5× ATR.'
    ].join(' | ')
  };
}

// ============================================================
// MAIN SIGNAL ENGINE
// ============================================================

function generateScalpingSignal(candles, options = {}) {
  const MIN_CANDLES = 80;

  if (candles.length < MIN_CANDLES) {
    return {
      signal: 'HOLD',
      strength: 'FAIBLE',
      confidence: 0,
      score: 0,
      reasons: ['Donnees insuffisantes pour analyse fiable'],
      indicators: {},
      tradePlan: null
    };
  }

  const closes = candles.map(c => c.close);
  const last = candles.at(-1);
  const prev = candles.at(-2);
  const price = last.close;

  // ── Core indicators ──────────────────────────────────────────
  const ema9  = calculateEMA(closes, 9).at(-1);
  const ema21 = calculateEMA(closes, 21).at(-1);
  const ema50 = calculateEMA(closes, 50).at(-1);
  const ema200 = calculateEMA(closes, 200).at(-1);

  const rsi7   = calculateRSI(closes, 7);
  const rsi14  = calculateRSI(closes, 14);
  const rsiSeries14 = calculateRSISeries(closes, 14);
  const stochRsi = calculateStochRSI(closes, 14, 14, 3, 3);

  const macd = calculateMACD(closes);
  const atr  = calculateATR(candles, 14);
  const atrPercent = price ? (atr / price) * 100 : 0;

  const bb = calculateBollingerBands(closes, 20, 2);
  const vwapData = calculateVWAP(candles, 30);
  const { vwap } = vwapData;

  const volumeRatio = calculateVolumeRatio(candles, 20);
  const volumeTrend = calculateVolumeTrend(candles, 5);
  const momentum = calculateMomentum(closes, 5);
  const momentumThreshold = Math.max(0.06, Math.min(0.30, atrPercent * 0.18));

  const srLevels = calculateSupportResistance(candles, 60, 3);
  const { support, resistance } = srLevels;

  const marketStructure = detectMarketStructure(candles, 30);
  const htfBias = calculateHTFBias(candles);
  const divergence = detectRSIDivergence(candles, rsiSeries14, 20);
  const candlePatterns = detectCandlePatterns(candles);
  const squeeze = detectSqueeze(candles);

  // ── Derived context ───────────────────────────────────────────
  const range = Math.max(resistance - support, atr || price * 0.001);
  const nearSupport    = range > 0 ? (price - support) / range : 0.5;
  const nearResistance = range > 0 ? (resistance - price) / range : 0.5;

  const hasDoji = candlePatterns.bullish.includes('Doji');

  // ── SCORING ENGINE ────────────────────────────────────────────
  // Each factor has an explicit weight. Weights sum to ~100 for full alignment.
  // Signal is triggered only at score ≥ 42 AND minimum factor confirmations.

  let score = 0;
  const reasons = [];
  let confirmations = 0; // Count of independent confirming factors

  // ── 1. EMA Stack (trend alignment) — weight: 20 ──────────────
  if (Number.isFinite(ema9) && Number.isFinite(ema21) && Number.isFinite(ema50)) {
    if (ema9 > ema21 && ema21 > ema50) {
      score += 20;
      reasons.push('EMA stack haussier (9>21>50)');
      confirmations++;
    } else if (ema9 < ema21 && ema21 < ema50) {
      score -= 20;
      reasons.push('EMA stack baissier (9<21<50)');
      confirmations++;
    } else if (ema9 > ema21) {
      score += 8;
    } else if (ema9 < ema21) {
      score -= 8;
    }
  }

  // ── 2. EMA200 (macro bias) — weight: 8 ───────────────────────
  if (Number.isFinite(ema200)) {
    if (price > ema200) { score += 8; }
    else                { score -= 8; }
  }

  // ── 3. HTF Bias (multi-timeframe simulation) — weight: 10 ────
  if (htfBias === 'BULLISH') {
    score += 10;
    reasons.push('Biais HTF haussier');
    confirmations++;
  } else if (htfBias === 'BEARISH') {
    score -= 10;
    reasons.push('Biais HTF baissier');
    confirmations++;
  }

  // ── 4. Market Structure — weight: 12 ─────────────────────────
  if (marketStructure.trend === 'BULLISH') {
    score += 6 * marketStructure.strength;
    reasons.push(`Structure HH/HL (force ${marketStructure.strength})`);
    confirmations++;
  } else if (marketStructure.trend === 'BEARISH') {
    score -= 6 * marketStructure.strength;
    reasons.push(`Structure LH/LL (force ${marketStructure.strength})`);
    confirmations++;
  }

  // ── 5. VWAP Position & Bands — weight: 10 ────────────────────
  if (price > vwapData.upper1) {
    score += 5;
    reasons.push('Prix au-dessus VWAP +1σ');
  } else if (price > vwap) {
    score += 7;
  } else if (price < vwapData.lower1) {
    score -= 5;
    reasons.push('Prix en-dessous VWAP -1σ');
  } else if (price < vwap) {
    score -= 7;
  }

  // Extreme VWAP distance = mean reversion signal (counter)
  if (price > vwapData.upper2) {
    score -= 4;
    reasons.push('Survente VWAP extreme — risque retournement');
  }
  if (price < vwapData.lower2) {
    score += 4;
    reasons.push('Sousvendu VWAP extreme — potentiel rebond');
  }

  // ── 6. MACD — weight: 12 ─────────────────────────────────────
  if (macd.bullCross) {
    score += 12;
    reasons.push('Croisement MACD haussier');
    confirmations++;
  } else if (macd.bearCross) {
    score -= 12;
    reasons.push('Croisement MACD baissier');
    confirmations++;
  } else if (macd.histogram > 0 && macd.histogram > macd.prevHistogram) {
    score += 7;
    reasons.push('Histogramme MACD en expansion haussiere');
  } else if (macd.histogram < 0 && macd.histogram < macd.prevHistogram) {
    score -= 7;
    reasons.push('Histogramme MACD en expansion baissiere');
  } else if (macd.histogram > 0) {
    score += 4;
  } else if (macd.histogram < 0) {
    score -= 4;
  }

  // ── 7. RSI14 — weight: 8 ─────────────────────────────────────
  if (rsi14 >= 52 && rsi14 <= 68) {
    score += 8;
  } else if (rsi14 <= 48 && rsi14 >= 32) {
    score -= 8;
  } else if (rsi14 > 72) {
    score -= 6; // Overbought — fade risk
    reasons.push('RSI suracheté (>72) — risque retournement');
  } else if (rsi14 < 28) {
    score += 6; // Oversold — bounce potential
    reasons.push('RSI survendu (<28) — potentiel rebond');
  }

  // ── 8. Stochastic RSI — weight: 10 ───────────────────────────
  // Most sensitive indicator for scalping — catches micro turns
  const stochBullCross = stochRsi.kPrev < stochRsi.dPrev && stochRsi.k > stochRsi.d;
  const stochBearCross = stochRsi.kPrev > stochRsi.dPrev && stochRsi.k < stochRsi.d;

  if (stochBullCross && stochRsi.k < 50) {
    score += 10;
    reasons.push('Croisement StochRSI haussier en zone basse');
    confirmations++;
  } else if (stochBearCross && stochRsi.k > 50) {
    score -= 10;
    reasons.push('Croisement StochRSI baissier en zone haute');
    confirmations++;
  } else if (stochRsi.k > 80 && stochRsi.d > 80) {
    score -= 5;
    reasons.push('StochRSI en zone surach. — eviter nouveaux achats');
  } else if (stochRsi.k < 20 && stochRsi.d < 20) {
    score += 5;
    reasons.push('StochRSI en zone survendue — potentiel entree');
  }

  // ── 9. Bollinger Bands — weight: 10 ──────────────────────────
  if (bb.percentB < 0.05) {
    score += 7;
    reasons.push('Prix sur bande BB inferieure — signal rebond');
    confirmations++;
  } else if (bb.percentB > 0.95) {
    score -= 7;
    reasons.push('Prix sur bande BB superieure — signal retournement');
    confirmations++;
  } else if (bb.percentB > 0.55 && price > bb.middle) {
    score += 4;
  } else if (bb.percentB < 0.45 && price < bb.middle) {
    score -= 4;
  }

  // BB squeeze release — explosive move signal
  if (squeeze.squeezeOn) {
    if (squeeze.squeezeBullish) {
      score += 6;
      reasons.push('Squeeze BB — compression volatile, biais haussier');
    } else {
      score -= 6;
      reasons.push('Squeeze BB — compression volatile, biais baissier');
    }
  }

  // ── 10. Momentum — weight: 8 ─────────────────────────────────
  if (momentum > momentumThreshold) {
    score += 8;
    reasons.push('Momentum acheteur');
    confirmations++;
  } else if (momentum < -momentumThreshold) {
    score -= 8;
    reasons.push('Momentum vendeur');
    confirmations++;
  }

  // ── 11. Volume confirmation — weight: 8 ──────────────────────
  if (volumeRatio > 1.3 && last.close > last.open) {
    score += 8;
    reasons.push('Volume fort sur bougie haussiere');
    confirmations++;
  } else if (volumeRatio > 1.3 && last.close < last.open) {
    score -= 8;
    reasons.push('Volume fort sur bougie baissiere');
    confirmations++;
  } else if (volumeRatio > 1.1 && last.close > last.open) {
    score += 4;
  } else if (volumeRatio > 1.1 && last.close < last.open) {
    score -= 4;
  }

  // Volume trend adds conviction
  if (volumeTrend > 0.6 && score > 0) {
    score += 3;
    reasons.push('Volume en acceleration haussiere');
  } else if (volumeTrend < -0.6 && score < 0) {
    score -= 3;
    reasons.push('Volume en acceleration baissiere');
  }

  // ── 12. Support/Resistance proximity — weight: 6 ─────────────
  if (nearSupport < 0.12 && price > prev.close) {
    score += 6;
    reasons.push('Rebond sur support cle');
    confirmations++;
  } else if (nearResistance < 0.12 && price < prev.close) {
    score -= 6;
    reasons.push('Rejet sur resistance cle');
    confirmations++;
  }

  // ── 13. RSI Divergence — weight: 12 ──────────────────────────
  if (divergence.bullish) {
    score += 12;
    reasons.push('Divergence RSI haussiere — signal fort');
    confirmations++;
  } else if (divergence.bearish) {
    score -= 12;
    reasons.push('Divergence RSI baissiere — signal fort');
    confirmations++;
  }

  // ── 14. Candlestick Patterns — weight: 8 ─────────────────────
  const bullPatterns = candlePatterns.bullish.filter(p => p !== 'Doji');
  const bearPatterns = candlePatterns.bearish.filter(p => p !== 'Doji');

  const patternWeight = { 'Morning Star': 8, 'Engulfing Haussier': 7, 'Hammer/Pin Bar': 6, 'Marubozu Haussier': 5 };
  const patternWeightBear = { 'Evening Star': 8, 'Engulfing Baissier': 7, 'Shooting Star': 6, 'Marubozu Baissier': 5 };

  for (const p of bullPatterns) {
    const w = patternWeight[p] || 4;
    score += w;
    reasons.push(`Pattern: ${p}`);
    confirmations++;
    break; // Count only strongest pattern per direction
  }

  for (const p of bearPatterns) {
    const w = patternWeightBear[p] || 4;
    score -= w;
    reasons.push(`Pattern: ${p}`);
    confirmations++;
    break;
  }

  // ── 15. Doji penalty — contradicts scalping entry ─────────────
  if (hasDoji) {
    score *= 0.75;
    reasons.push('Doji — indecision, eviter entree');
  }

  // ── 16. Volatility filter — weight: penalty ───────────────────
  if (atrPercent > 5) {
    score *= 0.80;
    reasons.push('Volatilite tres elevee — reduire la taille');
  } else if (atrPercent < 0.05) {
    score *= 0.85;
    reasons.push('Volatilite trop basse — spread eleve, risque slippage');
  }

  // ── 17. RSI7 extreme filter ───────────────────────────────────
  if (rsi7 > 80 && score > 0) {
    score *= 0.80;
    reasons.push('RSI7 suracheté extremement — risque retournement immediat');
  }
  if (rsi7 < 20 && score < 0) {
    score *= 0.80;
    reasons.push('RSI7 survendu extremement — risque squeeze short');
  }

  // ── 18. News sentiment ────────────────────────────────────────
  const newsScore = normalizeNewsScore(options.news);
  if (newsScore !== 0) {
    score += newsScore;
    if (newsScore > 0) reasons.push('Sentiment newsflow positif');
    if (newsScore < 0) reasons.push('Sentiment newsflow negatif');
  }

  // ── Signal decision ───────────────────────────────────────────
  // Stricter threshold: score ≥ 42 AND at least 3 independent confirmations
  const absScore = Math.abs(score);
  const SIGNAL_THRESHOLD = 42;
  const MIN_CONFIRMATIONS = 3;

  const confidence = clamp(Math.round(absScore * 0.9), 0, 95);

  let signal = 'HOLD';

  if (score >= SIGNAL_THRESHOLD && confirmations >= MIN_CONFIRMATIONS) {
    signal = 'BUY';
  } else if (score <= -SIGNAL_THRESHOLD && confirmations >= MIN_CONFIRMATIONS) {
    signal = 'SELL';
  }

  // ── Conflict check: if HTF bias opposes signal, downgrade ─────
  if (signal === 'BUY' && htfBias === 'BEARISH') {
    signal = 'HOLD';
    reasons.push('Signal BUY annule: opposition biais HTF baissier');
  }
  if (signal === 'SELL' && htfBias === 'BULLISH') {
    signal = 'HOLD';
    reasons.push('Signal SELL annule: opposition biais HTF haussier');
  }

  if (!reasons.length) reasons.push('Marche neutre — signaux contradictoires');

  const tradePlan = createScalpingTradePlan({ signal, score, price, atr, support, resistance, bb });

  return {
    signal,
    strength: strengthFromConfidence(confidence),
    confidence,
    score: round(score, 1),
    confirmations,
    tradePlan,
    indicators: {
      rsi7:          round(rsi7, 2),
      rsi14:         round(rsi14, 2),
      stochRsiK:     round(stochRsi.k, 2),
      stochRsiD:     round(stochRsi.d, 2),
      ema9:          formatPrice(ema9),
      ema21:         formatPrice(ema21),
      ema50:         formatPrice(ema50),
      ema200:        formatPrice(ema200),
      macd:          round(macd.macd, 6),
      macdSignal:    round(macd.signal, 6),
      macdHistogram: round(macd.histogram, 6),
      macdCross:     macd.bullCross ? 'BULL' : macd.bearCross ? 'BEAR' : 'NONE',
      bbUpper:       formatPrice(bb.upper),
      bbMiddle:      formatPrice(bb.middle),
      bbLower:       formatPrice(bb.lower),
      bbPercentB:    round(bb.percentB, 3),
      bbSqueeze:     squeeze.squeezeOn,
      atr:           formatPrice(atr),
      atrPercent:    round(atrPercent, 2),
      vwap:          formatPrice(vwap),
      vwapUpper1:    formatPrice(vwapData.upper1),
      vwapLower1:    formatPrice(vwapData.lower1),
      volumeRatio:   round(volumeRatio, 2),
      volumeTrend:   round(volumeTrend, 2),
      momentum:      round(momentum, 3),
      support:       formatPrice(support),
      resistance:    formatPrice(resistance),
      htfBias,
      marketStructure: marketStructure.trend,
      divergence: {
        bullish: divergence.bullish,
        bearish: divergence.bearish
      },
      candlePatterns: {
        bullish: candlePatterns.bullish,
        bearish: candlePatterns.bearish
      }
    },
    reasons
  };
}

// ============================================================
// DATA LAYER (unchanged from original)
// ============================================================

function normalizeCandles(candles) {
  return candles
    .map(c => ({
      time: Number(c.time), open: Number(c.open), high: Number(c.high),
      low: Number(c.low), close: Number(c.close), volume: Number(c.volume || 0)
    }))
    .filter(c =>
      Number.isFinite(c.time) && Number.isFinite(c.open) &&
      Number.isFinite(c.high) && Number.isFinite(c.low) &&
      Number.isFinite(c.close) && c.open > 0 && c.high > 0 && c.low > 0 && c.close > 0
    )
    .sort((a, b) => a.time - b.time);
}

function applyCurrentPrice(candles, currentPrice) {
  if (!candles.length || !Number.isFinite(currentPrice) || currentPrice <= 0) return candles;
  const updated = candles.map(c => ({ ...c }));
  const last = updated.at(-1);
  last.close = currentPrice;
  last.high = Math.max(last.high, currentPrice);
  last.low = Math.min(last.low, currentPrice);
  return updated;
}

function aggregateCandles(candles, bucketMs) {
  if (!bucketMs) return candles;
  const grouped = new Map();
  for (const candle of candles) {
    const bucket = Math.floor(candle.time / bucketMs) * bucketMs;
    const current = grouped.get(bucket);
    if (!current) { grouped.set(bucket, { ...candle, time: bucket }); continue; }
    current.high = Math.max(current.high, candle.high);
    current.low = Math.min(current.low, candle.low);
    current.close = candle.close;
    current.volume += candle.volume || 0;
  }
  return [...grouped.values()].sort((a, b) => a.time - b.time);
}

function splitTradingViewSymbol(rawSymbol) {
  const raw = String(rawSymbol || '').trim();
  const parts = raw.split(':');
  if (parts.length > 1) return { exchange: parts[0].toLowerCase(), symbol: parts.slice(1).join(':') };
  return { exchange: '', symbol: raw };
}

function compactSymbol(symbol) {
  return String(symbol || '').toUpperCase().trim()
    .replace(/\s+/g, ' ').replace(/\.P$/, '').replace(/PERP$/, '');
}

function normalizeCryptoPair(rawSymbol) {
  const { exchange, symbol } = splitTradingViewSymbol(rawSymbol);
  const cleaned = compactSymbol(symbol).replace(/[-/_\s]/g, '').replace(/[^A-Z0-9]/g, '');
  const quotes = ['USDT', 'USDC', 'BUSD', 'USD', 'EUR', 'BTC', 'ETH'];
  const quote = quotes.find(q => cleaned.endsWith(q) && cleaned.length > q.length);
  const base = quote ? cleaned.slice(0, -quote.length) : cleaned;
  const stableQuote = quote && quote !== 'USD' ? quote : 'USDT';
  return {
    exchange, base, quote: quote || 'USDT',
    binanceSymbol: `${base}${stableQuote}`,
    bybitSymbol: `${base}${stableQuote}`,
    coinbaseProduct: `${base}-${quote === 'EUR' ? 'EUR' : 'USD'}`,
    bitstampPair: `${base}${quote === 'EUR' ? 'EUR' : 'USD'}`.toLowerCase()
  };
}

function resolveYahooSymbol(rawSymbol, type) {
  const { symbol } = splitTradingViewSymbol(rawSymbol);
  const normalized = compactSymbol(symbol);
  const aliasKey = normalized.replace(/[-/_^=.\s]/g, '');
  if (YAHOO_SYMBOL_ALIASES[normalized]) return YAHOO_SYMBOL_ALIASES[normalized];
  if (YAHOO_SYMBOL_ALIASES[aliasKey]) return YAHOO_SYMBOL_ALIASES[aliasKey];
  if (normalized.includes('=') || normalized.startsWith('^')) return normalized;
  const compact = normalized.replace(/[-/_\s]/g, '');
  if (type === 'forex' && /^[A-Z]{6}$/.test(compact)) return `${compact}=X`;
  return normalized;
}

function providerOrder(provider, exchange) {
  const preferred = String(provider || exchange || '').toLowerCase();
  if (preferred.includes('coinbase')) return ['coinbase', 'binance', 'bybit'];
  if (preferred.includes('bitstamp')) return ['bitstamp', 'coinbase', 'binance', 'bybit'];
  if (preferred.includes('bybit')) return ['bybit', 'binance', 'coinbase'];
  if (preferred.includes('yahoo')) return ['yahoo'];
  return ['binance', 'bybit', 'coinbase'];
}

async function fetchBinanceCrypto(pair, timeConfig) {
  const [klinesResponse, tickerResponse] = await Promise.all([
    HTTP.get('https://api.binance.com/api/v3/klines', {
      params: { symbol: pair.binanceSymbol, interval: timeConfig.binance, limit: 500 }
    }),
    HTTP.get('https://api.binance.com/api/v3/ticker/price', {
      params: { symbol: pair.binanceSymbol }
    }).catch(() => null)
  ]);
  const candles = normalizeCandles(klinesResponse.data.map(c => ({
    time: c[0], open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5]
  })));
  const currentPrice = Number(tickerResponse?.data?.price);
  return { candles: applyCurrentPrice(candles, currentPrice), currentPrice, source: `Binance Spot (${pair.binanceSymbol})` };
}

async function fetchBybitCrypto(pair, timeConfig) {
  const response = await HTTP.get('https://api.bybit.com/v5/market/kline', {
    params: { category: 'spot', symbol: pair.bybitSymbol, interval: timeConfig.bybit, limit: 500 }
  });
  if (response.data?.retCode !== 0) throw new Error(response.data?.retMsg || 'Bybit error');
  const candles = normalizeCandles((response.data?.result?.list || []).map(c => ({
    time: c[0], open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5]
  })));
  return { candles, currentPrice: candles.at(-1)?.close, source: `Bybit Spot (${pair.bybitSymbol})` };
}

async function fetchCoinbaseCrypto(pair, timeConfig) {
  if (!timeConfig.coinbaseGranularity) throw new Error('Intervalle non supporte par Coinbase');
  const end = Math.floor(Date.now() / 1000);
  const start = end - timeConfig.coinbaseGranularity * 300;
  const [response, tickerResponse] = await Promise.all([
    HTTP.get(`https://api.exchange.coinbase.com/products/${pair.coinbaseProduct}/candles`, {
      params: {
        start: new Date(start * 1000).toISOString(),
        end: new Date(end * 1000).toISOString(),
        granularity: timeConfig.coinbaseGranularity
      }
    }),
    HTTP.get(`https://api.exchange.coinbase.com/products/${pair.coinbaseProduct}/ticker`).catch(() => null)
  ]);
  const candles = normalizeCandles(response.data.map(c => ({
    time: c[0] * 1000, low: c[1], high: c[2], open: c[3], close: c[4], volume: c[5]
  })));
  const currentPrice = Number(tickerResponse?.data?.price);
  return { candles: applyCurrentPrice(candles, currentPrice), currentPrice, source: `Coinbase Exchange (${pair.coinbaseProduct})` };
}

async function fetchBitstampCrypto(pair, timeConfig) {
  if (!timeConfig.bitstampStep) throw new Error('Intervalle non supporte par Bitstamp');
  const [ohlcResponse, tickerResponse] = await Promise.all([
    HTTP.get(`https://www.bitstamp.net/api/v2/ohlc/${pair.bitstampPair}/`, {
      params: { step: timeConfig.bitstampStep, limit: 1000 }
    }),
    HTTP.get(`https://www.bitstamp.net/api/v2/ticker/${pair.bitstampPair}/`).catch(() => null)
  ]);
  let candles = normalizeCandles((ohlcResponse.data?.data?.ohlc || []).map(c => ({
    time: Number(c.timestamp) * 1000, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume
  })));
  candles = aggregateCandles(candles, timeConfig.bitstampAggregateMs);
  const currentPrice = Number(tickerResponse?.data?.last);
  return { candles: applyCurrentPrice(candles, currentPrice), currentPrice, source: `Bitstamp (${pair.bitstampPair.toUpperCase()})` };
}

async function fetchYahooMarket(rawSymbol, type, timeConfig) {
  const yahooSymbol = resolveYahooSymbol(rawSymbol, type);
  const response = await HTTP.get(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}`,
    { params: { interval: timeConfig.yahooInt, range: timeConfig.yahooRange, includePrePost: true, events: 'history' } }
  );
  const result = response.data?.chart?.result?.[0];
  const error = response.data?.chart?.error;
  if (!result || error) throw new Error(error?.description || 'Yahoo Finance error');
  const quote = result?.indicators?.quote?.[0];
  const timestamps = result?.timestamp || [];
  if (!quote) throw new Error('Yahoo Finance quote vide');
  let candles = normalizeCandles(timestamps.map((t, i) => ({
    time: t * 1000, open: quote.open?.[i], high: quote.high?.[i],
    low: quote.low?.[i], close: quote.close?.[i], volume: quote.volume?.[i] || 0
  })));
  candles = aggregateCandles(candles, timeConfig.aggregateMs);
  const currentPrice = Number(result?.meta?.regularMarketPrice);
  return { candles: applyCurrentPrice(candles, currentPrice), currentPrice, source: `Yahoo Finance (${yahooSymbol})` };
}

async function fetchCryptoMarket(rawSymbol, timeConfig, provider) {
  const pair = normalizeCryptoPair(rawSymbol);
  const attempts = providerOrder(provider, pair.exchange);
  const errors = [];
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

// ============================================================
// ROUTES
// ============================================================

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Trading backend is running' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: round(process.uptime(), 2), timestamp: new Date().toISOString() });
});

app.get('/market', async (req, res) => {
  try {
    let { symbol, type = 'crypto', interval = '15m', news = '', provider = '' } = req.query;

    if (!symbol) return res.status(400).json({ error: 'Symbol requis' });

    symbol = String(symbol).trim();
    type = String(type).toLowerCase().trim();
    if (type === 'indice' || type === 'indices') type = 'index';
    if (!INTERVAL_MAP[interval]) interval = '15m';

    const timeConfig = INTERVAL_MAP[interval];
    const cacheKey = `${type}-${symbol}-${interval}-${provider}`;

    if (CACHE.has(cacheKey)) {
      const cached = CACHE.get(cacheKey);
      if (Date.now() - cached.timestamp < timeConfig.cache) {
        return res.json(cached.data);
      }
    }

    const market = await fetchMarketData({ symbol, type, timeConfig, provider });

    if (!market.candles || market.candles.length < 80) {
      return res.status(404).json({
        error: 'Donnees insuffisantes (minimum 80 bougies requis)',
        source: market.source,
        candles: market.candles?.length || 0
      });
    }

    const closes = market.candles.map(c => c.close);
    const currentPrice =
      Number.isFinite(market.currentPrice) && market.currentPrice > 0
        ? market.currentPrice
        : median(closes.slice(-3));

    const candles = applyCurrentPrice(market.candles, currentPrice);
    const analysis = generateScalpingSignal(candles, { news });

    const data = {
      symbol: compactSymbol(symbol),
      type,
      interval,
      marketPrice: currentPrice,
      formattedPrice: formatPrice(currentPrice),
      source: market.source,
      ...analysis,
      timestamp: new Date().toISOString()
    };

    CACHE.set(cacheKey, { data, timestamp: Date.now() });
    return res.json(data);
  } catch (error) {
    console.error('Market error:', error.message);
    return res.status(502).json({
      error: 'Impossible de charger les donnees',
      details: process.env.NODE_ENV === 'production' ? undefined : error.message
    });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`Serveur lance sur ${HOST}:${PORT}`);
});

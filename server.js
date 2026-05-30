require('dotenv').config({ quiet: true });

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

// ============================================================
// OPTIONAL DEPS — graceful fallback si non installés
// ============================================================
let compression, rateLimit;
try { compression = require('compression'); } catch (_) { compression = null; }
try { rateLimit = require('express-rate-limit'); } catch (_) { rateLimit = null; }

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

app.set('trust proxy', 1);
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json());
if (compression) app.use(compression());

const AXIOS_TIMEOUT = Number(process.env.MARKET_TIMEOUT_MS || 8000);
const ROUTE_TIMEOUT_MS = Number(process.env.ROUTE_TIMEOUT_MS || 20000);

const HTTP = axios.create({
  timeout: AXIOS_TIMEOUT,
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    Accept: 'application/json,text/plain,*/*'
  }
});

// ============================================================
// RATE LIMITING
// ============================================================
if (rateLimit) {
  app.use('/market', rateLimit({
    windowMs: 60 * 1000,
    max: Number(process.env.RATE_LIMIT_MAX || 30),
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Trop de requêtes — réessayez dans une minute.' }
  }));
}

const INTERVAL_MAP = {
  '1m':  { binance: '1m',  bybit: '1',   yahooInt: '1m',  yahooRange: '5d',   coinbaseGranularity: 60,    bitstampStep: 60,    cache: 5000   },
  '5m':  { binance: '5m',  bybit: '5',   yahooInt: '5m',  yahooRange: '30d',  coinbaseGranularity: 300,   bitstampStep: 300,   cache: 10000  },
  '15m': { binance: '15m', bybit: '15',  yahooInt: '15m', yahooRange: '30d',  coinbaseGranularity: 900,   bitstampStep: 900,   cache: 15000  },
  '30m': { binance: '30m', bybit: '30',  yahooInt: '30m', yahooRange: '60d',  coinbaseGranularity: null,  bitstampStep: 1800,  cache: 20000  },
  '1h':  { binance: '1h',  bybit: '60',  yahooInt: '60m', yahooRange: '60d',  coinbaseGranularity: 3600,  bitstampStep: 3600,  cache: 30000  },
  '4h':  { binance: '4h',  bybit: '240', yahooInt: '60m', yahooRange: '60d',  coinbaseGranularity: 21600, bitstampStep: 14400, aggregateMs: 4 * 60 * 60 * 1000, cache: 60000  },
  '1d':  { binance: '1d',  bybit: 'D',   yahooInt: '1d',  yahooRange: '2y',   coinbaseGranularity: 86400, bitstampStep: 86400, cache: 120000 },
  '1w':  { binance: '1w',  bybit: 'W',   yahooInt: '1wk', yahooRange: '5y',   coinbaseGranularity: null,  bitstampStep: 86400, bitstampAggregateMs: 7 * 24 * 60 * 60 * 1000, cache: 300000 }
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
// SIGNAL LOCK MANAGER
// ============================================================

const SIGNAL_LOCK_MS       = Number(process.env.SIGNAL_LOCK_MS       || 3 * 60 * 1000);
const SIGNAL_MIN_CONFIRM   = Number(process.env.SIGNAL_MIN_CONFIRM   || 2);
const SIGNAL_OVERRIDE_CONF = Number(process.env.SIGNAL_OVERRIDE_CONF || 85);
const LOCKS_DUMP_FILE      = process.env.LOCKS_DUMP_FILE || path.join(__dirname, '.signal_locks.json');

const SIGNAL_LOCKS = new Map();

// --- Persistance des locks sur disque ---
function dumpLocks() {
  try {
    const now = Date.now();
    const active = [];
    for (const [key, lock] of SIGNAL_LOCKS.entries()) {
      if (now <= lock.expiresAt) active.push([key, lock]);
    }
    fs.writeFileSync(LOCKS_DUMP_FILE, JSON.stringify(active), 'utf8');
  } catch (_) { /* non-bloquant */ }
}

function loadLocks() {
  try {
    if (!fs.existsSync(LOCKS_DUMP_FILE)) return;
    const data = JSON.parse(fs.readFileSync(LOCKS_DUMP_FILE, 'utf8'));
    const now = Date.now();
    for (const [key, lock] of data) {
      if (lock.expiresAt > now) SIGNAL_LOCKS.set(key, lock);
    }
    fs.unlinkSync(LOCKS_DUMP_FILE);
    console.log(`[locks] ${SIGNAL_LOCKS.size} signal(s) rechargé(s) depuis le dump.`);
  } catch (_) { /* non-bloquant */ }
}

loadLocks();

process.on('SIGTERM', () => { dumpLocks(); process.exit(0); });
process.on('SIGINT',  () => { dumpLocks(); process.exit(0); });

function getLockedSignal(key) {
  const lock = SIGNAL_LOCKS.get(key);
  if (!lock) return null;
  if (Date.now() > lock.expiresAt) { SIGNAL_LOCKS.delete(key); return null; }
  return lock;
}

function resolveSignal(key, newAnalysis) {
  const now = Date.now();
  const existing = getLockedSignal(key);

  if (!existing) {
    if (newAnalysis.signal !== 'HOLD') {
      if (newAnalysis.confirmations < SIGNAL_MIN_CONFIRM) {
        return buildLockedResponse(null, newAnalysis, now);
      }
      const lock = {
        signal:      newAnalysis.signal,
        confidence:  newAnalysis.confidence,
        score:       newAnalysis.score,
        lockedAt:    now,
        expiresAt:   now + SIGNAL_LOCK_MS,
        rawAnalysis: newAnalysis
      };
      SIGNAL_LOCKS.set(key, lock);
      return buildLockedResponse(lock, newAnalysis, now);
    }
    return buildLockedResponse(null, newAnalysis, now);
  }

  if (existing.signal === newAnalysis.signal) {
    return buildLockedResponse(existing, newAnalysis, now);
  }

  if (
    newAnalysis.signal !== 'HOLD' &&
    newAnalysis.confidence >= SIGNAL_OVERRIDE_CONF &&
    newAnalysis.confirmations >= SIGNAL_MIN_CONFIRM
  ) {
    const lock = {
      signal:      newAnalysis.signal,
      confidence:  newAnalysis.confidence,
      score:       newAnalysis.score,
      lockedAt:    now,
      expiresAt:   now + SIGNAL_LOCK_MS,
      rawAnalysis: newAnalysis,
      overrideReason: `Override anticipé: confiance ${newAnalysis.confidence}% > seuil ${SIGNAL_OVERRIDE_CONF}%`
    };
    SIGNAL_LOCKS.set(key, lock);
    return buildLockedResponse(lock, newAnalysis, now);
  }

  return buildLockedResponse(existing, newAnalysis, now);
}

function buildLockedResponse(lock, freshAnalysis, now) {
  const isLocked = lock !== null;
  const secondsRemaining = isLocked ? Math.max(0, Math.round((lock.expiresAt - now) / 1000)) : 0;
  const minutesRemaining = Math.floor(secondsRemaining / 60);
  const secsDisplay      = secondsRemaining % 60;

  return {
    signal:        isLocked ? lock.signal      : freshAnalysis.signal,
    strength:      isLocked ? strengthFromConfidence(lock.confidence) : freshAnalysis.strength,
    confidence:    isLocked ? lock.confidence  : freshAnalysis.confidence,
    score:         isLocked ? lock.score       : freshAnalysis.score,
    confirmations: freshAnalysis.confirmations,

    signalLock: {
      active:           isLocked,
      lockedAt:         isLocked ? new Date(lock.lockedAt).toISOString()  : null,
      expiresAt:        isLocked ? new Date(lock.expiresAt).toISOString() : null,
      secondsRemaining,
      countdown:        isLocked ? `${minutesRemaining}:${String(secsDisplay).padStart(2, '0')}` : null,
      lockDurationMs:   SIGNAL_LOCK_MS,
      overrideReason:   lock?.overrideReason || null
    },

    // tradePlan et indicators toujours frais (prix live)
    tradePlan:  freshAnalysis.tradePlan,
    indicators: freshAnalysis.indicators,
    reasons:    isLocked
      ? [...lock.rawAnalysis.reasons, `Signal verrouillé — ${minutesRemaining}m${secsDisplay}s restantes`]
      : freshAnalysis.reasons
  };
}

// ============================================================
// CACHE LRU BORNÉ
// ============================================================

const CACHE_MAX_SIZE = Number(process.env.CACHE_MAX_SIZE || 200);

class LRUCache {
  constructor(maxSize) {
    this.maxSize = maxSize;
    this.map = new Map();
  }
  get(key) { return this.map.get(key); }
  has(key) { return this.map.has(key); }
  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.maxSize) {
      const oldestKey = this.map.keys().next().value;
      this.map.delete(oldestKey);
    }
  }
  delete(key) { this.map.delete(key); }
  get size() { return this.map.size; }
}

const CACHE = new LRUCache(CACHE_MAX_SIZE);

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

// ============================================================
// TECHNICAL INDICATORS
// ============================================================

function calculateRSI(prices, period = 14) {
  if (prices.length <= period) return 50;
  let avgGain = 0, avgLoss = 0;
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

function calculateRSISeries(prices, period = 14) {
  const result = new Array(prices.length).fill(null);
  if (prices.length <= period) return result;
  let avgGain = 0, avgLoss = 0;
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

function calculateStochRSI(prices, rsiPeriod = 14, stochPeriod = 14, kSmooth = 3, dSmooth = 3) {
  const rsiSeries = calculateRSISeries(prices, rsiPeriod);
  const validRsi  = rsiSeries.filter(v => v !== null);
  if (validRsi.length < stochPeriod) return { k: 50, d: 50, kPrev: 50, dPrev: 50 };
  const stochSeries = [];
  for (let i = stochPeriod - 1; i < validRsi.length; i++) {
    const window = validRsi.slice(i - stochPeriod + 1, i + 1);
    const lo = Math.min(...window), hi = Math.max(...window);
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
    k:     kSeries.at(-1) ?? 50,
    d:     dSeries.at(-1) ?? 50,
    kPrev: kSeries.at(-2) ?? 50,
    dPrev: dSeries.at(-2) ?? 50
  };
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

function calculateMACD(prices, fast = 12, slow = 26, signal = 9) {
  const emaFast = calculateEMA(prices, fast);
  const emaSlow = calculateEMA(prices, slow);

  const macdLine = prices.map((_, i) => {
    if (!Number.isFinite(emaFast[i]) || !Number.isFinite(emaSlow[i])) return null;
    return emaFast[i] - emaSlow[i];
  });

  const validMacd = macdLine.filter(v => v !== null);

  // CORRECTIF: guard si pas assez de données pour la signal line
  if (validMacd.length < signal) {
    return {
      macd: 0, signal: 0, histogram: 0, prevHistogram: 0,
      bullCross: false, bearCross: false, histogramSeries: macdLine.map(() => null)
    };
  }

  const signalLine = calculateEMA(validMacd, signal);

  const lastMacd   = macdLine.at(-1) ?? 0;
  const lastSig    = signalLine.at(-1) ?? 0;
  const prevMacd   = macdLine.at(-2) ?? 0;
  const prevSigVal = signalLine.at(-2) ?? 0;

  const bullCross = prevMacd <= prevSigVal && lastMacd > lastSig;
  const bearCross = prevMacd >= prevSigVal && lastMacd < lastSig;

  // CORRECTIF: mapping index correct entre macdLine et signalLine
  const macdOffset = macdLine.length - validMacd.length; // nb de nulls initiaux
  const histogramSeries = macdLine.map((m, i) => {
    const sigIdx = i - macdOffset - (validMacd.length - signalLine.length);
    if (m === null || sigIdx < 0 || sigIdx >= signalLine.length) return null;
    return m - signalLine[sigIdx];
  });

  return {
    macd:      lastMacd,
    signal:    lastSig,
    histogram: lastMacd - lastSig,
    prevHistogram: prevMacd - prevSigVal,
    bullCross, bearCross,
    histogramSeries
  };
}

function calculateATR(candles, period = 14) {
  if (candles.length <= period) return 0;
  const tr = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    tr.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  return average(tr.slice(-period));
}

function calculateBollingerBands(prices, period = 20, multiplier = 2) {
  if (prices.length < period) {
    const last = prices.at(-1) || 0;
    return { upper: last, middle: last, lower: last, width: 0, percentB: 0.5, std: 0 };
  }
  const recent   = prices.slice(-period);
  const middle   = average(recent);
  const std      = stdDev(recent);
  const upper    = middle + multiplier * std;
  const lower    = middle - multiplier * std;
  const width    = upper - lower;
  const price    = prices.at(-1);
  const percentB = width > 0 ? (price - lower) / width : 0.5;
  return { upper, middle, lower, width, percentB, std };
}

function calculateVWAP(candles, period = 30) {
  const recent = candles.slice(-period);
  let pv = 0, vol = 0;
  const typicals = [];
  for (const c of recent) {
    const typical = (c.high + c.low + c.close) / 3;
    pv += typical * c.volume;
    vol += c.volume;
    typicals.push(typical);
  }
  const vwap = vol > 0 ? pv / vol : recent.at(-1)?.close || 0;
  const variance = vol > 0
    ? recent.reduce((s, c, i) => s + c.volume * (typicals[i] - vwap) ** 2, 0) / vol
    : 0;
  const std = Math.sqrt(variance);
  return {
    vwap,
    upper1: vwap + std,     lower1: vwap - std,
    upper2: vwap + 2 * std, lower2: vwap - 2 * std
  };
}

function calculateVolumeRatio(candles, period = 20) {
  const vols = candles.map(c => c.volume);
  if (vols.length < period + 1) return 1;
  const current = vols.at(-1);
  const base = average(vols.slice(-(period + 1), -1));
  return base > 0 ? current / base : 1;
}

function calculateVolumeTrend(candles, period = 5) {
  const vols = candles.slice(-period).map(c => c.volume);
  if (vols.length < 2) return 0;
  let increasing = 0;
  for (let i = 1; i < vols.length; i++) if (vols[i] > vols[i - 1]) increasing++;
  return (increasing / (vols.length - 1)) * 2 - 1;
}

function calculateMomentum(prices, period = 5) {
  if (prices.length <= period) return 0;
  const current  = prices.at(-1);
  const previous = prices.at(-(period + 1));
  return previous ? ((current - previous) / previous) * 100 : 0;
}

function calculateSupportResistance(candles, lookback = 60, swingStrength = 3) {
  const recent    = candles.slice(-lookback);
  const swingHighs = [], swingLows = [];
  for (let i = swingStrength; i < recent.length - swingStrength; i++) {
    const pivot = recent[i];
    const isHigh = recent.slice(i - swingStrength, i + swingStrength + 1).every((c, j) => j === swingStrength || c.high <= pivot.high);
    const isLow  = recent.slice(i - swingStrength, i + swingStrength + 1).every((c, j) => j === swingStrength || c.low >= pivot.low);
    if (isHigh) swingHighs.push(pivot.high);
    if (isLow)  swingLows.push(pivot.low);
  }
  const price = candles.at(-1).close;
  const resistances = swingHighs.filter(h => h > price).sort((a, b) => a - b);
  const supports    = swingLows.filter(l => l < price).sort((a, b) => b - a);
  return {
    support:    supports[0]    ?? Math.min(...recent.map(c => c.low)),
    resistance: resistances[0] ?? Math.max(...recent.map(c => c.high)),
    supports:    supports.slice(0, 3),
    resistances: resistances.slice(0, 3)
  };
}

function detectMarketStructure(candles, period = 30) {
  const recent = candles.slice(-period);
  if (recent.length < 6) return { trend: 'NEUTRAL', strength: 0 };
  const highs    = recent.map(c => c.high);
  const lows     = recent.map(c => c.low);
  const lastHighs = highs.slice(-4), lastLows = lows.slice(-4);
  const hh = lastHighs[3] > lastHighs[1] && lastHighs[1] > lastHighs[0];
  const hl = lastLows[3]  > lastLows[1]  && lastLows[1]  > lastLows[0];
  const lh = lastHighs[3] < lastHighs[1] && lastHighs[1] < lastHighs[0];
  const ll = lastLows[3]  < lastLows[1]  && lastLows[1]  < lastLows[0];
  if (hh && hl) return { trend: 'BULLISH', strength: 2 };
  if (hh || hl) return { trend: 'BULLISH', strength: 1 };
  if (lh && ll) return { trend: 'BEARISH', strength: 2 };
  if (lh || ll) return { trend: 'BEARISH', strength: 1 };
  return { trend: 'NEUTRAL', strength: 0 };
}

function detectRSIDivergence(candles, rsiSeries, lookback = 20) {
  const recent    = candles.slice(-lookback);
  const recentRsi = rsiSeries.filter(v => v !== null).slice(-lookback);
  if (recent.length < 4 || recentRsi.length < 4) return { bullish: false, bearish: false };
  const prices = recent.map(c => c.close);
  const n = Math.min(prices.length, recentRsi.length);
  let priceLow1 = Infinity,  priceLow2 = Infinity;
  let rsiAtLow1 = 50,        rsiAtLow2 = 50;
  let priceHigh1 = -Infinity, priceHigh2 = -Infinity;
  let rsiAtHigh1 = 50,       rsiAtHigh2 = 50;
  const mid = Math.floor(n / 2);
  for (let i = 1; i < mid; i++) {
    if (prices[i] < priceLow1)  { priceLow1  = prices[i]; rsiAtLow1  = recentRsi[i]; }
    if (prices[i] > priceHigh1) { priceHigh1 = prices[i]; rsiAtHigh1 = recentRsi[i]; }
  }
  for (let i = mid; i < n - 1; i++) {
    if (prices[i] < priceLow2)  { priceLow2  = prices[i]; rsiAtLow2  = recentRsi[i]; }
    if (prices[i] > priceHigh2) { priceHigh2 = prices[i]; rsiAtHigh2 = recentRsi[i]; }
  }
  return {
    bullish: priceLow2  < priceLow1  && rsiAtLow2  > rsiAtLow1  && rsiAtLow2  < 45,
    bearish: priceHigh2 > priceHigh1 && rsiAtHigh2 < rsiAtHigh1 && rsiAtHigh2 > 55
  };
}

// ============================================================
// CANDLESTICK PATTERN ENGINE — amélioré
// ============================================================

/**
 * Détecte et quantifie les patterns de bougies avec :
 *   - poids différenciés par fiabilité
 *   - contexte obligatoire (tendance préalable)
 *   - bougie de confirmation (bougie N+1 qui valide le pattern)
 *
 * Retourne :
 *   bullish/bearish : liste des noms de patterns détectés
 *   bullScore/bearScore : score pondéré total
 *   confirmed : true si au moins un pattern fort est confirmé par la bougie suivante
 *   confirmationDetails : liste de descriptions pour les reasons
 */
function detectCandlePatterns(candles) {
  const n = candles.length;
  if (n < 4) return { bullish: [], bearish: [], bullScore: 0, bearScore: 0, confirmed: false, confirmationDetails: [] };

  const bullish = [];
  const bearish = [];
  const confirmationDetails = [];

  // Bougies récentes (indices depuis la fin)
  const c0 = candles.at(-1);  // bougie courante (la plus récente — potentielle confirmation)
  const c1 = candles.at(-2);  // bougie du signal
  const c2 = candles.at(-3);  // bougie N-2
  const c3 = candles.at(-4);  // bougie N-3 (pour contexte tendance)

  // Métriques bougie du signal (c1)
  const body1    = Math.abs(c1.close - c1.open);
  const range1   = c1.high - c1.low || 0.0001;
  const upperWick1 = c1.high - Math.max(c1.close, c1.open);
  const lowerWick1 = Math.min(c1.close, c1.open) - c1.low;
  const isBull1  = c1.close > c1.open;
  const isBear1  = c1.close < c1.open;

  // Métriques bougie de confirmation (c0)
  const body0    = Math.abs(c0.close - c0.open);
  const range0   = c0.high - c0.low || 0.0001;
  const upperWick0 = c0.high - Math.max(c0.close, c0.open);
  const lowerWick0 = Math.min(c0.close, c0.open) - c0.low;
  const isBull0  = c0.close > c0.open;
  const isBear0  = c0.close < c0.open;

  // Métriques c2 & c3
  const body2 = Math.abs(c2.close - c2.open);
  const body3 = Math.abs(c3.close - c3.open);

  // Contexte tendance sur 4 bougies précédant le signal
  const prevCandles = candles.slice(-6, -1);
  const trendBullish = prevCandles.at(-1).close > prevCandles[0].close;
  const trendBearish = prevCandles.at(-1).close < prevCandles[0].close;

  // Taille de référence pour juger les corps
  const avgBody = average(candles.slice(-10).map(c => Math.abs(c.close - c.open)));

  // Scores cumulés
  let bullScore = 0, bearScore = 0;
  let confirmed = false;

  // ─── Patterns 1 bougie (signal = c1, confirmation = c0) ───

  // Hammer / Pin Bar (haussier) — nécessite tendance baissière préalable
  if (
    lowerWick1 >= body1 * 2 && upperWick1 <= body1 * 0.5 &&
    range1 > 0 && trendBearish
  ) {
    const weight = 7;
    bullish.push('Hammer/Pin Bar');
    bullScore += weight;
    // Confirmation : c0 clôture au-dessus du milieu de c1
    if (isBull0 && c0.close > (c1.high + c1.low) / 2) {
      bullScore += 5;
      confirmed = true;
      confirmationDetails.push('Hammer confirmé par bougie haussière suivante');
    }
  }

  // Shooting Star (baissier) — nécessite tendance haussière préalable
  if (
    upperWick1 >= body1 * 2 && lowerWick1 <= body1 * 0.5 &&
    range1 > 0 && trendBullish
  ) {
    const weight = 7;
    bearish.push('Shooting Star');
    bearScore += weight;
    if (isBear0 && c0.close < (c1.high + c1.low) / 2) {
      bearScore += 5;
      confirmed = true;
      confirmationDetails.push('Shooting Star confirmé par bougie baissière suivante');
    }
  }

  // Inverted Hammer (haussier) — corps en haut, longue mèche haute, tendance baissière
  if (
    upperWick1 >= body1 * 2 && lowerWick1 <= body1 * 0.5 &&
    range1 > 0 && trendBearish
  ) {
    bullish.push('Inverted Hammer');
    bullScore += 5;
    if (isBull0 && c0.close > c1.high) {
      bullScore += 4;
      confirmed = true;
      confirmationDetails.push('Inverted Hammer confirmé — clôture au-dessus du high');
    }
  }

  // Hanging Man (baissier) — même forme que hammer mais après hausse
  if (
    lowerWick1 >= body1 * 2 && upperWick1 <= body1 * 0.5 &&
    range1 > 0 && trendBullish
  ) {
    bearish.push('Hanging Man');
    bearScore += 5;
    if (isBear0 && c0.close < c1.low) {
      bearScore += 4;
      confirmed = true;
      confirmationDetails.push('Hanging Man confirmé — clôture sous le low');
    }
  }

  // Marubozu haussier — corps plein sans mèches
  if (
    isBull1 && upperWick1 < body1 * 0.05 && lowerWick1 < body1 * 0.05 &&
    body1 > avgBody * 1.2
  ) {
    bullish.push('Marubozu Haussier');
    bullScore += 6;
    if (isBull0) { bullScore += 3; confirmationDetails.push('Marubozu haussier suivi d\'une clôture positive'); }
  }

  // Marubozu baissier
  if (
    isBear1 && upperWick1 < body1 * 0.05 && lowerWick1 < body1 * 0.05 &&
    body1 > avgBody * 1.2
  ) {
    bearish.push('Marubozu Baissier');
    bearScore += 6;
    if (isBear0) { bearScore += 3; confirmationDetails.push('Marubozu baissier suivi d\'une clôture négative'); }
  }

  // Doji — indécision (corps < 10% du range)
  if (body1 < range1 * 0.10) {
    bullish.push('Doji');
    bearish.push('Doji');
    // Pas de score — le Doji filtre le signal principal (appliqué plus bas)
  }

  // ─── Patterns 2 bougies (signal = c2+c1, confirmation = c0) ───

  // Engulfing haussier
  if (
    isBear2 && isBull1 &&
    c1.open <= c2.close && c1.close >= c2.open &&
    body1 > body2 * 0.9
  ) {
    bullish.push('Engulfing Haussier');
    bullScore += 9;
    if (isBull0 && c0.close > c1.close) {
      bullScore += 5;
      confirmed = true;
      confirmationDetails.push('Engulfing haussier confirmé — continuation haussière sur c0');
    }
  }

  // Engulfing baissier
  if (
    isBull2 && isBear1 &&
    c1.open >= c2.close && c1.close <= c2.open &&
    body1 > body2 * 0.9
  ) {
    bearish.push('Engulfing Baissier');
    bearScore += 9;
    if (isBear0 && c0.close < c1.close) {
      bearScore += 5;
      confirmed = true;
      confirmationDetails.push('Engulfing baissier confirmé — continuation baissière sur c0');
    }
  }

  // Tweezer Bottom (haussier) — deux bas similaires
  if (
    isBear2 && isBull1 &&
    Math.abs(c1.low - c2.low) / (range1 || 0.0001) < 0.08
  ) {
    bullish.push('Tweezer Bottom');
    bullScore += 6;
    if (isBull0) { bullScore += 3; confirmationDetails.push('Tweezer Bottom confirmé'); }
  }

  // Tweezer Top (baissier) — deux hauts similaires
  if (
    isBull2 && isBear1 &&
    Math.abs(c1.high - c2.high) / (range1 || 0.0001) < 0.08
  ) {
    bearish.push('Tweezer Top');
    bearScore += 6;
    if (isBear0) { bearScore += 3; confirmationDetails.push('Tweezer Top confirmé'); }
  }

  // Harami haussier — petite bougie haussière dans le corps d'une grande baissière
  if (
    isBear2 && isBull1 &&
    c1.open > c2.close && c1.close < c2.open &&
    body1 < body2 * 0.5
  ) {
    bullish.push('Harami Haussier');
    bullScore += 5;
    if (isBull0 && c0.close > c1.close) {
      bullScore += 4;
      confirmed = true;
      confirmationDetails.push('Harami haussier confirmé par rupture haussière');
    }
  }

  // Harami baissier
  if (
    isBull2 && isBear1 &&
    c1.open < c2.close && c1.close > c2.open &&
    body1 < body2 * 0.5
  ) {
    bearish.push('Harami Baissier');
    bearScore += 5;
    if (isBear0 && c0.close < c1.close) {
      bearScore += 4;
      confirmed = true;
      confirmationDetails.push('Harami baissier confirmé par rupture baissière');
    }
  }

  // Piercing Line (haussier) — clôture à >50% du corps de la bougie baissière
  if (
    isBear2 && isBull1 &&
    c1.open < c2.low &&
    c1.close > (c2.open + c2.close) / 2 &&
    c1.close < c2.open
  ) {
    bullish.push('Piercing Line');
    bullScore += 7;
    if (isBull0) { bullScore += 3; confirmed = true; confirmationDetails.push('Piercing Line confirmé'); }
  }

  // Dark Cloud Cover (baissier)
  if (
    isBull2 && isBear1 &&
    c1.open > c2.high &&
    c1.close < (c2.open + c2.close) / 2 &&
    c1.close > c2.open
  ) {
    bearish.push('Dark Cloud Cover');
    bearScore += 7;
    if (isBear0) { bearScore += 3; confirmed = true; confirmationDetails.push('Dark Cloud Cover confirmé'); }
  }

  // ─── Patterns 3 bougies (signal = c3+c2+c1, confirmation = c0) ───

  const isBear3 = c3.close < c3.open;
  const isBull3 = c3.close > c3.open;

  // Morning Star (haussier)
  if (
    isBear3 && body3 > avgBody &&
    Math.abs(c2.close - c2.open) < range1 * 0.3 &&
    isBull1 && c1.close > (c3.open + c3.close) / 2
  ) {
    bullish.push('Morning Star');
    bullScore += 10;
    if (isBull0 && c0.close > c1.close) {
      bullScore += 5;
      confirmed = true;
      confirmationDetails.push('Morning Star confirmé — continuation haussière');
    }
  }

  // Evening Star (baissier)
  if (
    isBull3 && body3 > avgBody &&
    Math.abs(c2.close - c2.open) < range1 * 0.3 &&
    isBear1 && c1.close < (c3.open + c3.close) / 2
  ) {
    bearish.push('Evening Star');
    bearScore += 10;
    if (isBear0 && c0.close < c1.close) {
      bearScore += 5;
      confirmed = true;
      confirmationDetails.push('Evening Star confirmé — continuation baissière');
    }
  }

  // Three White Soldiers (haussier) — 3 bougies haussières consécutives avec clôtures croissantes
  if (
    isBull3 && isBull2 && isBull1 &&
    c1.close > c2.close && c2.close > c3.close &&
    body1 > avgBody * 0.7 && body2 > avgBody * 0.7 && body3 > avgBody * 0.7 &&
    lowerWick1 < body1 * 0.3
  ) {
    bullish.push('Three White Soldiers');
    bullScore += 11;
    if (isBull0) { bullScore += 4; confirmed = true; confirmationDetails.push('Three White Soldiers confirmés'); }
  }

  // Three Black Crows (baissier)
  if (
    isBear3 && isBear2 && isBear1 &&
    c1.close < c2.close && c2.close < c3.close &&
    body1 > avgBody * 0.7 && body2 > avgBody * 0.7 && body3 > avgBody * 0.7 &&
    upperWick1 < body1 * 0.3
  ) {
    bearish.push('Three Black Crows');
    bearScore += 11;
    if (isBear0) { bearScore += 4; confirmed = true; confirmationDetails.push('Three Black Crows confirmés'); }
  }

  return {
    bullish:             [...new Set(bullish)],
    bearish:             [...new Set(bearish)],
    bullScore,
    bearScore,
    confirmed,
    confirmationDetails
  };
}

// Alias pour rétrocompat (isBear2 n'est pas accessible depuis detectCandlePatterns)
function isBear(c) { return c.close < c.open; }
function isBull(c) { return c.close > c.open; }
function get_isBear2(candles) { return isBear(candles.at(-3)); }

function detectSqueeze(candles, bbPeriod = 20, keltnerPeriod = 20, keltnerMult = 1.5) {
  const closes = candles.map(c => c.close);
  const bb     = calculateBollingerBands(closes, bbPeriod, 2);
  const atr    = calculateATR(candles, keltnerPeriod);
  const ema    = calculateEMA(closes, keltnerPeriod).at(-1) || closes.at(-1);
  const keltnerUpper = ema + keltnerMult * atr;
  const keltnerLower = ema - keltnerMult * atr;
  const squeezeOn    = bb.upper < keltnerUpper && bb.lower > keltnerLower;
  const highestHigh  = Math.max(...candles.slice(-keltnerPeriod).map(c => c.high));
  const lowestLow    = Math.min(...candles.slice(-keltnerPeriod).map(c => c.low));
  const midpoint     = (highestHigh + lowestLow) / 2;
  const delta        = closes.at(-1) - ((midpoint + ema) / 2);
  return { squeezeOn, squeezeMomentum: delta, squeezeBullish: delta > 0, squeezeBearish: delta < 0 };
}

function calculateHTFBias(candles) {
  const closes = candles.map(c => c.close);
  const price  = closes.at(-1);
  const ema100 = calculateEMA(closes, 100).at(-1);
  const ema200 = calculateEMA(closes, 200).at(-1);
  if (!Number.isFinite(ema100) || !Number.isFinite(ema200)) return 'NEUTRAL';
  if (price > ema100 && price > ema200 && ema100 > ema200) return 'BULLISH';
  if (price < ema100 && price < ema200 && ema100 < ema200) return 'BEARISH';
  return 'NEUTRAL';
}

function normalizeNewsScore(news = '') {
  const text = String(news).slice(0, 500).toLowerCase(); // CORRECTIF: sanitisation longueur
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
// TRADE PLAN
// ============================================================

function createScalpingTradePlan({ signal, score, price, atr, support, resistance, bb }) {
  const direction = signal === 'SELL' || (signal === 'HOLD' && score < 0) ? 'SELL' : 'BUY';
  const isBuyDir  = direction === 'BUY';

  const usableAtr = Number.isFinite(atr) && atr > 0 ? atr : price * 0.002;
  const minRisk   = price * 0.0005;
  const maxRisk   = price * 0.008;
  const baseRisk  = clamp(usableAtr * 0.55, minRisk, maxRisk);
  let risk = baseRisk;

  if (isBuyDir && Number.isFinite(support) && support > 0 && support < price) {
    const supportRisk = price - support;
    if (supportRisk <= baseRisk * 1.8) risk = Math.max(baseRisk, supportRisk * 1.05);
  }
  if (!isBuyDir && Number.isFinite(resistance) && resistance > price) {
    const resistanceRisk = resistance - price;
    if (resistanceRisk <= baseRisk * 1.8) risk = Math.max(baseRisk, resistanceRisk * 1.05);
  }

  const entry      = price;
  const entryPad   = clamp(usableAtr * 0.10, price * 0.00010, price * 0.0010);
  const stopLoss   = isBuyDir ? entry - risk : entry + risk;
  const tp1        = isBuyDir ? entry + risk * 1.2 : entry - risk * 1.2;
  const tp2        = isBuyDir ? entry + risk * 2.2 : entry - risk * 2.2;
  const tp3        = isBuyDir ? entry + risk * 3.5 : entry - risk * 3.5;
  const entryLow   = isBuyDir ? entry - entryPad : entry + entryPad;
  const entryHigh  = isBuyDir ? entry + entryPad : entry - entryPad;
  const safeSupport    = Number.isFinite(support)    && support    > 0 ? support    : stopLoss;
  const safeResistance = Number.isFinite(resistance) && resistance > 0 ? resistance : tp2;
  const riskPerUnit = Math.abs(entry - stopLoss);

  return {
    action:      signal === 'HOLD' ? `WAIT_${direction}` : direction,
    entry:       formatPlanPrice(entry, price),
    entryZone:   `${formatPlanPrice(Math.min(entryLow, entryHigh), price)} – ${formatPlanPrice(Math.max(entryLow, entryHigh), price)}`,
    stopLoss:    formatPlanPrice(stopLoss, price),
    sl:          formatPlanPrice(stopLoss, price),
    takeProfit1: formatPlanPrice(tp1, price),
    takeProfit2: formatPlanPrice(tp2, price),
    takeProfit3: formatPlanPrice(tp3, price),
    tp1:         formatPlanPrice(tp1, price),
    tp2:         formatPlanPrice(tp2, price),
    tp3:         formatPlanPrice(tp3, price),
    takeProfit:  [formatPlanPrice(tp1, price), formatPlanPrice(tp2, price), formatPlanPrice(tp3, price)],
    targets:     [formatPlanPrice(tp1, price), formatPlanPrice(tp2, price), formatPlanPrice(tp3, price)],
    support:     formatPlanPrice(safeSupport, price),
    resistance:  formatPlanPrice(safeResistance, price),
    invalidation: formatPlanPrice(stopLoss, price),
    riskReward:  {
      tp1: round(Math.abs(tp1 - entry) / riskPerUnit, 2),
      tp2: round(Math.abs(tp2 - entry) / riskPerUnit, 2),
      tp3: round(Math.abs(tp3 - entry) / riskPerUnit, 2)
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
      signal: 'HOLD', strength: 'FAIBLE', confidence: 0, score: 0,
      confirmations: 0,
      reasons: ['Donnees insuffisantes pour analyse fiable'],
      indicators: {}, tradePlan: null
    };
  }

  const closes = candles.map(c => c.close);
  const last   = candles.at(-1);
  const prev   = candles.at(-2);
  const price  = last.close;

  // ── EMAs ──
  const ema9   = calculateEMA(closes, 9).at(-1);
  const ema21  = calculateEMA(closes, 21).at(-1);
  const ema50  = calculateEMA(closes, 50).at(-1);
  const ema200 = calculateEMA(closes, 200).at(-1);

  // ── Oscillateurs ──
  const rsi7        = calculateRSI(closes, 7);
  const rsi14       = calculateRSI(closes, 14);
  const rsiSeries14 = calculateRSISeries(closes, 14);
  const stochRsi    = calculateStochRSI(closes, 14, 14, 3, 3);
  const macd        = calculateMACD(closes);

  // ── Volatilité & bandes ──
  const atr        = calculateATR(candles, 14);
  const atrPercent = price ? (atr / price) * 100 : 0;
  const bb         = calculateBollingerBands(closes, 20, 2);

  // ── Volume & VWAP ──
  const vwapData    = calculateVWAP(candles, 30);
  const { vwap }    = vwapData;
  const volumeRatio = calculateVolumeRatio(candles, 20);
  const volumeTrend = calculateVolumeTrend(candles, 5);

  // ── Momentum ──
  const momentum          = calculateMomentum(closes, 5);
  const momentumThreshold = Math.max(0.06, Math.min(0.30, atrPercent * 0.18));

  // ── Structure & niveaux ──
  const srLevels       = calculateSupportResistance(candles, 60, 3);
  const { support, resistance } = srLevels;
  const marketStructure = detectMarketStructure(candles, 30);
  const htfBias         = calculateHTFBias(candles);
  const divergence      = detectRSIDivergence(candles, rsiSeries14, 20);

  // ── Candlestick patterns ──
  const candlePatterns = detectCandlePatterns(candles);
  const squeeze        = detectSqueeze(candles);

  const range          = Math.max(resistance - support, atr || price * 0.001);
  const nearSupport    = range > 0 ? (price - support) / range : 0.5;
  const nearResistance = range > 0 ? (resistance - price) / range : 0.5;

  const hasDoji = candlePatterns.bullish.includes('Doji');

  let score         = 0;
  const reasons     = [];
  let confirmations = 0;

  // ── EMA STACK ──
  if (Number.isFinite(ema9) && Number.isFinite(ema21) && Number.isFinite(ema50)) {
    if (ema9 > ema21 && ema21 > ema50)      { score += 20; reasons.push('EMA stack haussier (9>21>50)'); confirmations++; }
    else if (ema9 < ema21 && ema21 < ema50) { score -= 20; reasons.push('EMA stack baissier (9<21<50)'); confirmations++; }
    else if (ema9 > ema21)                  { score += 8; }
    else if (ema9 < ema21)                  { score -= 8; }
  }
  if (Number.isFinite(ema200)) {
    if (price > ema200) score += 8;
    else                score -= 8;
  }

  // ── BIAIS HTF ──
  if (htfBias === 'BULLISH')      { score += 10; reasons.push('Biais HTF haussier'); confirmations++; }
  else if (htfBias === 'BEARISH') { score -= 10; reasons.push('Biais HTF baissier'); confirmations++; }

  // ── STRUCTURE DE MARCHÉ ──
  if (marketStructure.trend === 'BULLISH')      { score += 6 * marketStructure.strength; reasons.push(`Structure HH/HL (force ${marketStructure.strength})`); confirmations++; }
  else if (marketStructure.trend === 'BEARISH') { score -= 6 * marketStructure.strength; reasons.push(`Structure LH/LL (force ${marketStructure.strength})`); confirmations++; }

  // ── VWAP ──
  if (price > vwapData.upper1)       { score += 5; reasons.push('Prix au-dessus VWAP +1σ'); }
  else if (price > vwap)             { score += 7; }
  else if (price < vwapData.lower1)  { score -= 5; reasons.push('Prix en-dessous VWAP -1σ'); }
  else if (price < vwap)             { score -= 7; }
  if (price > vwapData.upper2)       { score -= 4; reasons.push('Survente VWAP extreme — risque retournement'); }
  if (price < vwapData.lower2)       { score += 4; reasons.push('Sousvendu VWAP extreme — potentiel rebond'); }

  // ── MACD ──
  if (macd.bullCross)                                                        { score += 12; reasons.push('Croisement MACD haussier'); confirmations++; }
  else if (macd.bearCross)                                                   { score -= 12; reasons.push('Croisement MACD baissier'); confirmations++; }
  else if (macd.histogram > 0 && macd.histogram > macd.prevHistogram)       { score += 7;  reasons.push('Histogramme MACD en expansion haussiere'); }
  else if (macd.histogram < 0 && macd.histogram < macd.prevHistogram)       { score -= 7;  reasons.push('Histogramme MACD en expansion baissiere'); }
  else if (macd.histogram > 0)                                              { score += 4; }
  else if (macd.histogram < 0)                                              { score -= 4; }

  // ── RSI 14 ──
  if      (rsi14 >= 52 && rsi14 <= 68) { score += 8; }
  else if (rsi14 <= 48 && rsi14 >= 32) { score -= 8; }
  else if (rsi14 > 72)                 { score -= 6; reasons.push('RSI suracheté (>72) — risque retournement'); }
  else if (rsi14 < 28)                 { score += 6; reasons.push('RSI survendu (<28) — potentiel rebond'); }

  // ── STOCH RSI ──
  const stochBullCross = stochRsi.kPrev < stochRsi.dPrev && stochRsi.k > stochRsi.d;
  const stochBearCross = stochRsi.kPrev > stochRsi.dPrev && stochRsi.k < stochRsi.d;
  if      (stochBullCross && stochRsi.k < 50) { score += 10; reasons.push('Croisement StochRSI haussier en zone basse'); confirmations++; }
  else if (stochBearCross && stochRsi.k > 50) { score -= 10; reasons.push('Croisement StochRSI baissier en zone haute'); confirmations++; }
  else if (stochRsi.k > 80 && stochRsi.d > 80) { score -= 5; reasons.push('StochRSI en zone surach. — eviter nouveaux achats'); }
  else if (stochRsi.k < 20 && stochRsi.d < 20) { score += 5; reasons.push('StochRSI en zone survendue — potentiel entree'); }

  // ── BOLLINGER BANDS ──
  if      (bb.percentB < 0.05)                       { score += 7; reasons.push('Prix sur bande BB inferieure — signal rebond'); confirmations++; }
  else if (bb.percentB > 0.95)                       { score -= 7; reasons.push('Prix sur bande BB superieure — signal retournement'); confirmations++; }
  else if (bb.percentB > 0.55 && price > bb.middle) { score += 4; }
  else if (bb.percentB < 0.45 && price < bb.middle) { score -= 4; }

  // ── SQUEEZE ──
  if (squeeze.squeezeOn) {
    if (squeeze.squeezeBullish) { score += 6; reasons.push('Squeeze BB — compression volatile, biais haussier'); }
    else                        { score -= 6; reasons.push('Squeeze BB — compression volatile, biais baissier'); }
  }

  // ── MOMENTUM ──
  if      (momentum > momentumThreshold)  { score += 8; reasons.push('Momentum acheteur'); confirmations++; }
  else if (momentum < -momentumThreshold) { score -= 8; reasons.push('Momentum vendeur'); confirmations++; }

  // ── VOLUME ──
  if      (volumeRatio > 1.3 && last.close > last.open) { score += 8; reasons.push('Volume fort sur bougie haussiere'); confirmations++; }
  else if (volumeRatio > 1.3 && last.close < last.open) { score -= 8; reasons.push('Volume fort sur bougie baissiere'); confirmations++; }
  else if (volumeRatio > 1.1 && last.close > last.open) { score += 4; }
  else if (volumeRatio > 1.1 && last.close < last.open) { score -= 4; }
  if (volumeTrend > 0.6 && score > 0)  { score += 3; reasons.push('Volume en acceleration haussiere'); }
  else if (volumeTrend < -0.6 && score < 0) { score -= 3; reasons.push('Volume en acceleration baissiere'); }

  // ── SUPPORT / RÉSISTANCE ──
  if      (nearSupport    < 0.12 && price > prev.close) { score += 6; reasons.push('Rebond sur support cle'); confirmations++; }
  else if (nearResistance < 0.12 && price < prev.close) { score -= 6; reasons.push('Rejet sur resistance cle'); confirmations++; }

  // ── DIVERGENCE RSI ──
  if      (divergence.bullish) { score += 12; reasons.push('Divergence RSI haussiere — signal fort'); confirmations++; }
  else if (divergence.bearish) { score -= 12; reasons.push('Divergence RSI baissiere — signal fort'); confirmations++; }

  // ── CANDLESTICK PATTERNS — intégrés au scoring avec poids et confirmation ──
  if (candlePatterns.bullScore > 0 || candlePatterns.bearScore > 0) {
    // Appliquer les scores de patterns directement
    score += candlePatterns.bullScore;
    score -= candlePatterns.bearScore;

    // Ajouter les patterns bullish au log
    const bullPatternsFiltered = candlePatterns.bullish.filter(p => p !== 'Doji');
    const bearPatternsFiltered = candlePatterns.bearish.filter(p => p !== 'Doji');

    if (bullPatternsFiltered.length) {
      reasons.push(`Pattern(s) haussier(s): ${bullPatternsFiltered.join(', ')}`);
      confirmations++;
    }
    if (bearPatternsFiltered.length) {
      reasons.push(`Pattern(s) baissier(s): ${bearPatternsFiltered.join(', ')}`);
      confirmations++;
    }

    // Bougies de confirmation détectées par le pattern engine
    if (candlePatterns.confirmationDetails.length) {
      for (const detail of candlePatterns.confirmationDetails) {
        reasons.push(detail);
      }
      // Une confirmation de pattern = +1 confirmation globale supplémentaire
      if (candlePatterns.confirmed) confirmations++;
    }
  }

  // ── FILTRES GLOBAUX ──
  // Doji neutralise le signal (indécision)
  if (hasDoji)                          { score *= 0.75; reasons.push('Doji — indecision, eviter entree'); }
  // Volatilité extrême
  if (atrPercent > 5)                   { score *= 0.80; reasons.push('Volatilite tres elevee — reduire la taille'); }
  else if (atrPercent < 0.05)           { score *= 0.85; reasons.push('Volatilite trop basse — spread eleve, risque slippage'); }
  // RSI7 extrême
  if (rsi7 > 80 && score > 0)           { score *= 0.80; reasons.push('RSI7 suracheté extremement — risque retournement immediat'); }
  if (rsi7 < 20 && score < 0)           { score *= 0.80; reasons.push('RSI7 survendu extremement — risque squeeze short'); }

  // ── NEWS ──
  const newsScore = normalizeNewsScore(options.news);
  if (newsScore !== 0) {
    score += newsScore;
    if (newsScore > 0) reasons.push('Sentiment newsflow positif');
    if (newsScore < 0) reasons.push('Sentiment newsflow negatif');
  }

  // ── DÉCISION FINALE ──
  const absScore           = Math.abs(score);
  const SIGNAL_THRESHOLD   = 42;
  const MIN_CONFIRMATIONS  = 3;
  const confidence         = clamp(Math.round(absScore * 0.9), 0, 95);

  let signal = 'HOLD';
  if      (score >= SIGNAL_THRESHOLD  && confirmations >= MIN_CONFIRMATIONS) signal = 'BUY';
  else if (score <= -SIGNAL_THRESHOLD && confirmations >= MIN_CONFIRMATIONS) signal = 'SELL';

  // Filtre HTF final
  if (signal === 'BUY'  && htfBias === 'BEARISH') { signal = 'HOLD'; reasons.push('Signal BUY annule: opposition biais HTF baissier'); }
  if (signal === 'SELL' && htfBias === 'BULLISH') { signal = 'HOLD'; reasons.push('Signal SELL annule: opposition biais HTF haussier'); }

  if (!reasons.length) reasons.push('Marche neutre — signaux contradictoires');

  const tradePlan = createScalpingTradePlan({ signal, score, price, atr, support, resistance, bb });

  return {
    signal,
    strength:      strengthFromConfidence(confidence),
    confidence,
    score:         round(score, 1),
    confirmations,
    tradePlan,
    indicators: {
      rsi7:         round(rsi7, 2),
      rsi14:        round(rsi14, 2),
      stochRsiK:    round(stochRsi.k, 2),
      stochRsiD:    round(stochRsi.d, 2),
      ema9:         formatPrice(ema9),
      ema21:        formatPrice(ema21),
      ema50:        formatPrice(ema50),
      ema200:       formatPrice(ema200),
      macd:         round(macd.macd, 6),
      macdSignal:   round(macd.signal, 6),
      macdHistogram: round(macd.histogram, 6),
      macdCross:    macd.bullCross ? 'BULL' : macd.bearCross ? 'BEAR' : 'NONE',
      bbUpper:      formatPrice(bb.upper),
      bbMiddle:     formatPrice(bb.middle),
      bbLower:      formatPrice(bb.lower),
      bbPercentB:   round(bb.percentB, 3),
      bbSqueeze:    squeeze.squeezeOn,
      atr:          formatPrice(atr),
      atrPercent:   round(atrPercent, 2),
      vwap:         formatPrice(vwap),
      vwapUpper1:   formatPrice(vwapData.upper1),
      vwapLower1:   formatPrice(vwapData.lower1),
      volumeRatio:  round(volumeRatio, 2),
      volumeTrend:  round(volumeTrend, 2),
      momentum:     round(momentum, 3),
      support:      formatPrice(support),
      resistance:   formatPrice(resistance),
      htfBias,
      marketStructure: marketStructure.trend,
      divergence:   { bullish: divergence.bullish, bearish: divergence.bearish },
      candlePatterns: {
        bullish:            candlePatterns.bullish,
        bearish:            candlePatterns.bearish,
        bullScore:          candlePatterns.bullScore,
        bearScore:          candlePatterns.bearScore,
        confirmed:          candlePatterns.confirmed,
        confirmationDetails: candlePatterns.confirmationDetails
      }
    },
    reasons
  };
}

// ============================================================
// DATA LAYER
// ============================================================

function normalizeCandles(candles) {
  return candles
    .map(c => ({
      time: Number(c.time), open: Number(c.open), high: Number(c.high),
      low: Number(c.low),   close: Number(c.close), volume: Number(c.volume || 0)
    }))
    .filter(c =>
      Number.isFinite(c.time) && Number.isFinite(c.open) && Number.isFinite(c.high) &&
      Number.isFinite(c.low)  && Number.isFinite(c.close) &&
      c.open > 0 && c.high > 0 && c.low > 0 && c.close > 0
    )
    .sort((a, b) => a.time - b.time);
}

function applyCurrentPrice(candles, currentPrice) {
  if (!candles.length || !Number.isFinite(currentPrice) || currentPrice <= 0) return candles;
  const updated = candles.map(c => ({ ...c }));
  const last    = updated.at(-1);
  last.close    = currentPrice;
  last.high     = Math.max(last.high, currentPrice);
  last.low      = Math.min(last.low,  currentPrice);
  return updated;
}

function aggregateCandles(candles, bucketMs) {
  if (!bucketMs) return candles;
  const grouped = new Map();
  for (const candle of candles) {
    const bucket  = Math.floor(candle.time / bucketMs) * bucketMs;
    const current = grouped.get(bucket);
    if (!current) { grouped.set(bucket, { ...candle, time: bucket }); continue; }
    current.high   = Math.max(current.high, candle.high);
    current.low    = Math.min(current.low,  candle.low);
    current.close  = candle.close;
    current.volume += candle.volume || 0;
  }
  return [...grouped.values()].sort((a, b) => a.time - b.time);
}

function splitTradingViewSymbol(rawSymbol) {
  const raw   = String(rawSymbol || '').trim();
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
  const cleaned  = compactSymbol(symbol).replace(/[-/_\s]/g, '').replace(/[^A-Z0-9]/g, '');
  const quotes   = ['USDT', 'USDC', 'BUSD', 'USD', 'EUR', 'BTC', 'ETH'];
  const quote    = quotes.find(q => cleaned.endsWith(q) && cleaned.length > q.length);
  const base     = quote ? cleaned.slice(0, -quote.length) : cleaned;
  const stableQ  = quote && quote !== 'USD' ? quote : 'USDT';
  return {
    exchange, base, quote: quote || 'USDT',
    binanceSymbol:   `${base}${stableQ}`,
    bybitSymbol:     `${base}${stableQ}`,
    coinbaseProduct: `${base}-${quote === 'EUR' ? 'EUR' : 'USD'}`,
    bitstampPair:    `${base}${quote === 'EUR' ? 'EUR' : 'USD'}`.toLowerCase()
  };
}

function resolveYahooSymbol(rawSymbol, type) {
  const { symbol } = splitTradingViewSymbol(rawSymbol);
  const normalized = compactSymbol(symbol);
  const aliasKey   = normalized.replace(/[-/_^=.\s]/g, '');
  if (YAHOO_SYMBOL_ALIASES[normalized]) return YAHOO_SYMBOL_ALIASES[normalized];
  if (YAHOO_SYMBOL_ALIASES[aliasKey])   return YAHOO_SYMBOL_ALIASES[aliasKey];
  if (normalized.includes('=') || normalized.startsWith('^')) return normalized;
  const compact = normalized.replace(/[-/_\s]/g, '');
  if (type === 'forex' && /^[A-Z]{6}$/.test(compact)) return `${compact}=X`;
  return normalized;
}

function providerOrder(provider, exchange) {
  const preferred = String(provider || exchange || '').toLowerCase();
  if (preferred.includes('coinbase')) return ['coinbase', 'binance', 'bybit'];
  if (preferred.includes('bitstamp')) return ['bitstamp', 'coinbase', 'binance', 'bybit'];
  if (preferred.includes('bybit'))    return ['bybit', 'binance', 'coinbase'];
  if (preferred.includes('yahoo'))    return ['yahoo'];
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
  const error  = response.data?.chart?.error;
  if (!result || error) throw new Error(error?.description || 'Yahoo Finance error');
  const quote      = result?.indicators?.quote?.[0];
  const timestamps = result?.timestamp || [];
  if (!quote) throw new Error('Yahoo Finance quote vide');
  let candles = normalizeCandles(timestamps.map((t, i) => ({
    time: t * 1000, open: quote.open?.[i], high: quote.high?.[i],
    low:  quote.low?.[i],  close: quote.close?.[i], volume: quote.volume?.[i] || 0
  })));
  candles = aggregateCandles(candles, timeConfig.aggregateMs);
  const currentPrice = Number(result?.meta?.regularMarketPrice);
  return { candles: applyCurrentPrice(candles, currentPrice), currentPrice, source: `Yahoo Finance (${yahooSymbol})` };
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

// ============================================================
// ROUTES
// ============================================================

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Trading backend is running' });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: round(process.uptime(), 2),
    timestamp: new Date().toISOString(),
    cache: { size: CACHE.size, maxSize: CACHE_MAX_SIZE },
    locks: { active: SIGNAL_LOCKS.size }
  });
});

app.get('/signal-status', (req, res) => {
  const now    = Date.now();
  const active = [];
  for (const [key, lock] of SIGNAL_LOCKS.entries()) {
    if (now > lock.expiresAt) { SIGNAL_LOCKS.delete(key); continue; }
    const secondsRemaining = Math.max(0, Math.round((lock.expiresAt - now) / 1000));
    active.push({
      key,
      signal:           lock.signal,
      confidence:       lock.confidence,
      lockedAt:         new Date(lock.lockedAt).toISOString(),
      expiresAt:        new Date(lock.expiresAt).toISOString(),
      secondsRemaining,
      countdown: `${Math.floor(secondsRemaining / 60)}:${String(secondsRemaining % 60).padStart(2, '0')}`
    });
  }
  res.json({ activeSignals: active, count: active.length, lockDurationMs: SIGNAL_LOCK_MS });
});

app.get('/market', async (req, res) => {
  // CORRECTIF: timeout global 20s
  const timer = setTimeout(() => {
    if (!res.headersSent) res.status(504).json({ error: 'Timeout — aucune source n\'a répondu dans les délais.' });
  }, ROUTE_TIMEOUT_MS);

  try {
    let { symbol, type = 'crypto', interval = '15m', news = '', provider = '' } = req.query;

    if (!symbol) { clearTimeout(timer); return res.status(400).json({ error: 'Symbol requis' }); }

    symbol   = String(symbol).trim();
    type     = String(type).toLowerCase().trim();
    if (type === 'indice' || type === 'indices') type = 'index';
    if (!INTERVAL_MAP[interval]) interval = '15m';

    const timeConfig = INTERVAL_MAP[interval];
    const cacheKey   = `${type}-${symbol}-${interval}-${provider}`;
    const lockKey    = `${type}-${compactSymbol(symbol)}-${interval}`;

    if (CACHE.has(cacheKey)) {
      const cached = CACHE.get(cacheKey);
      if (Date.now() - cached.timestamp < timeConfig.cache) {
        clearTimeout(timer);
        // CORRECTIF: rawAnalysis du cache + prix frais = tradePlan/indicators toujours live
        // On ré-émet le signal depuis le cache mais on recalcule uniquement si le prix a bougé
        const lockedResult = resolveSignal(lockKey, cached.rawAnalysis);
        return res.json({ ...cached.data, ...lockedResult });
      }
    }

    const market = await fetchMarketData({ symbol, type, timeConfig, provider });

    if (!market.candles || market.candles.length < 80) {
      clearTimeout(timer);
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

    // Calcul du signal brut (inclut tradePlan et indicators au prix live)
    const rawAnalysis = generateScalpingSignal(candles, { news });

    // Application du lock
    const lockedResult = resolveSignal(lockKey, rawAnalysis);

    const data = {
      symbol:         compactSymbol(symbol),
      type,
      interval,
      marketPrice:    currentPrice,
      formattedPrice: formatPrice(currentPrice),
      source:         market.source,
      ...lockedResult,
      timestamp:      new Date().toISOString()
    };

    // Cache : on stocke le rawAnalysis pour les appels suivants
    CACHE.set(cacheKey, { data, rawAnalysis, timestamp: Date.now() });

    clearTimeout(timer);
    return res.json(data);

  } catch (error) {
    clearTimeout(timer);
    if (!res.headersSent) {
      console.error('Market error:', error.message);
      return res.status(502).json({
        error: 'Impossible de charger les donnees',
        details: process.env.NODE_ENV === 'production' ? undefined : error.message
      });
    }
  }
});

app.listen(PORT, HOST, () => {
  console.log(`Serveur lance sur ${HOST}:${PORT}`);
  console.log(`Signal lock: ${SIGNAL_LOCK_MS / 1000}s | Min confirmations: ${SIGNAL_MIN_CONFIRM} | Override confiance: ${SIGNAL_OVERRIDE_CONF}%`);
  console.log(`Cache LRU: max ${CACHE_MAX_SIZE} entrees | Route timeout: ${ROUTE_TIMEOUT_MS / 1000}s`);
  if (!compression) console.warn('[warn] compression non disponible — npm install compression');
  if (!rateLimit)   console.warn('[warn] express-rate-limit non disponible — npm install express-rate-limit');
});

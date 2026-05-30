import express from "express";
import path from "path";
import fs from "fs";
import cors from "cors";
import compression from "compression";
import axios from "axios";
import { rateLimit } from "express-rate-limit";
import { createServer as createViteServer } from "vite";

const app = express();
const PORT = 3000;
const HOST = "0.0.0.0";

app.set("trust proxy", 1);

// ============================================================
// CONFIGURATION DE SECURITE & MIDDLEWARES
// ============================================================
const corsOrigin = process.env.CORS_ORIGIN || "*";
app.use(cors({
  origin: corsOrigin,
  methods: ["GET", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.use(express.json());
app.use(compression());

const AXIOS_TIMEOUT = Number(process.env.MARKET_TIMEOUT_MS || 12000);
const HTTP = axios.create({ timeout: AXIOS_TIMEOUT });

// User-Agents rotatifs pour éviter le blocage par les serveurs tiers
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
];
let uaIndex = 0;
HTTP.interceptors.request.use(config => {
  config.headers["User-Agent"] = USER_AGENTS[uaIndex % USER_AGENTS.length];
  config.headers["Accept"] = "application/json,text/plain,*/*";
  uaIndex++;
  return config;
});

// Limiteur de requêtes pour protéger l'API /api/market
app.use("/api/market", rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.RATE_LIMIT_MAX || 60),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Trop de requêtes — réessayez dans une minute." }
}));

// ============================================================
// CONFIGURATION DES INTERVALLES & CONFIGS TECHNIQUES
// ============================================================
interface IntervalConfig {
  binance: string;
  bybit: string;
  yahooInt: string;
  yahooRange: string;
  coinbaseGranularity: number | null;
  bitstampStep: number | null;
  bitstampAggregateMs?: number;
  aggregateMs?: number;
  cache: number;
}

const INTERVAL_MAP: Record<string, IntervalConfig> = {
  "1m":  { binance: "1m",  bybit: "15",  yahooInt: "1m",  yahooRange: "5d",   coinbaseGranularity: 60,    bitstampStep: 60,    cache: 10000 },
  "5m":  { binance: "5m",  bybit: "5",   yahooInt: "5m",  yahooRange: "15d",  coinbaseGranularity: 300,   bitstampStep: 300,   cache: 15000 },
  "15m": { binance: "15m", bybit: "15",  yahooInt: "15m", yahooRange: "30d",  coinbaseGranularity: 900,   bitstampStep: 900,   cache: 20000 },
  "30m": { binance: "30m", bybit: "30",  yahooInt: "30m", yahooRange: "30d",  coinbaseGranularity: null,  bitstampStep: 1800,  cache: 30000 },
  "1h":  { binance: "1h",  bybit: "60",  yahooInt: "60m", yahooRange: "60d",  coinbaseGranularity: 3600,  bitstampStep: 3600,  cache: 40000 },
  "4h":  { binance: "4h",  bybit: "240", yahooInt: "60m", yahooRange: "60d",  coinbaseGranularity: 21600, bitstampStep: 14400, aggregateMs: 4 * 60 * 60 * 1000, cache: 60000 },
  "1d":  { binance: "1d",  bybit: "D",   yahooInt: "1d",  yahooRange: "1y",   coinbaseGranularity: 86400, bitstampStep: 86400, cache: 120000 },
};

const YAHOO_SYMBOL_ALIASES: Record<string, string> = {
  US100: "^NDX", NAS100: "^NDX", NASDAQ100: "^NDX", NDX100: "^NDX",
  USTECH100: "^NDX", USTEC: "^NDX", TECH100: "^NDX",
  "US TECH 100": "^NDX", "NASDAQ 100": "^NDX",
  NQ: "NQ=F", NQF: "NQ=F", SPX500: "ES=F", US500: "ES=F",
  SP500: "ES=F", US30: "YM=F", DJI: "YM=F", DJ30: "YM=F",
  GER40: "^GDAXI", DAX40: "^GDAXI", UK100: "^FTSE",
  XAUUSD: "GC=F", GOLD: "GC=F", XAGUSD: "SI=F", SILVER: "SI=F",
  USOIL: "CL=F", WTI: "CL=F", BRENT: "BZ=F"
};

// ============================================================
// SYSTEME DE LOCK POUR LE SIGNAL ET LE PLAN DE TRADING
// ============================================================
const SIGNAL_LOCK_MS = Number(process.env.SIGNAL_LOCK_MS || 3 * 60 * 1000); // 3 minutes de gel strict
const LOCKS_DUMP_FILE = process.env.LOCKS_DUMP_FILE || path.join("/tmp", ".signal_locks_ts.json");

interface TradePlan {
  action: string;
  entry: string | null;
  entryZone: string;
  stopLoss: string | null;
  sl: string | null;
  takeProfit1: string | null;
  takeProfit2: string | null;
  takeProfit3: string | null;
  tp1: string | null;
  tp2: string | null;
  tp3: string | null;
  takeProfit: (string | null)[];
  targets: (string | null)[];
  support: string | null;
  resistance: string | null;
  invalidation: string | null;
  riskReward: { tp1: number; tp2: number; tp3: number };
  exitPlan: string;
}

interface SignalLock {
  signal: string;
  confidence: number;
  score: number;
  lockedAt: number;
  expiresAt: number;
  tradePlan: TradePlan;
  reasons: string[];
}

const SIGNAL_LOCKS = new Map<string, SignalLock>();

function dumpLocks() {
  try {
    const now = Date.now();
    const active: [string, SignalLock][] = [];
    for (const [key, lock] of SIGNAL_LOCKS.entries()) {
      if (now <= lock.expiresAt) active.push([key, lock]);
    }
    fs.writeFileSync(LOCKS_DUMP_FILE, JSON.stringify(active), "utf8");
  } catch (_) {}
}

function loadLocks() {
  try {
    if (!fs.existsSync(LOCKS_DUMP_FILE)) return;
    const data = JSON.parse(fs.readFileSync(LOCKS_DUMP_FILE, "utf8")) as [string, SignalLock][];
    const now = Date.now();
    for (const [key, lock] of data) {
      if (lock.expiresAt > now) SIGNAL_LOCKS.set(key, lock);
    }
    fs.unlinkSync(LOCKS_DUMP_FILE);
    console.log(`[locks] ${SIGNAL_LOCKS.size} signal(s) rechargé(s) depuis le dump.`);
  } catch (_) {}
}

loadLocks();
process.on("SIGTERM", () => { dumpLocks(); process.exit(0); });
process.on("SIGINT",  () => { dumpLocks(); process.exit(0); });

function getLockedSignal(key: string): SignalLock | null {
  const lock = SIGNAL_LOCKS.get(key);
  if (!lock) return null;
  if (Date.now() > lock.expiresAt) {
    SIGNAL_LOCKS.delete(key);
    return null;
  }
  return lock;
}

// ============================================================
// SYSTEME DE CACHE LRU POUR LES CANDELESTICKS
// ============================================================
class LRUCache<T> {
  private maxSize: number;
  private map: Map<string, T>;
  constructor(maxSize: number) {
    this.maxSize = maxSize;
    this.map = new Map();
  }
  get(key: string): T | undefined { return this.map.get(key); }
  has(key: string): boolean { return this.map.has(key); }
  set(key: string, value: T): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.maxSize) this.map.delete(this.map.keys().next().value!);
  }
  get size(): number { return this.map.size; }
}

interface CacheItem {
  data: any;
  rawAnalysis: any;
  timestamp: number;
}
const CACHE = new LRUCache<CacheItem>(200);

// ============================================================
// UTILITIES MATHEMATIQUES ET CHANDELIERS
// ============================================================
function round(value: number, digits = 4): number {
  if (!Number.isFinite(value)) return 0;
  return Number(value.toFixed(digits));
}
function average(values: number[]): number {
  const valid = values.filter(Number.isFinite);
  if (!valid.length) return 0;
  return valid.reduce((s, v) => s + v, 0) / valid.length;
}
function median(values: number[]): number {
  const valid = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!valid.length) return 0;
  const mid = Math.floor(valid.length / 2);
  return valid.length % 2 ? valid[mid] : (valid[mid - 1] + valid[mid]) / 2;
}
function stdDev(values: number[]): number {
  const valid = values.filter(Number.isFinite);
  if (valid.length < 2) return 0;
  const mean = average(valid);
  return Math.sqrt(valid.reduce((s, v) => s + (v - mean) ** 2, 0) / valid.length);
}
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
function formatPrice(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const abs = Math.abs(value);
  if (abs >= 1000) return Number(value.toFixed(2)).toLocaleString("en-US");
  if (abs >= 1)    return Number(value.toFixed(4)).toLocaleString("en-US");
  return Number(value.toFixed(8)).toString();
}
function priceDigits(value: number): number {
  const abs = Math.abs(value);
  if (abs >= 1000) return 2;
  if (abs >= 1)    return 4;
  return 8;
}
function formatPlanPrice(value: number, reference: number): string {
  const ref = Number.isFinite(reference) ? reference : value;
  return round(value, priceDigits(ref)).toString();
}

interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// INDICATEURS TECHNIQUES
function calculateRSI(prices: number[], period = 14): number {
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

function calculateRSISeries(prices: number[], period = 14): (number | null)[] {
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

function calculateStochRSI(prices: number[], rsiPeriod = 14, stochPeriod = 14, kSmooth = 3, dSmooth = 3) {
  const rsiSeries = calculateRSISeries(prices, rsiPeriod);
  const validRsi = rsiSeries.filter((v): v is number => v !== null);
  if (validRsi.length < stochPeriod) return { k: 50, d: 50, kPrev: 50, dPrev: 50 };
  const stochSeries: number[] = [];
  for (let i = stochPeriod - 1; i < validRsi.length; i++) {
    const window = validRsi.slice(i - stochPeriod + 1, i + 1);
    const lo = Math.min(...window), hi = Math.max(...window);
    stochSeries.push(hi === lo ? 50 : ((validRsi[i] - lo) / (hi - lo)) * 100);
  }
  const kSeries: number[] = [];
  for (let i = kSmooth - 1; i < stochSeries.length; i++) {
    kSeries.push(average(stochSeries.slice(i - kSmooth + 1, i + 1)));
  }
  const dSeries: number[] = [];
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

function calculateEMA(prices: number[], period: number): number[] {
  if (prices.length < period) {
    return prices.map(() => prices[prices.length - 1] || 0);
  }
  let ema = average(prices.slice(0, period));
  const k = 2 / (period + 1);
  const result = Array(period - 1).fill(0);
  result.push(ema);
  for (let i = period; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
    result.push(ema);
  }
  return result;
}

function calculateMACD(prices: number[], fast = 12, slow = 26, signal = 9) {
  const emaFast = calculateEMA(prices, fast);
  const emaSlow = calculateEMA(prices, slow);
  const macdLine = prices.map((_, i) => {
    if (!Number.isFinite(emaFast[i]) || !Number.isFinite(emaSlow[i])) return 0;
    return emaFast[i] - emaSlow[i];
  });
  const validMacd = macdLine.slice(slow);
  if (validMacd.length < signal) {
    return { macd: 0, signal: 0, histogram: 0, prevHistogram: 0, bullCross: false, bearCross: false };
  }
  const signalLine = calculateEMA(validMacd, signal);
  const lastMacd = macdLine.at(-1) ?? 0;
  const lastSig = signalLine.at(-1) ?? 0;
  const prevMacd = macdLine.at(-2) ?? 0;
  const prevSigVal = signalLine.at(-2) ?? 0;
  const bullCross = prevMacd <= prevSigVal && lastMacd > lastSig;
  const bearCross = prevMacd >= prevSigVal && lastMacd < lastSig;
  return { macd: lastMacd, signal: lastSig, histogram: lastMacd - lastSig, prevHistogram: prevMacd - prevSigVal, bullCross, bearCross };
}

function calculateATR(candles: Candle[], period = 14): number {
  if (candles.length <= period) return 0;
  const tr: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    tr.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  return average(tr.slice(-period));
}

function calculateBollingerBands(prices: number[], period = 20, multiplier = 2) {
  if (prices.length < period) {
    const last = prices.at(-1) || 0;
    return { upper: last, middle: last, lower: last, width: 0, percentB: 0.5, std: 0 };
  }
  const recent = prices.slice(-period);
  const middle = average(recent);
  const std = stdDev(recent);
  const upper = middle + multiplier * std;
  const lower = middle - multiplier * std;
  const width = upper - lower;
  const price = prices.at(-1) ?? 0;
  const percentB = width > 0 ? (price - lower) / width : 0.5;
  return { upper, middle, lower, width, percentB, std };
}

function calculateVWAP(candles: Candle[], period = 30) {
  const recent = candles.slice(-period);
  let pv = 0, vol = 0;
  const typicals: number[] = [];
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
  return { vwap, upper1: vwap + std, lower1: vwap - std, upper2: vwap + 2 * std, lower2: vwap - 2 * std };
}

function calculateSupportResistance(candles: Candle[], lookback = 60, swingStrength = 3) {
  const recent = candles.slice(-lookback);
  const swingHighs: number[] = [], swingLows: number[] = [];
  for (let i = swingStrength; i < recent.length - swingStrength; i++) {
    const pivot = recent[i];
    const isHigh = recent.slice(i - swingStrength, i + swingStrength + 1).every((c, j) => j === swingStrength || c.high <= pivot.high);
    const isLow  = recent.slice(i - swingStrength, i + swingStrength + 1).every((c, j) => j === swingStrength || c.low  >= pivot.low);
    if (isHigh) swingHighs.push(pivot.high);
    if (isLow)  swingLows.push(pivot.low);
  }
  const price = candles.at(-1)?.close ?? 0;
  const resistances = swingHighs.filter(h => h > price).sort((a, b) => a - b);
  const supports = swingLows.filter(l => l < price).sort((a, b) => b - a);
  return {
    support:     supports[0]    ?? Math.min(...recent.map(c => c.low)),
    resistance:  resistances[0] ?? Math.max(...recent.map(c => c.high)),
    supports:    supports.slice(0, 3),
    resistances: resistances.slice(0, 3)
  };
}

// DETECTOR DE CHANDELIERS ET DE BOUGIES DE CONFIRMATION AVANCE
interface PatternResult {
  bullish: string[];
  bearish: string[];
  bullScore: number;
  bearScore: number;
  confirmed: boolean;
  confirmationDetails: string[];
  volatilityRating: string;
}

function detectCandlePatternsAndConfirmations(candles: Candle[], atrPercent: number): PatternResult {
  const n = candles.length;
  if (n < 5) return { bullish: [], bearish: [], bullScore: 0, bearScore: 0, confirmed: false, confirmationDetails: [], volatilityRating: "MODEREE" };

  const bullish: string[] = [];
  const bearish: string[] = [];
  const confirmationDetails: string[] = [];
  
  // Bougie 0 (Bougie en cours de cloture ou Derniere closed - sert de validation/confirmation immédiate)
  const c0 = candles.at(-1)!;
  // Bougie 1 (Bougie du pattern ou signal suspecté)
  const c1 = candles.at(-2)!;
  // Bougies de contexte passées
  const c2 = candles.at(-3)!;
  const c3 = candles.at(-4)!;

  const body1 = Math.abs(c1.close - c1.open);
  const range1 = c1.high - c1.low || 0.0001;
  const upperWick1 = c1.high - Math.max(c1.close, c1.open);
  const lowerWick1 = Math.min(c1.close, c1.open) - c1.low;
  const isBull1 = c1.close > c1.open;
  const isBear1 = c1.close < c1.open;

  const body0 = Math.abs(c0.close - c0.open);
  const range0 = c0.high - c0.low || 0.0001;
  const isBull0 = c0.close > c0.open;
  const isBear0 = c0.close < c0.open;

  const body2 = Math.abs(c2.close - c2.open);
  const isBear2 = c2.close < c2.open;
  const isBull2 = c2.close > c2.open;

  const body3 = Math.abs(c3.close - c3.open);
  const isBear3 = c3.close < c3.open;
  const isBull3 = c3.close > c3.open;

  // Analyse de tendance locale (comparaison des derniers points de fermeture)
  const prevCandles = candles.slice(-7, -2);
  const trendBullish = prevCandles.at(-1)!.close > prevCandles[0].close;
  const trendBearish = prevCandles.at(-1)!.close < prevCandles[0].close;

  // Tailles moyennes pour calibrer la volatilité et les corps
  const avgBody = average(candles.slice(-15).map(c => Math.abs(c.close - c.open)));
  const avgRange = average(candles.slice(-15).map(c => c.high - c.low));

  // ============================================================
  // ANALYSE DE VOLATILITÉ DES CHANDELIERS (RCV : Relative Candle Volatility)
  // ============================================================
  let volatilityRating = "MODEREE";
  const rcv0 = (c0.high - c0.low) / (avgRange || 0.0001);
  const rcv1 = (c1.high - c1.low) / (avgRange || 0.0001);
  const maxRcv = Math.max(rcv0, rcv1);

  if (maxRcv > 2.2) {
    volatilityRating = "EXCESSIF"; // Volatilité erratique / Expansion disproportionnée après news ou anomalie
  } else if (maxRcv < 0.35) {
    volatilityRating = "COMPRESSE"; // Compression extrême / Pas de liquidité / Pas d'énergie
  } else if (maxRcv >= 0.6 && maxRcv <= 1.8) {
    volatilityRating = "STABLE"; // Volatilité harmonieuse, idéale pour suivre des signaux
  } else {
    volatilityRating = "CONTROLEE"; // Volatilité standard modérée
  }

  let bullScore = 0;
  let bearScore = 0;
  let confirmed = false;

  // 1. MARTEAU (HAMMER) / RECOUVREMENT DE TENDANCE BAISSIÈRE (SUPPORT)
  if (lowerWick1 >= body1 * 2.2 && upperWick1 <= body1 * 0.4 && range1 > avgRange * 0.6 && trendBearish) {
    bullish.push("Marteau de Support");
    bullScore += 12;

    // CONFIRMATION STRICTE : Bougie 0 doit clore haussière ET dépasser l'open ou le milieu de bougie 1
    if (isBull0 && c0.close > c1.high) {
      bullScore += 18;
      confirmed = true;
      confirmationDetails.push("Confirmation Marteau : La bougie C0 clôture au-dessus du plus haut du Marteau (Forte impulsion)");
    } else if (isBull0 && c0.close > (c1.high + c1.low) / 2) {
      bullScore += 10;
      confirmed = true;
      confirmationDetails.push("Confirmation Marteau partielle : La bougie C0 clôture au-dessus de 50% de la mèche");
    } else {
      confirmationDetails.push("Marteau repéré mais bougie de confirmation C0 absente ou indécise");
    }
  }

  // 2. ÉTOILE FILANTE (SHOOTING STAR) / RÉSISTANCE EN TENDANCE HAUSSIÈRE
  if (upperWick1 >= body1 * 2.2 && lowerWick1 <= body1 * 0.4 && range1 > avgRange * 0.6 && trendBullish) {
    bearish.push("Étoile Filante (Shooting Star)");
    bearScore += 12;

    // CONFIRMATION STRICTE : Bougie 0 doit clore baissière ET clore sous le bas de bougie 1
    if (isBear0 && c0.close < c1.low) {
      bearScore += 18;
      confirmed = true;
      confirmationDetails.push("Confirmation Étoile Filante : Clôture sous le bas du pattern (Impulsion vendeuse)");
    } else if (isBear0 && c0.close < (c1.high + c1.low) / 2) {
      bearScore += 10;
      confirmed = true;
      confirmationDetails.push("Confirmation Étoile Filante partielle : Clôture sous la médiane du corps/hauteur");
    } else {
      confirmationDetails.push("Étoile Filante repérée mais bougie de confirmation C0 absente ou indécise");
    }
  }

  // 3. AVALEMENT HAUSSIER (BULLISH ENGULFING)
  if (isBear2 && isBull1 && c1.close >= c2.open && c1.open <= c2.close && body1 > avgBody * 0.7) {
    bullish.push("Avalement Haussier");
    bullScore += 15;

    // CONFIRMATION STRICTE : Bougie 0 continue de clore au-dessus du climax de l'avalement
    if (isBull0 && c0.close > c1.close) {
      bullScore += 15;
      confirmed = true;
      confirmationDetails.push("Confirmation Avalement Haussier : Continuation haussière confirmée sur la bougie suivante");
    } else {
      confirmationDetails.push("Avalement Haussier détecté sans impulsion confirmée sur la bougie C0");
    }
  }

  // 4. AVALEMENT BAISSIER (BEARISH ENGULFING)
  if (isBull2 && isBear1 && c1.close <= c2.open && c1.open >= c2.close && body1 > avgBody * 0.7) {
    bearish.push("Avalement Baissier");
    bearScore += 15;

    // CONFIRMATION STRICTE : Bougie 0 clôture baissière en dessous de l'avalement
    if (isBear0 && c0.close < c1.close) {
      bearScore += 15;
      confirmed = true;
      confirmationDetails.push("Confirmation Avalement Baissier : Continuation baissière confirmée sur la bougie suivante");
    } else {
      confirmationDetails.push("Avalement Baissier détecté sans impulsion confirmée sur la bougie C0");
    }
  }

  // 5. MORNING STAR (ÉTOILE DU MATIN - RETOURNEMENT HAUSSIER MAJEUR EN 3 BOUGIES)
  if (isBear3 && body3 > avgBody * 0.6 && Math.abs(c2.close - c2.open) < body3 * 0.45 && isBull1 && c1.close > (c3.open + c3.close) / 2) {
    bullish.push("Étoile du Matin");
    bullScore += 20;

    // CONFIRMATION STRICTE : C0 maintient la tendance et ferme plus haut que C1
    if (isBull0 && c0.close > c1.close) {
      bullScore += 12;
      confirmed = true;
      confirmationDetails.push("Confirmation Étoile du Matin : Continuation d'impulsion haussière validée par C0");
    } else {
      confirmationDetails.push("Étoile du Matin valide mais la bougie C0 subit des prises de bénéfices");
    }
  }

  // 6. EVENING STAR (ÉTOILE DU SOIR - RETOURNEMENT BAISSIER MAJEUR)
  if (isBull3 && body3 > avgBody * 0.6 && Math.abs(c2.close - c2.open) < body3 * 0.45 && isBear1 && c1.close < (c3.open + c3.close) / 2) {
    bearish.push("Étoile du Soir");
    bearScore += 20;

    // CONFIRMATION STRICTE : C0 clôture plus bas et confirme l'inversion
    if (isBear0 && c0.close < c1.close) {
      bearScore += 12;
      confirmed = true;
      confirmationDetails.push("Confirmation Étoile du Soir : Continuation d'impulsion baissière validée par C0");
    } else {
      confirmationDetails.push("Étoile du Soir valide mais la bougie C0 montre un timide rebond");
    }
  }

  // 7. TWEEZER BOTTOM (PINCES DE RETOURNEMENT HAUSSIER)
  if (isBear2 && isBull1 && Math.abs(c1.low - c2.low) / (avgRange || 0.0001) < 0.08 && trendBearish) {
    bullish.push("Pince Haussière (Tweezer Bottom)");
    bullScore += 10;

    if (isBull0 && c0.close > Math.max(c1.close, c2.open)) {
      bullScore += 12;
      confirmed = true;
      confirmationDetails.push("Confirmation Pince Haussière : Pivot de support Twitter Bottom validé et englobé");
    }
  }

  // 8. TWEEZER TOP (PINCES DE RETOURNEMENT BAISSIER)
  if (isBull2 && isBear1 && Math.abs(c1.high - c2.high) / (avgRange || 0.0001) < 0.08 && trendBullish) {
    bearish.push("Pince Baissière (Tweezer Top)");
    bearScore += 10;

    if (isBear0 && c0.close < Math.min(c1.close, c2.open)) {
      bearScore += 12;
      confirmed = true;
      confirmationDetails.push("Confirmation Pince Baissière : pivot de résistance Twitter Top validé et cassé");
    }
  }

  // 9. MARUBOZU D'IMPULSION SANS MÉCHES
  if (isBull1 && upperWick1 < body1 * 0.04 && lowerWick1 < body1 * 0.04 && body1 > avgBody * 1.4) {
    bullish.push("Marubozu d'Impulsion Acheteuse");
    bullScore += 12;
    if (isBull0) {
      bullScore += 8;
      confirmed = true;
      confirmationDetails.push("Confirmation Marubozu : La bougie de confirmation C0 confirme la pression d'accumulation");
    }
  }
  if (isBear1 && upperWick1 < body1 * 0.04 && lowerWick1 < body1 * 0.04 && body1 > avgBody * 1.4) {
    bearish.push("Marubozu d'Impulsion Vendeuse");
    bearScore += 12;
    if (isBear0) {
      bearScore += 8;
      confirmed = true;
      confirmationDetails.push("Confirmation Marubozu : La bougie de confirmation C0 prolonge l'action vendeuse");
    }
  }

  return {
    bullish: [...new Set(bullish)],
    bearish: [...new Set(bearish)],
    bullScore: round(bullScore, 1),
    bearScore: round(bearScore, 1),
    confirmed,
    confirmationDetails,
    volatilityRating
  };
}

// FORMATTEUR DE PLAN DE TRADING ET POSITION SIZING
function createTradingPlan(signal: string, confidence: number, score: number, price: number, atr: number, support: number, resistance: number, percentB: number): TradePlan {
  const direction = signal === "SELL" || (signal === "HOLD" && score < 0) ? "SELL" : "BUY";
  const isBuy = direction === "BUY";
  
  const atrSafety = Number.isFinite(atr) && atr > 0 ? atr : price * 0.003;
  const minRisk = price * 0.0006;
  const maxRisk = price * 0.012;
  const baseRisk = clamp(atrSafety * 0.75, minRisk, maxRisk);
  
  let finalRisk = baseRisk;

  // Optimisation selon les S/R
  if (isBuy && Number.isFinite(support) && support > 0 && support < price) {
    const distanceToSupport = price - support;
    if (distanceToSupport < baseRisk * 1.6) {
      finalRisk = Math.max(baseRisk, distanceToSupport * 1.08); // Placer le SL juste sous le support
    }
  } else if (!isBuy && Number.isFinite(resistance) && resistance > price) {
    const distanceToRes = resistance - price;
    if (distanceToRes < baseRisk * 1.6) {
      finalRisk = Math.max(baseRisk, distanceToRes * 1.08); // Placer le SL juste au-dessus de la résistance
    }
  }

  const entry = price;
  const entrySpread = clamp(atrSafety * 0.12, price * 0.0001, price * 0.001);
  const stopLoss = isBuy ? entry - finalRisk : entry + finalRisk;

  // Calcul des Take Profits optimisés pour un excellent rapport RR (Risk-Reward)
  const tp1 = isBuy ? entry + finalRisk * 1.15 : entry - finalRisk * 1.15;
  const tp2 = isBuy ? entry + finalRisk * 2.20 : entry - finalRisk * 2.20;
  const tp3 = isBuy ? entry + finalRisk * 3.40 : entry - finalRisk * 3.40;

  const buyZoneLow = isBuy ? entry - entrySpread : entry + entrySpread;
  const buyZoneHigh = isBuy ? entry + entrySpread : entry - entrySpread;

  const validSupport = Number.isFinite(support) && support > 0 ? support : stopLoss;
  const validResistance = Number.isFinite(resistance) && resistance > 0 ? resistance : tp2;
  const riskPerUnit = Math.abs(entry - stopLoss);

  return {
    action:      signal === "HOLD" ? `STANDBY_${direction}` : direction,
    entry:       formatPlanPrice(entry, price),
    entryZone:   `${formatPlanPrice(Math.min(buyZoneLow, buyZoneHigh), price)} – ${formatPlanPrice(Math.max(buyZoneLow, buyZoneHigh), price)}`,
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
    support:     formatPlanPrice(validSupport, price),
    resistance:  formatPlanPrice(validResistance, price),
    invalidation: formatPlanPrice(stopLoss, price),
    riskReward: {
      tp1: round(Math.abs(tp1 - entry) / riskPerUnit, 2),
      tp2: round(Math.abs(tp2 - entry) / riskPerUnit, 2),
      tp3: round(Math.abs(tp3 - entry) / riskPerUnit, 2)
    },
    exitPlan: [
      `TP1 (1.15x RR) : Clôturer 50% du volume pour sécuriser la transaction, basculer SL à B/E.`,
      `TP2 (2.20x RR) : Clôturer 30% additionnel, laisser courir le reliquat avec Trailing Stop.`,
      `TP3 (3.40x RR) : Sortie définitive de position.`
    ].join(" | ")
  };
}

// GENERATION COMPLETE DE SIGNAL AVEC FILTRES DE CONFIANCE ET CONFIRMATION CHANDELIER
function runSignalEngine(candles: Candle[], news = ""): any {
  const MIN_CANDLES = 60;
  if (candles.length < MIN_CANDLES) {
    return {
      signal: "HOLD",
      strength: "FAIBLE",
      confidence: 0,
      score: 0,
      confirmations: 0,
      reasons: ["Historique de prix dérisoire (60 bougies minimum requises)"],
      indicators: {},
      tradePlan: null
    };
  }

  const closes = candles.map(c => c.close);
  const last = candles.at(-1)!;
  const currentPrice = last.close;

  // Indicateurs techniques standardisés
  const ema9 = calculateEMA(closes, 9).at(-1) ?? currentPrice;
  const ema21 = calculateEMA(closes, 21).at(-1) ?? currentPrice;
  const ema50 = calculateEMA(closes, 50).at(-1) ?? currentPrice;
  const ema200 = calculateEMA(closes, 200).at(-1) ?? currentPrice;

  const rsi7 = calculateRSI(closes, 7);
  const rsi14 = calculateRSI(closes, 14);
  const stochRsi = calculateStochRSI(closes, 14, 14, 3, 3);
  const macd = calculateMACD(closes);

  const atr = calculateATR(candles, 14);
  const atrPercent = currentPrice ? (atr / currentPrice) * 100 : 0;
  const bb = calculateBollingerBands(closes, 20, 2);

  const vwapData = calculateVWAP(candles, 30);
  const { vwap } = vwapData;

  const srLevels = calculateSupportResistance(candles, 60, 3);
  const { support, resistance } = srLevels;

  // 1. Détection des chandeliers et confirmation sur bougie suivante
  const patternResult = detectCandlePatternsAndConfirmations(candles, atrPercent);

  // ============================================================
  // SYSTEME MULTI-FACTEUR DE CALCUL DE CONFIANCE (0 - 100%)
  // ============================================================
  const reasons: string[] = [];
  let bullConfidence = 0;
  let bearConfidence = 0;
  let confirmations = 0;

  // --- FACTEUR 1 : Tendance & Alignement des SMA (Poids Max : 20%) ---
  // Haussier
  if (ema9 > ema21 && ema21 > ema50) {
    bullConfidence += 15;
  } else if (ema9 > ema21) {
    bullConfidence += 5;
  }
  if (currentPrice > ema200) {
    bullConfidence += 5;
  }
  // Baissier
  if (ema9 < ema21 && ema21 < ema50) {
    bearConfidence += 15;
  } else if (ema9 < ema21) {
    bearConfidence += 5;
  }
  if (currentPrice < ema200) {
    bearConfidence += 5;
  }

  // --- FACTEUR 2 : Momentum, RSI et Stochastique (Poids Max : 20%) ---
  // Haussier
  if (rsi14 > 50 && rsi14 <= 70) {
    bullConfidence += 10;
  } else if (rsi14 > 70) {
    // Surchauffe
    bullConfidence += 3;
  }
  if (rsi7 > 55 && rsi7 < 80) {
    bullConfidence += 5;
  }
  const stochBullCross = stochRsi.kPrev < stochRsi.dPrev && stochRsi.k > stochRsi.d;
  if (stochBullCross && stochRsi.k < 40) {
    bullConfidence += 5;
  } else if (stochRsi.k > stochRsi.d && stochRsi.k < 80) {
    bullConfidence += 3;
  }

  // Baissier
  if (rsi14 < 50 && rsi14 >= 30) {
    bearConfidence += 10;
  } else if (rsi14 < 30) {
    // Surchauffe basse
    bearConfidence += 3;
  }
  if (rsi7 < 45 && rsi7 > 20) {
    bearConfidence += 5;
  }
  const stochBearCross = stochRsi.kPrev > stochRsi.dPrev && stochRsi.k < stochRsi.d;
  if (stochBearCross && stochRsi.k > 60) {
    bearConfidence += 5;
  } else if (stochRsi.k < stochRsi.d && stochRsi.k > 20) {
    bearConfidence += 3;
  }

  // --- FACTEUR 3 : Alignement Vol-Ratio / Volume de Confirmation (Poids : 10%) ---
  const lastVol = last.volume || 1;
  const recentVols = candles.slice(-10, -1).map(c => c.volume);
  const medianVol = median(recentVols) || 1;
  const volRatio = lastVol / medianVol;

  if (volRatio > 1.3) {
    if (last.close > last.open) {
      bullConfidence += 10;
    } else if (last.close < last.open) {
      bearConfidence += 10;
    }
  } else if (volRatio > 1.0) {
    if (last.close > last.open) {
      bullConfidence += 5;
    } else if (last.close < last.open) {
      bearConfidence += 5;
    }
  }

  // --- FACTEUR 4 : MACD, VWAP & Bollinger (Poids Max : 15%) ---
  // Haussier
  if (macd.bullCross) {
    bullConfidence += 8;
  } else if (macd.histogram > 0) {
    bullConfidence += 4;
  }
  if (currentPrice > vwap && currentPrice < vwapData.upper2) {
    bullConfidence += 4;
  }
  if (bb.percentB < 0.2) {
    bullConfidence += 3; // Rejet de bande basse
  }

  // Baissier
  if (macd.bearCross) {
    bearConfidence += 8;
  } else if (macd.histogram < 0) {
    bearConfidence += 4;
  }
  if (currentPrice < vwap && currentPrice > vwapData.lower2) {
    bearConfidence += 4;
  }
  if (bb.percentB > 0.8) {
    bearConfidence += 3; // Rejet de bande haute
  }

  // --- FACTEUR 5 : Chandeliers Japonais & Bougies de Confirmation (Poids Max : 35%) ---
  // C'est le pilier central de l'algorithme stabilisé
  if (patternResult.bullScore > 0) {
    bullConfidence += 15;
    reasons.push(`[Chandelier] Pattern haussier repéré : ${patternResult.bullish.join(", ")}`);
    if (patternResult.confirmed) {
      bullConfidence += 20; // +20% de confiance si la bougie C0 confirme le signal !
      confirmations += 2;
    } else {
      reasons.push(`[Chandelier] Signal haussier non validé par la bougie de confirmation C0`);
    }
  }

  if (patternResult.bearScore > 0) {
    bearConfidence += 15;
    reasons.push(`[Chandelier] Pattern baissier repéré : ${patternResult.bearish.join(", ")}`);
    if (patternResult.confirmed) {
      bearConfidence += 20; // +20% de confiance si confirmée par C0 !
      confirmations += 2;
    } else {
      reasons.push(`[Chandelier] Signal baissier non validé par la bougie de confirmation C0`);
    }
  }

  // --- APPLICATIONS DES FILTRES DE VOLATILITÉ ET COMPRESSION ---
  if (patternResult.volatilityRating === "EXCESSIF") {
    bullConfidence -= 18;
    bearConfidence -= 18;
    reasons.push(`⚠️ Volatilité excessive détectée (RCV excessive). Risque élevé d'oscillation : application d'un stabilizer penalty`);
  } else if (patternResult.volatilityRating === "COMPRESSE") {
    bullConfidence -= 15;
    bearConfidence -= 15;
    reasons.push(`⚠️ Force de marché comprimée (Volume/Portée dérisoires). Risque de stagnation, penalty appliqué`);
  } else if (patternResult.volatilityRating === "STABLE") {
    if (bullConfidence > bearConfidence) bullConfidence += 5;
    else if (bearConfidence > bullConfidence) bearConfidence += 5;
    reasons.push(`✓ Conditions de volatilité idéales ("STABLE"). Signal favorisé`);
  }

  // Sentiment News additionnel si renseigné
  const normalizedNews = news.toLowerCase();
  if (normalizedNews.includes("bull") || normalizedNews.includes("long") || normalizedNews.includes("pump")) {
    bullConfidence += 10;
    reasons.push("Sentiment de news positif");
  } else if (normalizedNews.includes("bear") || normalizedNews.includes("short") || normalizedNews.includes("dump")) {
    bearConfidence += 10;
    reasons.push("Sentiment de news négatif");
  }

  // Nettoyage et clamp final
  bullConfidence = clamp(bullConfidence, 0, 99);
  bearConfidence = clamp(bearConfidence, 0, 99);

  // ============================================================
  // ENFORCEMENT STRICT DE LA RÈGLE DES 70%
  // ============================================================
  let signal = "HOLD";
  let confidence = 0;

  if (bullConfidence >= bearConfidence) {
    confidence = bullConfidence;
    if (bullConfidence >= 70) {
      signal = "BUY";
    }
  } else {
    confidence = bearConfidence;
    if (bearConfidence >= 70) {
      signal = "SELL";
    }
  }

  // Si on est en HOLD parce qu'aucun ne dépasse 70%
  if (signal === "HOLD") {
    reasons.push(`Seuil de confiance de 70% non atteint. (Bull : ${bullConfidence}%, Bear : ${bearConfidence}%). Standby (HOLD).`);
  } else {
    confirmations += 1;
    reasons.push(`Signal de trading [${signal}] validé avec succès avec ${confidence}% de confiance.`);
  }

  function strengthFromConfidence(conf: number) {
    if (conf >= 85) return "EXTREME";
    if (conf >= 70) return "FORTE";
    if (conf >= 55) return "MOYENNE";
    return "FAIBLE";
  }

  // Calcul du score technique net d'orientation pour la compatibilité d'affichage
  const netScore = round(bullConfidence - bearConfidence, 1);

  const tradePlan = createTradingPlan(signal, confidence, netScore, currentPrice, atr, support, resistance, bb.percentB);

  return {
    signal,
    strength: strengthFromConfidence(confidence),
    confidence,
    score: netScore,
    confirmations,
    tradePlan,
    indicators: {
      rsi7:            round(rsi7, 2),
      rsi14:           round(rsi14, 2),
      stochRsiK:       round(stochRsi.k, 2),
      stochRsiD:       round(stochRsi.d, 2),
      ema9:            formatPrice(ema9),
      ema21:           formatPrice(ema21),
      ema50:           formatPrice(ema50),
      ema200:          formatPrice(ema200),
      macd:            round(macd.macd, 6),
      macdSignal:      round(macd.signal, 6),
      macdHistogram:   round(macd.histogram, 6),
      macdCross:       macd.bullCross ? "BULL" : macd.bearCross ? "BEAR" : "NONE",
      bbUpper:         formatPrice(bb.upper),
      bbMiddle:        formatPrice(bb.middle),
      bbLower:         formatPrice(bb.lower),
      bbPercentB:      round(bb.percentB, 3),
      atr:             formatPrice(atr),
      atrPercent:      round(atrPercent, 2),
      vwap:            formatPrice(vwap),
      support:         formatPrice(support),
      resistance:      formatPrice(resistance),
      volatilityRating: patternResult.volatilityRating,
      candlePatterns:  {
        bullish:             patternResult.bullish,
        bearish:             patternResult.bearish,
        bullScore:           patternResult.bullScore,
        bearScore:           patternResult.bearScore,
        confirmed:           patternResult.confirmed,
        confirmationDetails: patternResult.confirmationDetails
      }
    },
    reasons
  };
}

// RESOLUTION DES LOCKS POUR VERROUILLER LE PLAN DE TRADING ET LES OBJECTIFS TP/SL PRECIS SUR 3 MINUTES
function resolveStabilizedSignal(key: string, freshAnalysis: any): any {
  const now = Date.now();
  const existing = getLockedSignal(key);

  if (!existing) {
    // Si aucun lock n'existe, et que la nouvelle analyse produit un BUY ou SELL fort (avec confiance >= 70%)
    if (freshAnalysis.signal !== "HOLD" && freshAnalysis.confidence >= 70) {
      const lock: SignalLock = {
        signal:      freshAnalysis.signal,
        confidence:  freshAnalysis.confidence,
        score:       freshAnalysis.score,
        lockedAt:    now,
        expiresAt:   now + SIGNAL_LOCK_MS,
        tradePlan:   freshAnalysis.tradePlan, // On fige l'entry, SL et TPs!
        reasons:     [...freshAnalysis.reasons]
      };
      SIGNAL_LOCKS.set(key, lock);
      return buildLockedResponse(lock, freshAnalysis, now);
    }
    // Si HOLD, on retourne simplement l'analyse fraîche sans verrouillage
    return buildLockedResponse(null, freshAnalysis, now);
  }

  // Si un lock existe déjà, on RESTE rigoureusement verrouillé sur ce signal et son plan de trading associé
  return buildLockedResponse(existing, freshAnalysis, now);
}

function buildLockedResponse(lock: SignalLock | null, freshAnalysis: any, now: number) {
  const isLocked = lock !== null;
  const secondsRemaining = isLocked ? Math.max(0, Math.round((lock.expiresAt - now) / 1000)) : 0;
  const minutesRemaining = Math.floor(secondsRemaining / 60);
  const secsDisplay = secondsRemaining % 60;

  return {
    signal:        isLocked ? lock.signal     : freshAnalysis.signal,
    strength:      isLocked ? (lock.confidence >= 85 ? "EXTREME" : "FORTE") : freshAnalysis.strength,
    confidence:    isLocked ? lock.confidence : freshAnalysis.confidence,
    score:         isLocked ? lock.score      : freshAnalysis.score,
    confirmations: freshAnalysis.confirmations,
    signalLock: {
      active:         isLocked,
      lockedAt:       isLocked ? new Date(lock.lockedAt).toISOString()  : null,
      expiresAt:      isLocked ? new Date(lock.expiresAt).toISOString() : null,
      secondsRemaining,
      countdown:      isLocked ? `${minutesRemaining}:${String(secsDisplay).padStart(2, '0')}` : null,
      lockDurationMs: SIGNAL_LOCK_MS
    },
    tradePlan: isLocked ? lock.tradePlan : freshAnalysis.tradePlan, // Strict figeage du plan de trading SL/TP-ENTRY!
    indicators: freshAnalysis.indicators,
    reasons: isLocked
      ? [...lock.reasons, `🔒 SIGNAL BLOQUÉ — Données fixes pour encore ${minutesRemaining}m ${secsDisplay}s (Stabilité)` ]
      : freshAnalysis.reasons
  };
}

// ─── ACCES AUX API DE MARCHÉ ET NORMALISATION ─────────────────────────
function normalizeCandles(candles: any[]): Candle[] {
  return candles
    .map(c => ({
      time:   Number(c.time),
      open:   Number(c.open),
      high:   Number(c.high),
      low:    Number(c.low),
      close:  Number(c.close),
      volume: Number(c.volume || 0)
    }))
    .filter(c =>
      Number.isFinite(c.time)  && Number.isFinite(c.open)  && Number.isFinite(c.high) &&
      Number.isFinite(c.low)   && Number.isFinite(c.close) &&
      c.open > 0 && c.high > 0 && c.low > 0 && c.close > 0
    )
    .sort((a, b) => a.time - b.time);
}

function applyCurrentPrice(candles: Candle[], currentPrice: number): Candle[] {
  if (!candles.length || !Number.isFinite(currentPrice) || currentPrice <= 0) return candles;
  const updated = candles.map(c => ({ ...c }));
  const last = updated.at(-1)!;
  last.close = currentPrice;
  last.high  = Math.max(last.high, currentPrice);
  last.low   = Math.min(last.low,  currentPrice);
  return updated;
}

function splitTradingViewSymbol(rawSymbol: string) {
  const raw = String(rawSymbol || "").trim();
  const parts = raw.split(":");
  if (parts.length > 1) return { exchange: parts[0].toLowerCase(), symbol: parts.slice(1).join(":") };
  return { exchange: "", symbol: raw };
}

function compactSymbol(symbol: string): string {
  return String(symbol || "").toUpperCase().trim()
    .replace(/\s+/g, " ").replace(/\.P$/, "").replace(/PERP$/, "");
}

function normalizeCryptoPair(rawSymbol: string) {
  const { exchange, symbol } = splitTradingViewSymbol(rawSymbol);
  const cleaned  = compactSymbol(symbol).replace(/[-/_\s]/g, "").replace(/[^A-Z0-9]/g, "");
  const quotes   = ["USDT", "USDC", "BUSD", "USD", "EUR", "BTC", "ETH"];
  const quote    = quotes.find(q => cleaned.endsWith(q) && cleaned.length > q.length);
  const base     = quote ? cleaned.slice(0, -quote.length) : cleaned;
  const stableQ  = quote && quote !== "USD" ? quote : "USDT";
  return {
    exchange,
    base,
    quote: quote || "USDT",
    binanceSymbol:   `${base}${stableQ}`,
    bybitSymbol:     `${base}${stableQ}`,
    coinbaseProduct: `${base}-${quote === "EUR" ? "EUR" : "USD"}`.toUpperCase(),
    bitstampPair:    `${base}${quote === "EUR" ? "EUR" : "USD"}`.toLowerCase()
  };
}

function resolveYahooSymbol(rawSymbol: string, type: string): string {
  const { symbol } = splitTradingViewSymbol(rawSymbol);
  const normalized = compactSymbol(symbol);
  const aliasKey   = normalized.replace(/[-/_^=.\s]/g, "");
  if (YAHOO_SYMBOL_ALIASES[normalized]) return YAHOO_SYMBOL_ALIASES[normalized];
  if (YAHOO_SYMBOL_ALIASES[aliasKey])   return YAHOO_SYMBOL_ALIASES[aliasKey];
  if (normalized.includes("=") || normalized.startsWith("^")) return normalized;
  const compact = normalized.replace(/[-/_\s]/g, "");
  if (type === "forex" && /^[A-Z]{6}$/.test(compact)) return `${compact}=X`;
  return normalized;
}

// FETCH DE DONNÉES BINANCE SPOT
async function fetchBinanceCrypto(pair: any, timeConfig: IntervalConfig) {
  const [klinesResponse, tickerResponse] = await Promise.all([
    HTTP.get("https://api.binance.com/api/v3/klines", {
      params: { symbol: pair.binanceSymbol, interval: timeConfig.binance, limit: 300 }
    }),
    HTTP.get("https://api.binance.com/api/v3/ticker/price", {
      params: { symbol: pair.binanceSymbol }
    }).catch(() => null)
  ]);
  
  const rawCandles = klinesResponse.data.map((c: any) => ({
    time: c[0], open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5]
  }));
  const candles = normalizeCandles(rawCandles);
  const currentPrice = Number(tickerResponse?.data?.price) || candles.at(-1)?.close || 0;
  return { candles: applyCurrentPrice(candles, currentPrice), currentPrice, source: `Binance Spot (${pair.binanceSymbol})` };
}

// FETCH DE DONNÉES BYBIT SPOT
async function fetchBybitCrypto(pair: any, timeConfig: IntervalConfig) {
  const response = await HTTP.get("https://api.bybit.com/v5/market/kline", {
    params: { category: "spot", symbol: pair.bybitSymbol, interval: timeConfig.bybit, limit: 200 }
  });
  if (response.data?.retCode !== 0) throw new Error(response.data?.retMsg || "Bybit error");
  
  const rawCandles = (response.data?.result?.list || []).map((c: any) => ({
    time: Number(c[0]), open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5]
  }));
  // Bybit retourne les chandelles de la plus récente à la plus ancienne, on les normalisera (triées par temps ascendant)
  const candles = normalizeCandles(rawCandles);
  return { candles, currentPrice: candles.at(-1)?.close ?? 0, source: `Bybit Spot (${pair.bybitSymbol})` };
}

// FETCH DE DONNÉES COINBASE PRO
async function fetchCoinbaseCrypto(pair: any, timeConfig: IntervalConfig) {
  if (!timeConfig.coinbaseGranularity) throw new Error("Intervalle non supporté par Coinbase");
  const end = Math.floor(Date.now() / 1000);
  const start = end - timeConfig.coinbaseGranularity * 250;
  const [response, tickerResponse] = await Promise.all([
    HTTP.get(`https://api.exchange.coinbase.com/products/${pair.coinbaseProduct}/candles`, {
      params: {
        start: new Date(start * 1000).toISOString(),
        end:   new Date(end * 1000).toISOString(),
        granularity: timeConfig.coinbaseGranularity
      }
    }),
    HTTP.get(`https://api.exchange.coinbase.com/products/${pair.coinbaseProduct}/ticker`).catch(() => null)
  ]);
  const rawCandles = (response.data || []).map((c: any) => ({
    time: c[0] * 1000, low: c[1], high: c[2], open: c[3], close: c[4], volume: c[5]
  }));
  const candles = normalizeCandles(rawCandles);
  const currentPrice = Number(tickerResponse?.data?.price) || candles.at(-1)?.close || 0;
  return { candles: applyCurrentPrice(candles, currentPrice), currentPrice, source: `Coinbase Pro (${pair.coinbaseProduct})` };
}

// LAUNCHERS SELECTOR POUR CONTOURNER LES CRASHES DE SOURCE
async function fetchCryptoMarket(rawSymbol: string, timeConfig: IntervalConfig, preferredProvider = "") {
  const pair = normalizeCryptoPair(rawSymbol);
  const order = preferredProvider === "bybit" ? ["bybit", "binance", "coinbase"] : ["binance", "bybit", "coinbase"];
  const errors: string[] = [];
  
  for (const provider of order) {
    try {
      if (provider === "binance") return await fetchBinanceCrypto(pair, timeConfig);
      if (provider === "bybit") return await fetchBybitCrypto(pair, timeConfig);
      if (provider === "coinbase") return await fetchCoinbaseCrypto(pair, timeConfig);
    } catch (e: any) {
      errors.push(`${provider} : ${e.message}`);
    }
  }
  throw new Error(`Échec de toutes les sources crypto : ${errors.join(" | ")}`);
}

// FETCH TRADITIONNEL (INDEX/FOREX) VIA YAHOO FINANCE
async function fetchYahooMarket(rawSymbol: string, type: string, timeConfig: IntervalConfig) {
  const yahooSymbol = resolveYahooSymbol(rawSymbol, type);
  const endpoints = [
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}`,
    `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}`
  ];

  let lastError: any;
  for (const url of endpoints) {
    try {
      const response = await HTTP.get(url, {
        params: {
          interval:       timeConfig.yahooInt,
          range:          timeConfig.yahooRange,
          includePrePost: true,
          events:         "history"
        },
        headers: {
          "Accept-Language": "en-US,en;q=0.9",
          "Referer":         "https://finance.yahoo.com"
        }
      });
      const result = response.data?.chart?.result?.[0];
      const error  = response.data?.chart?.error;
      if (!result || error) throw new Error(error?.description || "Yahoo Finance chart error");
      const quote = result?.indicators?.quote?.[0];
      const timestamps = result?.timestamp || [];
      if (!quote) throw new Error("Yahoo Finance quote vide");
      
      const candles = normalizeCandles(timestamps.map((t: number, i: number) => ({
        time: t * 1000,
        open: quote.open?.[i],
        high: quote.high?.[i],
        low:  quote.low?.[i],
        close: quote.close?.[i],
        volume: quote.volume?.[i] || 0
      })));
      const currentPrice = Number(result?.meta?.regularMarketPrice) || candles.at(-1)?.close || 0;
      return { candles: applyCurrentPrice(candles, currentPrice), currentPrice, source: `Yahoo Finance (${yahooSymbol})` };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error("Yahoo Finance inaccessible ou indisponible");
}

async function fetchMarketData({ symbol, type, timeConfig, provider }: { symbol: string; type: string; timeConfig: IntervalConfig; provider: string }) {
  if (type === "crypto") return fetchCryptoMarket(symbol, timeConfig, provider);
  return fetchYahooMarket(symbol, type, timeConfig);
}

// ============================================================
// ROUTES DE L'API REST
// ============================================================

// Statut et variables globales
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    uptime: round(process.uptime(), 2),
    timestamp: new Date().toISOString(),
    cache: { size: CACHE.size, maxSize: 200 },
    locks: { active: SIGNAL_LOCKS.size },
    stabilizationSettings: {
      lockDurationMs: SIGNAL_LOCK_MS,
      minimumConfidenceRequirement: 70
    }
  });
});

// Récupérer tous les signaux actuellement verrouillés (pour l'UI)
app.get("/api/locks", (req, res) => {
  const now = Date.now();
  const activeLocks: any[] = [];
  for (const [key, lock] of SIGNAL_LOCKS.entries()) {
    if (now > lock.expiresAt) {
      SIGNAL_LOCKS.delete(key);
      continue;
    }
    const secondsRemaining = Math.max(0, Math.round((lock.expiresAt - now) / 1000));
    activeLocks.push({
      key,
      signal: lock.signal,
      confidence: lock.confidence,
      score: lock.score,
      lockedAt: new Date(lock.lockedAt).toISOString(),
      expiresAt: new Date(lock.expiresAt).toISOString(),
      secondsRemaining,
      countdown: `${Math.floor(secondsRemaining / 60)}:${String(secondsRemaining % 60).padStart(2, "0")}`,
      tradePlan: lock.tradePlan
    });
  }
  res.json({ activeLocks, count: activeLocks.length });
});

// Forcer la suppression d'un lock depuis l'UI (super utile pour le débug ou réinitialiser)
app.post("/api/reset-lock", (req, res) => {
  const { key } = req.body;
  if (key && SIGNAL_LOCKS.has(key)) {
    SIGNAL_LOCKS.delete(key);
    res.json({ status: "success", message: `Verrou [${key}] libéré avec succès.` });
  } else {
    res.status(404).json({ status: "error", message: "Clé de verrouillage introuvable ou déjà expirée." });
  }
});

// ROUTE DU FILTRAGE DU MARCHÉ STABILISE (PRINCIPALE)
app.get("/api/market", async (req, res) => {
  try {
    let { symbol, type = "crypto", interval = "15m", news = "", provider = "" } = req.query;

    if (!symbol) {
      return res.status(400).json({ error: "Le paramètre 'symbol' est requis" });
    }

    const sym = String(symbol).trim();
    const t = String(type).toLowerCase().trim();
    const cleanType = (t === "indice" || t === "indices") ? "index" : t;
    
    let targetInterval = String(interval);
    if (!INTERVAL_MAP[targetInterval]) {
      targetInterval = "15m";
    }

    const timeConfig = INTERVAL_MAP[targetInterval];
    const cacheKey = `${cleanType}-${sym}-${targetInterval}-${provider}`;
    const lockKey = `${cleanType}-${compactSymbol(sym)}-${targetInterval}`;

    // 1. Avant d'aller chercher de nouvelles données en réseau, on regarde si le signal est locké.
    // Mais on veut toujours afficher les dernières bougies à l'utilisateur!
    // Donc on va chercher les données réseau, et on passera le signal fresh dans resolveStabilizedSignal
    
    // Vérification du Cache de Données Locales d'abord pour soulager les API tierces
    let marketData: any;
    const cachedItem = CACHE.get(cacheKey);
    if (cachedItem && (Date.now() - cachedItem.timestamp < timeConfig.cache)) {
      marketData = cachedItem.rawAnalysis;
    }

    let candles: Candle[] = [];
    let currentPrice = 0;
    let source = "";

    try {
      const fetched = await fetchMarketData({ symbol: sym, type: cleanType, timeConfig, provider: String(provider) });
      candles = fetched.candles;
      currentPrice = fetched.currentPrice;
      source = fetched.source;
    } catch (fetchErr: any) {
      // Fallback au cache s'il existe, même expiré
      if (cachedItem) {
        candles = cachedItem.data.candles || [];
        currentPrice = cachedItem.data.marketPrice || 0;
        source = `${cachedItem.data.source} (Cache Fallback)`;
      } else {
        throw fetchErr;
      }
    }

    if (!candles || candles.length < 60) {
      return res.status(404).json({
        error: "Données de marché insuffisantes pour ce symbole. 60 bougies minimum requises.",
        candles: candles?.length || 0,
        source
      });
    }

    // Calcul des signaux stabilisés
    const freshAnalysis = runSignalEngine(candles, String(news));
    const stabilizedResult = resolveStabilizedSignal(lockKey, freshAnalysis);

    const data = {
      symbol: compactSymbol(sym),
      type: cleanType,
      interval: targetInterval,
      marketPrice: currentPrice,
      formattedPrice: formatPrice(currentPrice),
      source,
      candles: candles.slice(-80), // On envoie les 80 dernières bougies pour afficher un beau graphique dans notre dashboard
      ...stabilizedResult,
      timestamp: new Date().toISOString()
    };

    // Mettre à jour le cache
    CACHE.set(cacheKey, { data, rawAnalysis: freshAnalysis, timestamp: Date.now() });

    return res.json(data);

  } catch (error: any) {
    console.error("Erreur serveur dans /api/market :", error.message);
    return res.status(502).json({
      error: "Impossible d'extraire les informations de marché.",
      details: error.message
    });
  }
});


// ============================================================
// INTEGRATION ET LANCEMENT DU FRONTEND ET DU RETAPE SERVEUR
// ============================================================
async function launchFullStack() {
  // En mode développement, on lance le Vite Dev Server comme middleware
  if (process.env.NODE_ENV !== "production") {
    console.log("[DevServer] Chargement de Vite Dev Server en middleware...");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa"
    });
    
    // Le serveur Vite redirige tous les fichiers non gérés par express vers le frontend React
    app.use(vite.middlewares);
  } else {
    // En production, Express héberge le build statique de Vite dans /dist
    console.log("[ProdServer] Hébergement du build statique depuis /dist...");
    const distPath = path.join(process.cwd(), "dist");
    
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  // Le PORT est imposé par la plateforme à 3000
  app.listen(PORT, HOST, () => {
    console.log(`\n======================================================`);
    console.log(`🟢 SERVER RUNNING AT http://localhost:${PORT}`);
    console.log(`🤖 Moteur de Trading Stabilisé Activé`);
    console.log(`⏱️ Période de verrouillage forcée : ${SIGNAL_LOCK_MS / 1000}s (3 minutes)`);
    console.log(`🎯 Seuil minimum de confiance requis : 70%`);
    console.log(`🏠 Mode host : ${HOST}`);
    console.log(`======================================================\n`);
  });
}

launchFullStack().catch(err => {
  console.error("Échec de l'initialisation du serveur Full-Stack :", err);
});

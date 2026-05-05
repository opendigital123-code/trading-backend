const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const CACHE = new Map();
const CACHE_DURATION = 15000; // 15 secondes

// ==================== CONFIGURATION DES TIMEFRAMES ====================
// Gère les limites strictes des API (surtout Yahoo Finance)
const INTERVAL_MAP = {
  '1m':  { binance: '1m',  yahooInt: '1m',  yahooRange: '5d' },  // Yahoo max 7d pour 1m
  '5m':  { binance: '5m',  yahooInt: '5m',  yahooRange: '30d' }, // Yahoo max 60d
  '15m': { binance: '15m', yahooInt: '15m', yahooRange: '30d' },
  '30m': { binance: '30m', yahooInt: '30m', yahooRange: '30d' },
  '1h':  { binance: '1h',  yahooInt: '60m', yahooRange: '60d' },
  '4h':  { binance: '4h',  yahooInt: '60m', yahooRange: '60d' }, // Yahoo ne fait pas 4h, on triche avec 1h
  '1d':  { binance: '1d',  yahooInt: '1d',  yahooRange: '2y' },
  '1w':  { binance: '1w',  yahooInt: '1wk', yahooRange: '5y' }
};

// ==================== FONCTIONS TECHNIQUES ====================
function calculateRSI(prices, period = 14) {
  if (prices.length <= period) return 50;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff > 0) avgGain += diff; else avgLoss += Math.abs(diff);
  }
  avgGain /= period; avgLoss /= period;
  for (let i = period + 1; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
  }
  return avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
}

function calculateEMA(prices, period) {
  if (prices.length < period) return prices[prices.length - 1] || 0;
  let sum = prices.slice(0, period).reduce((a, b) => a + b, 0);
  let ema = sum / period;
  const k = 2 / (period + 1);
  const result = [...Array(period).fill(ema)];
  for (let i = period; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
    result.push(ema);
  }
  return result;
}

function generateMultiFactorSignal(closes) {
  if (closes.length < 50) return { signal: 'HOLD', strength: 'FAIBLE', rsi: 50, ema50: 0, ema200: 0, score: 0, reasons: ["Pas assez de données"] };

  const currentPrice = closes[closes.length - 1];
  const rsi = calculateRSI(closes);
  const ema50 = calculateEMA(closes, 50)[closes.length - 1];
  const ema200 = closes.length >= 200 ? calculateEMA(closes, 200)[closes.length - 1] : currentPrice;

  let score = 0;
  const reasons = [];

  const bullishTrend = currentPrice > ema50 && ema50 >= ema200;
  const bearishTrend = currentPrice < ema50 && ema50 <= ema200;

  if (bullishTrend) { score += 30; reasons.push("Tendance Haussière (EMA)"); }
  else if (currentPrice > ema50) { score += 10; reasons.push("Biais Haussier court terme"); }

  if (bearishTrend) { score -= 30; reasons.push("Tendance Baissière (EMA)"); }
  else if (currentPrice < ema50) { score -= 10; reasons.push("Biais Baissier court terme"); }

  if (rsi >= 75) { score -= 25; reasons.push("RSI Surachat (Risque de correction)"); }
  else if (rsi > 55) { score += 15; reasons.push("Momentum Haussier (RSI)"); }
  else if (rsi <= 25) { score += 25; reasons.push("RSI Survente (Rebond potentiel)"); }
  else if (rsi < 45) { score -= 15; reasons.push("Momentum Baissier (RSI)"); }

  let signal = 'HOLD', strength = 'MOYEN';
  if (score >= 40) signal = 'BUY';
  else if (score <= -40) signal = 'SELL';

  if (Math.abs(score) >= 55) strength = 'FORT';
  else if (Math.abs(score) < 20) strength = 'FAIBLE';

  return {
    signal, strength,
    rsi: Number(rsi.toFixed(2)),
    ema50: Number(ema50.toFixed(2)),
    ema200: Number(ema200.toFixed(2)),
    score: Number(score.toFixed(1)),
    reasons
  };
}

// ==================== ROUTE PRINCIPALE ====================
app.get('/market', async (req, res) => {
  try {
    let { symbol, type = 'crypto', interval = '15m' } = req.query;
    if (!symbol) return res.status(400).json({ error: "Symbol requis" });

    // Nettoyage et vérification de l'intervalle
    symbol = symbol.toUpperCase().trim();
    if (!INTERVAL_MAP[interval]) interval = '1d'; // Fallback sécurisé
    const timeConfig = INTERVAL_MAP[interval];

    const cacheKey = `${type}-${symbol}-${interval}`;
    if (CACHE.has(cacheKey)) {
      const cached = CACHE.get(cacheKey);
      if (Date.now() - cached.timestamp < CACHE_DURATION) return res.json(cached.data);
    }

    let closes = [];
    let source = '';

    if (type === 'crypto') {
      // Nettoyage crypto : extraire juste la monnaie de base (ex: BTC/USDT -> BTC)
      const baseCoin = symbol.replace(/[^A-Z0-9]/g, '').replace(/USDT$|USD$|EUR$/, '');
      
      try {
        // TENTATIVE 1: Binance
       // TENTATIVE 1: Binance Futures (Contourne le blocage IP US de Render)
        const binanceSym = `${baseCoin}USDT`;
        const response = await axios.get('https://fapi.binance.com/fapi/v1/klines', {
          params: { symbol: binanceSym, interval: timeConfig.binance, limit: 300 },
          timeout: 4000
        });
        closes = response.data.map(c => parseFloat(c[4])).filter(p => p > 0);
        source = 'Binance';
      } catch (e) {
        console.log(`[Crypto] Binance a échoué pour ${baseCoin}, passage sur Yahoo...`);
        // TENTATIVE 2: Yahoo Finance (Fallback parfait pour Render)
        const yahooSym = `${baseCoin}-USD`;
        const response = await axios.get(`https://query2.finance.yahoo.com/v8/finance/chart/${yahooSym}`, {
          params: { interval: timeConfig.yahooInt, range: timeConfig.yahooRange },
          timeout: 5000
        });
        const quote = response.data?.chart?.result?.[0]?.indicators?.quote?.[0];
        closes = quote?.close?.filter(p => p !== null && p > 0) || [];
        source = 'Yahoo Finance';
      }
    } else {
      // FINANCE TRADITIONNELLE (Forex, Stocks, Commodities)
      const response = await axios.get(`https://query2.finance.yahoo.com/v8/finance/chart/${symbol}`, {
        params: { interval: timeConfig.yahooInt, range: timeConfig.yahooRange },
        timeout: 5000
      });
      const quote = response.data?.chart?.result?.[0]?.indicators?.quote?.[0];
      closes = quote?.close?.filter(p => p !== null && p > 0) || [];
      source = 'Yahoo Finance';
    }

    if (!closes || closes.length < 20) {
      return res.status(404).json({ error: "Données introuvables ou timeframe non supporté pour cet actif." });
    }

    const currentPrice = closes[closes.length - 1];
    const analysis = generateMultiFactorSignal(closes);

    const data = {
      symbol: symbol,
      marketPrice: Number(currentPrice.toFixed(4)),
      source,
      ...analysis,
      timestamp: new Date().toISOString()
    };

    CACHE.set(cacheKey, { data, timestamp: Date.now() });
    res.json(data);

  } catch (error) {
    console.error(`Erreur /market (${req.query.symbol} - ${req.query.interval}):`, error.message);
    res.status(500).json({ 
      error: "Impossible de charger les données",
      message: "Vérifiez le symbole (ex: AAPL, EURUSD=X, BTC). L'API peut être temporairement bloquée."
    });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Serveur lancé sur le port ${PORT}`);
});

const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Cache
const CACHE = new Map();
const CACHE_DURATION = 10000;

// ==================== FONCTIONS (inchangées) ====================
function calculateRSI(prices, period = 14) {
  if (prices.length < period + 1) return 50;
  let avgGain = 0, avgLoss = 0;

  for (let i = 1; i <= period; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff > 0) avgGain += diff;
    else avgLoss += Math.abs(diff);
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
  if (closes.length < 150) {
    return { signal: 'HOLD', strength: 'FAIBLE', rsi: 50, ema50: 0, ema200: 0, reasons: ["Données insuffisantes"] };
  }

  const currentPrice = closes[closes.length - 1];
  const rsi = calculateRSI(closes);
  const ema50 = calculateEMA(closes, 50)[closes.length - 1];
  const ema200 = calculateEMA(closes, 200)[closes.length - 1];

  let score = 0;
  const reasons = [];

  if (rsi <= 28) { score += 40; reasons.push("RSI Extrêmement Survente"); }
  else if (rsi < 35) { score += 25; reasons.push("RSI Survente"); }
  else if (rsi >= 78) { score -= 42; reasons.push("RSI Extrêmement Surachat"); }
  else if (rsi > 70) { score -= 28; reasons.push("RSI Surachat"); }

  const bullish = currentPrice > ema50 && ema50 > ema200;
  const bearish = currentPrice < ema50 && ema50 < ema200;

  if (bullish) { score += 35; reasons.push("Tendance Haussière Forte"); }
  if (bearish) { score -= 38; reasons.push("Tendance Baissière Forte"); }

  const data = {
    signal: score >= 45 ? 'BUY' : score <= -40 ? 'SELL' : 'HOLD',
    strength: score >= 65 ? 'FORT' : score <= -55 ? 'FORT' : 'MOYEN',
    rsi: Number(rsi.toFixed(2)),
    ema50: Number(ema50.toFixed(2)),
    ema200: Number(ema200.toFixed(2)),
    score: Number(score.toFixed(1)),
    reasons
  };
  return data;
}

// ==================== ROUTE CORRIGÉE ====================
app.get('/market', async (req, res) => {
  try {
    let { symbol, type = 'crypto', interval = '15m' } = req.query;
    if (!symbol) return res.status(400).json({ error: "Symbol requis" });

    const cacheKey = `${type}-${symbol}-${interval}`;
    if (CACHE.has(cacheKey)) {
      const cached = CACHE.get(cacheKey);
      if (Date.now() - cached.timestamp < CACHE_DURATION) return res.json(cached.data);
    }

    let closes = [];
    let currentPrice = 0;
    let source = '';

    if (type === 'crypto') {
      // Binance pour crypto
      const binanceSymbol = symbol.replace('/', '').toUpperCase();
      const response = await axios.get('https://api.binance.com/api/v3/klines', {
        params: { symbol: binanceSymbol, interval, limit: 300 },
        timeout: 10000
      });
      closes = response.data.map(c => parseFloat(c[4])).filter(p => !isNaN(p) && p > 0);
      source = 'Binance';
    } else {
      // Yahoo Finance pour Forex, Commodities, Stocks
      const yahooSymbol = symbol;
      const response = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}`, {
        params: { interval, range: interval === '1d' ? '60d' : '30d' },
        headers: { 'User-Agent': 'Mozilla/5.0' },
        timeout: 10000
      });

      const quote = response.data?.chart?.result?.[0]?.indicators?.quote?.[0];
      closes = quote?.close?.filter(p => p && p > 0) || [];
      source = 'Yahoo Finance';
    }

    if (closes.length < 100) throw new Error("Données insuffisantes");

    currentPrice = closes[closes.length - 1];
    const analysis = generateMultiFactorSignal(closes);

    const data = {
      symbol: symbol.replace('=X', '').replace('=F', '').replace('^', ''),
      marketPrice: Number(currentPrice.toFixed(2)),
      source,
      ...analysis,
      timestamp: new Date().toISOString()
    };

    CACHE.set(cacheKey, { data, timestamp: Date.now() });
    res.json(data);

  } catch (error) {
    console.error(`Erreur /market (${req.query.symbol}):`, error.message);
    res.status(500).json({ 
      error: "Impossible de charger les données",
      message: error.message,
      symbol: req.query.symbol,
      type: req.query.type
    });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Serveur lancé sur port ${PORT}`);
});

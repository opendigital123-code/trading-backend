const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ==================== CACHE AMÉLIORÉ ====================
const CACHE = new Map();
const CACHE_DURATION = 8000; // Réduit à 8 secondes pour plus de réactivité

// ==================== FONCTIONS ====================
function calculateRSI(prices, period = 14) {
  if (prices.length < period + 1) return 50;
  let avgGain = 0, avgLoss = 0;

  for (let i = 1; i <= period; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff > 0) avgGain += diff;
    else avgLoss -= diff;
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
  if (prices.length < period) return prices[prices.length - 1] || 0;
  const k = 2 / (period + 1);
  let ema = prices[0];
  const result = [ema];
  for (let i = 1; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
    result.push(ema);
  }
  return result;
}

function generateMultiFactorSignal(closes) {
  const currentPrice = closes[closes.length - 1];
  const rsi = calculateRSI(closes);
  const ema50 = calculateEMA(closes, 50)[closes.length - 1];
  const ema200 = calculateEMA(closes, 200)[closes.length - 1];

  let score = 0;
  const reasons = [];

  if (rsi < 28) { score += 40; reasons.push("RSI Extrêmement Survente"); }
  else if (rsi < 35) { score += 24; reasons.push("RSI Survente"); }
  else if (rsi > 78) { score -= 42; reasons.push("RSI Extrêmement Surachat"); }
  else if (rsi > 70) { score -= 26; reasons.push("RSI Surachat"); }

  const bullishTrend = currentPrice > ema50 && ema50 > ema200;
  const bearishTrend = currentPrice < ema50 && ema50 < ema200;

  if (bullishTrend) { score += 32; reasons.push("Tendance Haussière Forte"); }
  if (bearishTrend) { score -= 36; reasons.push("Tendance Baissière Forte"); }

  const distance = ((currentPrice - ema50) / ema50) * 100;
  if (distance < -4.5) score += 14;
  if (distance > 4.5) score -= 14;

  let signal = 'HOLD';
  let strength = 'MOYEN';

  if (score >= 50) { 
    signal = 'BUY'; 
    strength = score >= 68 ? 'FORT' : 'MOYEN'; 
  } 
  else if (score <= -46) { 
    signal = 'SELL'; 
    strength = score <= -64 ? 'FORT' : 'MOYEN'; 
  }

  return {
    signal,
    strength,
    rsi: Number(rsi.toFixed(2)),
    ema50: Number(ema50.toFixed(2)),
    ema200: Number(ema200.toFixed(2)),
    reasons: reasons.slice(0, 5)
  };
}

// ==================== ROUTE PRINCIPALE ====================
app.get('/market', async (req, res) => {
  try {
    let { symbol, type = 'crypto', interval = '5m' } = req.query;
    if (!symbol) return res.status(400).json({ error: "Symbol requis" });

    const cacheKey = `${type}-${symbol}-${interval}`;

    // Force refresh si changement de timeframe
    if (CACHE.has(cacheKey)) {
      const cached = CACHE.get(cacheKey);
      if (Date.now() - cached.timestamp < CACHE_DURATION) {
        return res.json(cached.data);
      }
    }

    let closes = [];
    let currentPrice = 0;

    if (type === 'crypto') {
      const binanceRes = await axios.get('https://api.binance.com/api/v3/klines', {
        params: { 
          symbol: symbol.toUpperCase(), 
          interval, 
          limit: interval === '1d' ? 200 : 500 
        },
        timeout: 10000
      });
      closes = binanceRes.data.map(k => parseFloat(k[4]));
    } else {
      let yahooSymbol = symbol;
      const yahooRes = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}`, {
        params: { 
          interval, 
          range: interval === '1d' ? '30d' : '10d' 
        },
        headers: { 'User-Agent': 'Mozilla/5.0' },
        timeout: 15000
      });

      const result = yahooRes.data?.chart?.result?.[0];
      closes = result?.indicators?.quote?.[0]?.close?.filter(p => p > 0) || [];
    }

    if (closes.length < 40) throw new Error(`Données insuffisantes pour ${interval}`);

    const analysis = generateMultiFactorSignal(closes);
    currentPrice = closes[closes.length - 1];

    const data = {
      symbol,
      marketPrice: Number(currentPrice.toFixed(4)),
      ...analysis,
      timestamp: new Date().toISOString()
    };

    CACHE.set(cacheKey, { data, timestamp: Date.now() });
    res.json(data);

  } catch (error) {
    console.error(error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Trading Server optimisé sur port ${PORT}`);
});

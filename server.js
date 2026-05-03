const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ==================== INDICATEURS ====================

function calculateRSI(prices, period = 14) {
  if (prices.length < period + 1) return 50;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = prices[i] - prices[i-1];
    if (diff > 0) avgGain += diff; else avgLoss -= diff;
  }
  avgGain /= period; avgLoss /= period;

  for (let i = period + 1; i < prices.length; i++) {
    const diff = prices[i] - prices[i-1];
    avgGain = (avgGain * (period-1) + Math.max(diff,0)) / period;
    avgLoss = (avgLoss * (period-1) + Math.max(-diff,0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain/avgLoss);
}

function calculateEMA(prices, period) {
  const k = 2 / (period + 1);
  let ema = prices[0];
  const res = [ema];
  for (let i = 1; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1-k);
    res.push(ema);
  }
  return res;
}

// ==================== ANALYSE MULTI-FACTEURS ====================
function generateMultiFactorSignal(closes) {
  const currentPrice = closes[closes.length-1];
  const rsi = calculateRSI(closes);
  const ema50 = calculateEMA(closes, 50)[closes.length-1];
  const ema200 = calculateEMA(closes, 200)[closes.length-1];

  let score = 0;
  const reasons = [];

  // 1. RSI
  if (rsi < 25) { score += 35; reasons.push("RSI Extrêmement Survente"); }
  else if (rsi < 32) { score += 20; reasons.push("RSI Survente"); }
  else if (rsi > 75) { score -= 35; reasons.push("RSI Extrêmement Surachat"); }
  else if (rsi > 68) { score -= 20; reasons.push("RSI Surachat"); }

  // 2. Tendance EMA
  const bullishTrend = currentPrice > ema50 && ema50 > ema200;
  const bearishTrend = currentPrice < ema50 && ema50 < ema200;

  if (bullishTrend) { score += 30; reasons.push("Tendance Haussière Forte (EMA)"); }
  if (bearishTrend) { score -= 30; reasons.push("Tendance Baissière Forte (EMA)"); }
  if (currentPrice > ema50) score += 10;

  // 3. Position relative
  const distanceToEma50 = ((currentPrice - ema50) / ema50) * 100;
  if (distanceToEma50 < -5) score += 15;        // Loin en dessous → possible rebond

  // 4. Décision finale
  let signal = 'HOLD';
  let strength = 'MOYEN';

  if (score >= 55) { signal = 'BUY'; strength = 'FORT'; }
  else if (score >= 35) { signal = 'BUY'; strength = 'MOYEN'; }
  else if (score <= -55) { signal = 'SELL'; strength = 'FORT'; }
  else if (score <= -35) { signal = 'SELL'; strength = 'MOYEN'; }

  return {
    signal,
    strength,
    score: Math.round(score),
    rsi: Number(rsi.toFixed(2)),
    ema50: Number(ema50.toFixed(2)),
    ema200: Number(ema200.toFixed(2)),
    reasons: reasons.slice(0, 4)
  };
}

// ==================== ROUTE ====================
app.get('/market', async (req, res) => {
  try {
    const { symbol = 'BTCUSDT', type = 'crypto' } = req.query;

    let yahooSymbol = symbol;
    if (type === 'crypto') {
      const map = { BTCUSDT: 'BTC-USD', ETHUSDT: 'ETH-USD', BNBUSDT: 'BNB-USD', SOLUSDT: 'SOL-USD' };
      yahooSymbol = map[symbol] || 'BTC-USD';
    }

    const response = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}`, {
      params: { interval: '5m', range: '5d' },
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 10000
    });

    const result = response.data?.chart?.result?.[0];
    const closes = result?.indicators?.quote?.[0]?.close?.filter(p => p > 0) || [];

    if (closes.length < 100) throw new Error('Données insuffisantes');

    const analysis = generateMultiFactorSignal(closes);
    const currentPrice = closes[closes.length-1];

    res.json({
      symbol,
      marketPrice: Number(currentPrice.toFixed(4)),
      ...analysis,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error(error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Advanced Multi-Factor Server on ${PORT}`);
});

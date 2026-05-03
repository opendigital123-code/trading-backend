const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ==================== FONCTIONS INDICATEURS ====================

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
  const k = 2 / (period + 1);
  let ema = prices[0];
  const result = [ema];
  for (let i = 1; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
    result.push(ema);
  }
  return result;
}

// ==================== ROUTE MARKET ====================

app.get('/market', async (req, res) => {
  try {
    const { symbol = 'BTCUSDT', interval = '15m' } = req.query;

    const response = await axios.get('https://api.binance.com/api/v3/klines', {
      params: { symbol: symbol.toUpperCase(), interval, limit: 300 },
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      timeout: 15000
    });

    const closes = response.data.map(k => parseFloat(k[4]));

    if (closes.length < 50) {
      throw new Error('Données insuffisantes de Binance');
    }

    const currentPrice = closes[closes.length - 1];
    const rsi = calculateRSI(closes);
    const ema50 = calculateEMA(closes, 50)[closes.length - 1];
    const ema200 = calculateEMA(closes, 200)[closes.length - 1];

    let signal = 'HOLD';
    let strength = 'MOYEN';

    if (rsi < 30 && currentPrice > ema50) {
      signal = 'BUY';
      strength = rsi < 25 ? 'FORT' : 'MOYEN';
    } else if (rsi > 70 && currentPrice < ema50) {
      signal = 'SELL';
      strength = rsi > 75 ? 'FORT' : 'MOYEN';
    }

    res.json({
      symbol,
      marketPrice: Number(currentPrice.toFixed(4)),
      rsi: Number(rsi.toFixed(2)),
      ema50: Number(ema50.toFixed(2)),
      ema200: Number(ema200.toFixed(2)),
      signal,
      strength,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({ 
      error: error.message || 'Erreur interne du serveur' 
    });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Serveur lancé sur port ${PORT}`);
});

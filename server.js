const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

function calculateRSI(prices, period = 14) {
  if (prices.length < period + 1) return 50;
  let avgGain = 0, avgLoss = 0;

  for (let i = 1; i <= period; i++) {
    const diff = prices[i] - prices[i-1];
    if (diff > 0) avgGain += diff; else avgLoss -= diff;
  }
  avgGain /= period;
  avgLoss /= period;

  for (let i = period + 1; i < prices.length; i++) {
    const diff = prices[i] - prices[i-1];
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

function calculateMACD(prices) {
  const ema12 = calculateEMA(prices, 12);
  const ema26 = calculateEMA(prices, 26);
  const macdLine = ema12.map((v, i) => v - ema26[i]);
  const signalLine = calculateEMA(macdLine, 9);
  const histogram = macdLine.map((v, i) => v - signalLine[i]);
  return { macdLine, signalLine, histogram };
}

function generateAdvancedSignal(data) {
  const { rsi, ema50, ema200, macd, currentPrice } = data;
  let score = 0;
  const reasons = [];

  if (rsi < 25) { score += 3; reasons.push("RSI très survente"); }
  else if (rsi < 32) { score += 1.5; reasons.push("RSI survente"); }

  if (rsi > 75) { score -= 3; reasons.push("RSI très surachat"); }
  else if (rsi > 68) { score -= 1.5; reasons.push("RSI surachat"); }

  if (currentPrice > ema50 && ema50 > ema200) { score += 3; reasons.push("Tendance haussière"); }
  if (currentPrice < ema50 && ema50 < ema200) { score -= 3; reasons.push("Tendance baissière"); }

  const lastMacd = macd.macdLine[macd.macdLine.length-1];
  const lastSignal = macd.signalLine[macd.signalLine.length-1];
  if (lastMacd > lastSignal) { score += 1.5; reasons.push("MACD haussier"); }
  if (lastMacd < lastSignal) { score -= 1.5; reasons.push("MACD baissier"); }

  let signal = 'HOLD';
  let strength = 'MOYEN';

  if (score >= 5) { signal = 'BUY'; strength = 'FORT'; }
  else if (score >= 2.5) { signal = 'BUY'; }
  else if (score <= -5) { signal = 'SELL'; strength = 'FORT'; }
  else if (score <= -2.5) { signal = 'SELL'; }

  return { signal, strength, score: Number(score.toFixed(1)), reasons: reasons.slice(0, 3) };
}

app.get('/market', async (req, res) => {
  try {
    const { symbol = 'BTCUSDT', interval = '15m' } = req.query;
    const response = await axios.get(`https://api.binance.com/api/v3/klines`, {
      params: { symbol, interval, limit: 500 }
    });

    const closes = response.data.map(k => parseFloat(k[4]));
    const currentPrice = closes[closes.length - 1];

    const rsi = calculateRSI(closes);
    const ema50 = calculateEMA(closes, 50)[closes.length-1];
    const ema200 = calculateEMA(closes, 200)[closes.length-1];
    const macd = calculateMACD(closes);

    const signalData = generateAdvancedSignal({ rsi, ema50, ema200, macd, currentPrice });

    res.json({
      symbol,
      marketPrice: Number(currentPrice.toFixed(4)),
      rsi: Number(rsi.toFixed(2)),
      ema50: Number(ema50.toFixed(2)),
      ema200: Number(ema200.toFixed(2)),
      signal: signalData.signal,
      strength: signalData.strength,
      reasons: signalData.reasons,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error(error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Advanced Trading Server on port ${PORT}`);
});

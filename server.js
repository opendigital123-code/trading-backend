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
    if (diff > 0) avgGain += diff;
    else avgLoss -= diff;
  }
  avgGain /= period;
  avgLoss /= period;

  for (let i = period + 1; i < prices.length; i++) {
    const diff = prices[i] - prices[i-1];
    avgGain = (avgGain * (period-1) + (diff > 0 ? diff : 0)) / period;
    avgLoss = (avgLoss * (period-1) + (diff < 0 ? -diff : 0)) / period;
  }

  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + avgGain / avgLoss));
}

function calculateEMA(prices, period) {
  const k = 2 / (period + 1);
  let ema = prices[0];
  const emas = [ema];

  for (let i = 1; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
    emas.push(ema);
  }
  return emas;
}

function calculateMACD(prices) {
  const ema12 = calculateEMA(prices, 12);
  const ema26 = calculateEMA(prices, 26);
  const macdLine = ema12.map((v, i) => v - ema26[i]);
  const signalLine = calculateEMA(macdLine, 9);
  const histogram = macdLine.map((v, i) => v - signalLine[i]);

  return { macdLine, signalLine, histogram };
}

// ==================== SIGNAL LOGIQUE AVANCÉE ====================
function generateAdvancedSignal(data) {
  const { rsi, ema50, ema200, macd, currentPrice } = data;
  let score = 0;
  let reason = [];

  // RSI
  if (rsi < 25) { score += 3; reason.push("RSI très survente"); }
  else if (rsi < 32) { score += 2; reason.push("RSI survente"); }
  else if (rsi > 75) { score -= 3; reason.push("RSI très surachat"); }
  else if (rsi > 68) { score -= 2; reason.push("RSI surachat"); }

  // Tendance EMA
  if (currentPrice > ema50 && ema50 > ema200) { score += 3; reason.push("Tendance haussière forte"); }
  else if (currentPrice < ema50 && ema50 < ema200) { score -= 3; reason.push("Tendance baissière forte"); }
  else if (currentPrice > ema50) { score += 1; reason.push("Au-dessus EMA50"); }

  // MACD
  const lastMacd = macd.macdLine[macd.macdLine.length-1];
  const lastSignal = macd.signalLine[macd.signalLine.length-1];
  const lastHist = macd.histogram[macd.histogram.length-1];

  if (lastMacd > lastSignal && lastHist > 0) { score += 2; reason.push("MACD haussier"); }
  if (lastMacd < lastSignal && lastHist < 0) { score -= 2; reason.push("MACD baissier"); }

  // Décision finale
  let signal = 'HOLD';
  let strength = 'MOYEN';

  if (score >= 5) { signal = 'BUY'; strength = 'FORT'; }
  else if (score >= 3) { signal = 'BUY'; strength = 'MOYEN'; }
  else if (score <= -5) { signal = 'SELL'; strength = 'FORT'; }
  else if (score <= -3) { signal = 'SELL'; strength = 'MOYEN'; }

  return { signal, strength, score, reasons: reason.slice(0, 3) };
}

// ==================== FETCH BINANCE (plus précis) ====================
async function fetchBinanceKlines(symbol, interval = '15m', limit = 500) {
  const response = await axios.get(`https://api.binance.com/api/v3/klines`, {
    params: { symbol, interval, limit },
    timeout: 10000
  });

  return response.data.map(k => parseFloat(k[4])); // Close prices
}

app.get('/market', async (req, res) => {
  try {
    const { symbol = 'BTCUSDT', interval = '15m' } = req.query;
    
    const closes = await fetchBinanceKlines(symbol, interval);

    const rsi = calculateRSI(closes);
    const emas50 = calculateEMA(closes, 50);
    const emas200 = calculateEMA(closes, 200);
    const macd = calculateMACD(closes);

    const currentPrice = closes[closes.length - 1];

    const signalData = generateAdvancedSignal({
      rsi,
      ema50: emas50[emas50.length-1],
      ema200: emas200[emas200.length-1],
      macd,
      currentPrice
    });

    res.json({
      symbol,
      marketPrice: currentPrice,
      rsi: Number(rsi.toFixed(2)),
      ema50: Number(emas50[emas50.length-1].toFixed(2)),
      ema200: Number(emas200[emas200.length-1].toFixed(2)),
      signal: signalData.signal,
      strength: signalData.strength,
      reasons: signalData.reasons,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Advanced Trading Assistant running on ${PORT}`);
});

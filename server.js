// server.js
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// === MIDDLEWARE ===
app.use(cors());                    // ← Important pour Expo
app.use(express.json());

const MARKET_OPTIONS = {
  crypto: {
    BTCUSDT: 'BTC/USDT',
    ETHUSDT: 'ETH/USDT',
    BNBUSDT: 'BNB/USDT',
    SOLUSDT: 'SOL/USDT',
  },
  forex: {
    'EURUSD=X': 'EUR/USD',
    'GBPUSD=X': 'GBP/USD',
    'USDJPY=X': 'USD/JPY',
    'AUDUSD=X': 'AUD/USD',
  },
};

const CRYPTO_YAHOO_SYMBOLS = {
  BTCUSDT: 'BTC-USD',
  ETHUSDT: 'ETH-USD',
  BNBUSDT: 'BNB-USD',
  SOLUSDT: 'SOL-USD',
};

// === RSI AMÉLIORÉ (Wilder smoothing) ===
function calculateRSI(prices, period = 14) {
  if (prices.length < period + 1) return 50;

  let gains = 0;
  let losses = 0;

  // Première moyenne
  for (let i = 1; i <= period; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  // Lissage Wilder pour le reste
  for (let i = period + 1; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];

    avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? -diff : 0)) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// === FONCTIONS FETCH ===
async function fetchYahooMarket(symbol) {
  const response = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`, {
    params: { interval: '5m', range: '2d' },   // 2 jours pour plus de données
    timeout: 8000,
  });

  const result = response.data?.chart?.result?.[0];
  if (!result) throw new Error('No data from Yahoo');

  const closes = result.indicators?.quote?.[0]?.close ?? [];
  const validCloses = closes
    .map(Number)
    .filter(price => Number.isFinite(price) && price > 0);

  if (validCloses.length < 20) throw new Error('Not enough price data');

  return validCloses;
}

async function getMarketSnapshot(type, symbol) {
  const marketType = type === 'forex' ? 'forex' : 'crypto';
  const options = MARKET_OPTIONS[marketType];
  const resolvedSymbol = options[symbol] ? symbol : Object.keys(options)[0];

  const yahooSymbol = marketType === 'crypto' 
    ? CRYPTO_YAHOO_SYMBOLS[resolvedSymbol] 
    : resolvedSymbol;

  const closes = await fetchYahooMarket(yahooSymbol);

  return {
    type: marketType,
    symbol: options[resolvedSymbol],
    marketPrice: Number(closes[closes.length - 1].toFixed(6)),
    rsi: Number(calculateRSI(closes).toFixed(2)),
    timestamp: new Date().toISOString()
  };
}

// === ROUTES ===
app.get('/market', async (req, res) => {
  try {
    const { type, symbol } = req.query;
    if (!type || !symbol) {
      return res.status(400).json({ error: 'type and symbol are required' });
    }

    const snapshot = await getMarketSnapshot(type, symbol);
    res.json(snapshot);
  } catch (error) {
    console.error('Market error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date() }));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Serveur running on port ${PORT}`);
});

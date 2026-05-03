// Import des librairies
const express = require('express');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

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

function calculateRSI(prices, period = 14) {
  const gains = [];
  const losses = [];

  for (let i = 1; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];

    if (diff >= 0) {
      gains.push(diff);
      losses.push(0);
    } else {
      gains.push(0);
      losses.push(Math.abs(diff));
    }
  }

  const avgGain = gains.slice(-period).reduce((a, b) => a + b, 0) / period;
  const avgLoss = losses.slice(-period).reduce((a, b) => a + b, 0) / period;

  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;

  return 100 - 100 / (1 + rs);
}

function resolveMarket(type, symbol) {
  const marketType = type === 'forex' ? 'forex' : 'crypto';
  const options = MARKET_OPTIONS[marketType];
  const fallbackSymbol = Object.keys(options)[0];
  const resolvedSymbol = options[symbol] ? symbol : fallbackSymbol;

  return {
    type: marketType,
    symbol: resolvedSymbol,
    displaySymbol: options[resolvedSymbol],
  };
}

async function fetchCryptoMarket(symbol) {
  const yahooSymbol = CRYPTO_YAHOO_SYMBOLS[symbol];

  if (!yahooSymbol) {
    throw new Error(`Unsupported crypto symbol ${symbol}`);
  }

  return fetchYahooMarket(yahooSymbol);
}

async function fetchYahooMarket(symbol) {
  const response = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`, {
    params: {
      interval: '5m',
      range: '1d',
    },
  });

  const result = response.data?.chart?.result?.[0];
  const closes = result?.indicators?.quote?.[0]?.close ?? [];

  return closes.map(Number).filter((price) => Number.isFinite(price) && price > 0);
}

async function fetchForexMarket(symbol) {
  return fetchYahooMarket(symbol);
}

async function getMarketSnapshot(type, symbol) {
  const market = resolveMarket(type, symbol);
  const closes =
    market.type === 'forex'
      ? await fetchForexMarket(market.symbol)
      : await fetchCryptoMarket(market.symbol);

  if (closes.length < 15) {
    throw new Error(`Not enough price data for ${market.displaySymbol}`);
  }

  return {
    type: market.type,
    symbol: market.displaySymbol,
    marketPrice: closes[closes.length - 1],
    rsi: calculateRSI(closes),
  };
}

app.get('/market', async (req, res) => {
  try {
    const snapshot = await getMarketSnapshot(req.query.type, req.query.symbol);

    res.json(snapshot);
  } catch (error) {
    console.log(error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/rsi', async (req, res) => {
  try {
    const snapshot = await getMarketSnapshot('crypto', 'BTCUSDT');

    res.json(snapshot);
  } catch (error) {
    console.log(error.message);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Serveur lance sur http://0.0.0.0:${PORT}`);
});

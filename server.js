const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.get('/market', async (req, res) => {
  try {
    const { symbol = 'BTCUSDT', interval = '15m' } = req.query;

    const response = await axios.get('https://api.binance.com/api/v3/klines', {
      params: {
        symbol: symbol.toUpperCase(),
        interval,
        limit: 300
      },
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
      },
      timeout: 15000
    });

    const closes = response.data.map(k => parseFloat(k[4]));
    
    if (closes.length < 50) {
      throw new Error('Données insuffisantes');
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
    } 
    else if (rsi > 70 && currentPrice < ema50) {
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
    console.error('Binance Error:', error.message);
    if (error.response?.status === 451) {
      res.status(500).json({ 
        error: "Binance bloque la requête depuis ton pays. On va changer de source." 
      });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

    const currentPrice = closes[closes.length - 1];
    const rsi = calculateRSI(closes);
    const ema50 = calculateEMA(closes, 50)[closes.length - 1];
    const ema200 = calculateEMA(closes, 200)[closes.length - 1];

    // Signal simple mais fiable
    let signal = 'HOLD';
    let strength = 'MOYEN';

    if (rsi < 30 && currentPrice > ema50) {
      signal = 'BUY';
      strength = rsi < 25 ? 'FORT' : 'MOYEN';
    } 
    else if (rsi > 70 && currentPrice < ema50) {
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
      error: error.message || 'Internal server error',
      tip: 'Vérifie que le symbol est correct (ex: BTCUSDT)'
    });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const TWELVE_API_KEY = process.env.TWELVE_API_KEY || '134818b4120c4258a581c132d18177ca';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const CACHE = new Map();

const YAHOO_HEADERS = {
  'User-Agent': 'Mozilla/5.0'
};

const INTERVAL_MAP = {
  '1m': { binance: '1m', yahooInt: '1m', yahooRange: '5d', cache: 5000 },
  '5m': { binance: '5m', yahooInt: '5m', yahooRange: '30d', cache: 10000 },
  '15m': { binance: '15m', yahooInt: '15m', yahooRange: '30d', cache: 15000 },
  '30m': { binance: '30m', yahooInt: '30m', yahooRange: '30d', cache: 20000 },
  '1h': { binance: '1h', yahooInt: '60m', yahooRange: '60d', cache: 30000 },
  '4h': { binance: '4h', yahooInt: '60m', yahooRange: '60d', cache: 60000 },
  '1d': { binance: '1d', yahooInt: '1d', yahooRange: '2y', cache: 120000 },
  '1w': { binance: '1w', yahooInt: '1wk', yahooRange: '5y', cache: 300000 }
};

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return 0;
  return Number(value.toFixed(digits));
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function formatPrice(value) {
  if (!Number.isFinite(value)) return null;

  const abs = Math.abs(value);

  if (abs >= 1000) {
    return Number(value.toFixed(2)).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  if (abs >= 1) {
    return Number(value.toFixed(4)).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 4
    });
  }

  return Number(value.toFixed(8)).toString();
}

function calculateRSI(prices, period = 14) {
  if (prices.length <= period) return 50;

  let avgGain = 0;
  let avgLoss = 0;

  for (let i = 1; i <= period; i++) {
    const diff = prices[i] - prices[i - 1];
    avgGain += Math.max(diff, 0);
    avgLoss += Math.max(-diff, 0);
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
  if (prices.length < period) {
    return prices.map(() => prices[prices.length - 1] || 0);
  }

  let ema = average(prices.slice(0, period));
  const k = 2 / (period + 1);
  const result = Array(period - 1).fill(null);

  result.push(ema);

  for (let i = period; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
    result.push(ema);
  }

  return result;
}

function calculateATR(candles, period = 14) {
  if (candles.length <= period) return 0;

  const trueRanges = [];

  for (let i = 1; i < candles.length; i++) {
    const current = candles[i];
    const previous = candles[i - 1];

    trueRanges.push(Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close)
    ));
  }

  return average(trueRanges.slice(-period));
}

function calculateVWAP(candles, period = 30) {
  const recent = candles.slice(-period);
  let pv = 0;
  let volume = 0;

  for (const candle of recent) {
    const typical = (candle.high + candle.low + candle.close) / 3;
    pv += typical * candle.volume;
    volume += candle.volume;
  }

  return volume > 0 ? pv / volume : recent[recent.length - 1]?.close || 0;
}

function calculateVolumeRatio(candles, period = 20) {
  const volumes = candles.map(c => c.volume).filter(v => v > 0);
  if (volumes.length < period + 1) return 1;

  const current = volumes[volumes.length - 1];
  const base = average(volumes.slice(-(period + 1), -1));

  return base > 0 ? current / base : 1;
}

function calculateMomentum(prices, period = 5) {
  if (prices.length <= period) return 0;

  const current = prices[prices.length - 1];
  const previous = prices[prices.length - 1 - period];

  return previous !== 0 ? ((current - previous) / previous) * 100 : 0;
}

function calculateSupportResistance(candles, period = 30) {
  const recent = candles.slice(-period);

  return {
    support: Math.min(...recent.map(c => c.low)),
    resistance: Math.max(...recent.map(c => c.high))
  };
}

function normalizeNewsScore(news = '') {
  const text = String(news).toLowerCase();

  const bullishWords = [
    'bullish', 'breakout', 'surge', 'rally', 'upgrade', 'beat',
    'partnership', 'approval', 'adoption', 'accumulation', 'record high',
    'hausse', 'explosion', 'partenariat', 'adoption', 'achat'
  ];

  const bearishWords = [
    'bearish', 'crash', 'dump', 'lawsuit', 'hack', 'ban', 'downgrade',
    'miss', 'selloff', 'liquidation', 'fraud', 'rejection',
    'baisse', 'chute', 'piratage', 'interdiction', 'vente'
  ];

  let score = 0;

  for (const word of bullishWords) {
    if (text.includes(word)) score += 1;
  }

  for (const word of bearishWords) {
    if (text.includes(word)) score -= 1;
  }

  return Math.max(-10, Math.min(10, score * 2));
}

function generateScalpingSignal(candles, options = {}) {
  const tp1Percent = 1.8;
  const tp2Percent = 3;

  if (candles.length < 60) {
    return {
      signal: 'HOLD',
      strength: 'FAIBLE',
      confidence: 0,
      score: 0,
      entry: null,
      entryZone: null,
      stopLoss: null,
      takeProfit1: null,
      takeProfit2: null,
      tp1Percent,
      tp2Percent,
      support: null,
      resistance: null,
      invalidation: 'Pas assez de donnees pour definir une zone fiable',
      exitPlan: null,
      tradePlan: {
        action: 'HOLD',
        entry: null,
        entryZone: null,
        stopLoss: null,
        takeProfit1: null,
        takeProfit2: null,
        tp1Percent,
        tp2Percent,
        support: null,
        resistance: null,
        invalidation: 'Pas assez de donnees pour definir une zone fiable',
        exitPlan: null
      },
      indicators: {},
      reasons: ['Pas assez de donnees pour un signal fiable']
    };
  }

  const closes = candles.map(c => c.close);
  const current = candles[candles.length - 1];
  const previous = candles[candles.length - 2];
  const currentPrice = current.close;

  const ema9Array = calculateEMA(closes, 9);
  const ema21Array = calculateEMA(closes, 21);
  const ema50Array = calculateEMA(closes, 50);

  const ema9 = ema9Array[ema9Array.length - 1];
  const ema21 = ema21Array[ema21Array.length - 1];
  const ema50 = ema50Array[ema50Array.length - 1];

  const rsi7 = calculateRSI(closes, 7);
  const rsi14 = calculateRSI(closes, 14);
  const atr = calculateATR(candles, 14);
  const vwap = calculateVWAP(candles, 30);
  const volumeRatio = calculateVolumeRatio(candles, 20);
  const momentum5 = calculateMomentum(closes, 5);
  const { support, resistance } = calculateSupportResistance(candles, 30);

  const atrPercent = atr > 0 ? (atr / currentPrice) * 100 : 0;
  const candleBody = Math.abs(current.close - current.open);
  const candleRange = Math.max(current.high - current.low, 0.00000001);
  const bodyRatio = candleBody / candleRange;

  let score = 0;
  const reasons = [];

  const bullishTrend = ema9 > ema21 && ema21 > ema50 && currentPrice > ema9;
  const bearishTrend = ema9 < ema21 && ema21 < ema50 && currentPrice < ema9;

  if (bullishTrend) {
    score += 26;
    reasons.push('Tendance scalp haussiere EMA 9/21/50');
  } else if (bearishTrend) {
    score -= 26;
    reasons.push('Tendance scalp baissiere EMA 9/21/50');
  }

  if (currentPrice > vwap) {
    score += 10;
    reasons.push('Prix au-dessus du VWAP');
  } else {
    score -= 10;
    reasons.push('Prix sous le VWAP');
  }

  if (rsi7 > 52 && rsi7 < 72 && rsi14 > 50) {
    score += 16;
    reasons.push('RSI confirme le momentum acheteur');
  } else if (rsi7 < 48 && rsi7 > 28 && rsi14 < 50) {
    score -= 16;
    reasons.push('RSI confirme le momentum vendeur');
  }

  if (rsi7 >= 78) {
    score -= 18;
    reasons.push('RSI trop haut: risque de pullback');
  } else if (rsi7 <= 22) {
    score += 18;
    reasons.push('RSI tres bas: rebond possible');
  }

  if (momentum5 > 0.15) {
    score += 10;
    reasons.push('Momentum court terme positif');
  } else if (momentum5 < -0.15) {
    score -= 10;
    reasons.push('Momentum court terme negatif');
  }

  if (volumeRatio >= 1.25) {
    score += score >= 0 ? 10 : -10;
    reasons.push('Volume superieur a la moyenne');
  } else if (volumeRatio < 0.75) {
    score *= 0.75;
    reasons.push('Volume faible: signal reduit');
  }

  if (current.close > previous.high && bodyRatio > 0.45) {
    score += 12;
    reasons.push('Cassure haussiere de la bougie precedente');
  } else if (current.close < previous.low && bodyRatio > 0.45) {
    score -= 12;
    reasons.push('Cassure baissiere de la bougie precedente');
  }

  if (atrPercent < 0.08) {
    score *= 0.65;
    reasons.push('Volatilite trop faible pour scalping');
  } else if (atrPercent > 3.5) {
    score *= 0.7;
    reasons.push('Volatilite excessive: risque eleve');
  }

  const newsScore = normalizeNewsScore(options.news);

  if (newsScore !== 0) {
    score += newsScore;
    reasons.push(newsScore > 0 ? 'News sentiment positif' : 'News sentiment negatif');
  }

  let signal = 'HOLD';

  if (score >= 45) signal = 'BUY';
  else if (score <= -45) signal = 'SELL';

  const confidence = Math.min(95, Math.round(Math.abs(score)));

  let strength = 'FAIBLE';

  if (confidence >= 70) strength = 'FORT';
  else if (confidence >= 45) strength = 'MOYEN';

  const planSide = signal === 'SELL' || (signal === 'HOLD' && score < 0) ? 'SELL' : 'BUY';
  const entry = currentPrice;

  let entryZone;
  let stopLoss;
  let takeProfit1;
  let takeProfit2;
  let invalidation;
  let exitPlan;

  if (planSide === 'BUY') {
    const entryLow = currentPrice - atr * 0.15;
    const entryHigh = currentPrice + atr * 0.10;

    entryZone = `${formatPrice(entryLow)} - ${formatPrice(entryHigh)}`;
    stopLoss = Math.min(support, currentPrice - atr * 1.35);
    takeProfit1 = entry * (1 + tp1Percent / 100);
    takeProfit2 = entry * (1 + tp2Percent / 100);

    invalidation = `Plan LONG invalide si le prix casse sous ${formatPrice(stopLoss)}`;
    exitPlan = `Entree LONG autour de ${formatPrice(entry)}. TP1 a ${formatPrice(takeProfit1)} (+1.8%), TP2 a ${formatPrice(takeProfit2)} (+3%). Stop loss sous ${formatPrice(stopLoss)}.`;
  } else {
    const entryLow = currentPrice - atr * 0.10;
    const entryHigh = currentPrice + atr * 0.15;

    entryZone = `${formatPrice(entryLow)} - ${formatPrice(entryHigh)}`;
    stopLoss = Math.max(resistance, currentPrice + atr * 1.35);
    takeProfit1 = entry * (1 - tp1Percent / 100);
    takeProfit2 = entry * (1 - tp2Percent / 100);

    invalidation = `Plan SHORT invalide si le prix casse au-dessus de ${formatPrice(stopLoss)}`;
    exitPlan = `Entree SHORT autour de ${formatPrice(entry)}. TP1 a ${formatPrice(takeProfit1)} (-1.8%), TP2 a ${formatPrice(takeProfit2)} (-3%). Stop loss au-dessus de ${formatPrice(stopLoss)}.`;
  }

  if (signal === 'HOLD') {
    reasons.push('Signal faible: plan donne a titre indicatif, attendre confirmation avant entree');
  }

  const formattedTradePlan = {
    action: planSide,
    entry: formatPrice(entry),
    entryZone,
    stopLoss: formatPrice(stopLoss),
    takeProfit1: formatPrice(takeProfit1),
    takeProfit2: formatPrice(takeProfit2),
    tp1Percent,
    tp2Percent,
    support: formatPrice(support),
    resistance: formatPrice(resistance),
    invalidation,
    exitPlan
  };

  return {
    signal,
    strength,
    confidence,
    score: round(score, 1),
    entry: formattedTradePlan.entry,
    entryZone: formattedTradePlan.entryZone,
    stopLoss: formattedTradePlan.stopLoss,
    takeProfit1: formattedTradePlan.takeProfit1,
    takeProfit2: formattedTradePlan.takeProfit2,
    tp1Percent,
    tp2Percent,
    support: formattedTradePlan.support,
    resistance: formattedTradePlan.resistance,
    invalidation,
    exitPlan,
    tradePlan: formattedTradePlan,
    indicators: {
      rsi7: round(rsi7, 2),
      rsi14: round(rsi14, 2),
      ema9: formatPrice(ema9),
      ema21: formatPrice(ema21),
      ema50: formatPrice(ema50),
      vwap: formatPrice(vwap),
      atr: formatPrice(atr),
      atrPercent: `${round(atrPercent, 3)}%`,
      volumeRatio: round(volumeRatio, 2),
      momentum5: `${round(momentum5, 3)}%`
    },
    reasons
  };
}

function yahooCandlesFromResult(result) {
  const quote = result?.indicators?.quote?.[0];
  const timestamps = result?.timestamp || [];

  if (!quote) return [];

  return timestamps.map((timestamp, index) => ({
    time: timestamp * 1000,
    open: quote.open?.[index],
    high: quote.high?.[index],
    low: quote.low?.[index],
    close: quote.close?.[index],
    volume: quote.volume?.[index] || 0
  })).filter(c =>
    c.open > 0 &&
    c.high > 0 &&
    c.low > 0 &&
    c.close > 0
  );
}

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Trading backend is running',
    endpoints: {
      health: '/health',
      market: '/market?symbol=BTC&type=crypto&interval=15m'
    }
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/market', async (req, res) => {
  try {
let tdSymbol = symbol;

const tdResponse = await axios.get(
  'https://api.twelvedata.com/time_series',
  {
    params: {
      symbol: tdSymbol,
      interval: tdIntervalMap[interval] || '15min',
      outputsize: 300,
      apikey: TWELVE_API_KEY
    },
    timeout: 5000
  }
);
    type = String(type).toLowerCase().trim();

    if (!INTERVAL_MAP[interval]) {
      interval = '15m';
    }

    const timeConfig = INTERVAL_MAP[interval];

    const cacheKey = `${type}-${symbol}-${interval}-${String(news).slice(0, 80)}`;

    if (CACHE.has(cacheKey)) {
      const cached = CACHE.get(cacheKey);

      if (Date.now() - cached.timestamp < timeConfig.cache) {
        return res.json(cached.data);
      }
    }

    let candles = [];
    let source = '';

    // =========================
    // CRYPTO → BINANCE PRIORITE
    // =========================

    if (type === 'crypto') {

      let cryptoSymbol = symbol
        .replace('/', '')
        .replace('-', '')
        .replace('USDT', '')
        .replace('USD', '');

      cryptoSymbol = `${cryptoSymbol}USDT`;

      try {

        // ===== PRIX BINANCE TEMPS REEL =====

        const response = await axios.get(
          'https://api.binance.com/api/v3/klines',
          {
            params: {
              symbol: cryptoSymbol,
              interval: timeConfig.binance,
              limit: 300
            },
            timeout: 5000
          }
        );

        candles = response.data.map(c => ({
          time: Number(c[0]),
          open: Number(c[1]),
          high: Number(c[2]),
          low: Number(c[3]),
          close: Number(c[4]),
          volume: Number(c[5])
        })).filter(c =>
          c.open > 0 &&
          c.high > 0 &&
          c.low > 0 &&
          c.close > 0
        );

        source = 'Binance';

      } catch (binanceError) {

        console.log(`[CRYPTO] Binance indisponible pour ${cryptoSymbol}`);

        // ===== FALLBACK MEXC =====

        try {

          const response = await axios.get(
            'https://api.mexc.com/api/v3/klines',
            {
              params: {
                symbol: cryptoSymbol,
                interval: timeConfig.binance,
                limit: 300
              },
              timeout: 5000
            }
          );

          candles = response.data.map(c => ({
            time: Number(c[0]),
            open: Number(c[1]),
            high: Number(c[2]),
            low: Number(c[3]),
            close: Number(c[4]),
            volume: Number(c[5])
          })).filter(c =>
            c.open > 0 &&
            c.high > 0 &&
            c.low > 0 &&
            c.close > 0
          );

          source = 'MEXC';

        } catch (mexcError) {

          console.log(`[CRYPTO] MEXC indisponible pour ${cryptoSymbol}`);

          // ===== FALLBACK YAHOO =====

          const yahooSym = cryptoSymbol.replace('USDT', '-USD');

          const response = await axios.get(
            `https://query2.finance.yahoo.com/v8/finance/chart/${yahooSym}`,
            {
              params: {
                interval: timeConfig.yahooInt,
                range: timeConfig.yahooRange
              },
              headers: YAHOO_HEADERS,
              timeout: 5000
            }
          );

          const result = response.data?.chart?.result?.[0];

          candles = yahooCandlesFromResult(result);

          source = 'Yahoo Finance';
        }
      }

      // =========================
      // FOREX / STOCKS / COMMODITIES
      // =========================

     } else {

  try {

    const tdIntervalMap = {
      '1m': '1min',
      '5m': '5min',
      '15m': '15min',
      '30m': '30min',
      '1h': '1h',
      '4h': '4h',
      '1d': '1day',
      '1w': '1week'
    };

    let tdSymbol = symbol;

    // ===== CONVERSION INDICES =====

    const tdResponse = await axios.get(
      'https://api.twelvedata.com/time_series',
      {
        params: {
          symbol: tdSymbol,
          interval: tdIntervalMap[interval] || '15min',
          outputsize: 300,
          apikey: TWELVE_API_KEY
        },
        timeout: 5000
      }
    );

    if (
      tdResponse.data &&
      tdResponse.data.values &&
      Array.isArray(tdResponse.data.values)
    ) {

      candles = tdResponse.data.values
        .map(c => ({
          time: new Date(c.datetime).getTime(),
          open: Number(c.open),
          high: Number(c.high),
          low: Number(c.low),
          close: Number(c.close),
          volume: Number(c.volume || 0)
        }))
        .reverse()
        .filter(c =>
          c.open > 0 &&
          c.high > 0 &&
          c.low > 0 &&
          c.close > 0
        );

      source = 'TwelveData';

    } else {
      throw new Error('TwelveData invalid response');
    }

  } catch (tdError) {

    console.log(`[TwelveData] Echec pour ${symbol}, fallback Yahoo`);

    const response = await axios.get(
      `https://query2.finance.yahoo.com/v8/finance/chart/${symbol}`,
      {
        params: {
          interval: timeConfig.yahooInt,
          range: timeConfig.yahooRange
        },
        headers: YAHOO_HEADERS,
        timeout: 5000
      }
    );

    const result = response.data?.chart?.result?.[0];

    candles = yahooCandlesFromResult(result);

    source = 'Yahoo Finance';
  }
}
    // =========================
    // VALIDATION
    // =========================

    if (!candles || candles.length < 60) {
      return res.status(404).json({
        error: 'Donnees insuffisantes ou timeframe non supporte pour cet actif.'
      });
    }

   let currentPrice = Number(candles[candles.length - 1].close);

// ===== PRIX LIVE BINANCE =====

if (type === 'crypto') {
  try {

    let cryptoSymbol = symbol
      .replace('/', '')
      .replace('-', '')
      .replace('USDT', '')
      .replace('USD', '');

    cryptoSymbol = `${cryptoSymbol}USDT`;

    const tickerResponse = await axios.get(
      'https://api.binance.com/api/v3/ticker/price',
      {
        params: {
          symbol: cryptoSymbol
        },
        timeout: 3000
      }
    );

    if (Number.isFinite(livePrice) && livePrice > 0) {
      currentPrice = livePrice;

      // IMPORTANT :
      // on synchronise aussi la derniere bougie
      candles[candles.length - 1].close = livePrice;
        console.log("PRIX LIVE BINANCE:", livePrice);
    }

  } catch (tickerError) {
    console.log('Impossible de recuperer le prix live Binance');
  }
}

    const analysis = generateScalpingSignal(candles, { news });

    // =========================
    // REPONSE
    // =========================

    const data = {
      symbol,
      type,
      interval,

      // IMPORTANT :
      // on garde le vrai prix brut
      marketPrice: currentPrice,

      formattedPrice: formatPrice(currentPrice),

      source,

      ...analysis,

      timestamp: new Date().toISOString()
    };

    CACHE.set(cacheKey, {
      data,
      timestamp: Date.now()
    });

    return res.json(data);

  } catch (error) {

    console.error(
      `Erreur /market (${req.query.symbol} - ${req.query.interval}):`,
      error.message
    );

    return res.status(500).json({
      error: 'Impossible de charger les donnees',
      message: 'Verifiez le symbole ou reessayez plus tard.'
    });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Serveur lance sur le port ${PORT}`);
});

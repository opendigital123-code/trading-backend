const express = require('express');
const MetaApi = require('metaapi.cloud-sdk').default;
const { RSI } = require('technicalindicators');

const app = express();
const PORT = process.env.PORT || 3000;

const META_API_TOKEN = process.env.META_API_TOKEN || 'NON_CONFIGURE';
const ACCOUNT_ID = process.env.META_API_ACCOUNT_ID || 'NON_CONFIGURE';

const SYMBOLS = [
    'EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD',
    'BTCUSD', 'ETHUSD', 'BNBUSD', 'SOLUSD', 'XRPUSD'
];

const RSI_PERIOD = 14;
const SURVENDU = 30;
const SURACHETE = 70;

let resultats = [];

// ================= API =================
app.get('/', (req, res) => {
    res.send(`
        <h1>📊 Bot RSI Actif</h1>
        <p>Voir les signaux : <a href="/api/signals">/api/signals</a></p>
    `);
});

app.get('/api/signals', (req, res) => {
    res.json(resultats);
});

app.listen(PORT, () => console.log(`🚀 Serveur lancé sur ${PORT}`));

// ================= ANALYSE =================
async function analyserMarche() {
    console.log('\n⏳ Analyse...');

    resultats = [];

    if (META_API_TOKEN === 'NON_CONFIGURE') {
        console.log('⚠️ MODE SIMULATION');

        for (const symbol of SYMBOLS) {
            let prix = Array.from({ length: 15 }, () => Math.random() * 100 + 50);
            traiterRSI(symbol, prix);
        }
        return;
    }

    try {
        const api = new MetaApi(META_API_TOKEN);
        const account = await api.metatraderAccountApi.getAccount(ACCOUNT_ID);

        if (account.state !== 'DEPLOYED') await account.deploy();
        await account.waitConnected();

        const connection = account.getRPCConnection();
        await connection.connect();
        await connection.waitSynchronized();

        for (const symbol of SYMBOLS) {
            const history = await connection.getHistoryStorage()
                .getHistoricalCandles(symbol, '1h', new Date(Date.now() - 86400000), new Date());

            if (history && history.length >= RSI_PERIOD) {
                const prix = history.map(c => c.close);
                traiterRSI(symbol, prix);
            }
        }
    } catch (err) {
        console.error("❌ Erreur:", err.message);
    }
}

// ================= RSI =================
function traiterRSI(symbol, prix) {
    const rsiValues = RSI.calculate({
        values: prix,
        period: RSI_PERIOD
    });

    const rsi = rsiValues[rsiValues.length - 1];

    let signal = "HOLD";
    if (rsi <= SURVENDU) signal = "BUY";
    else if (rsi >= SURACHETE) signal = "SELL";

    resultats.push({
        symbol,
        rsi: Number(rsi.toFixed(2)),
        signal
    });
}

// ================= LOOP =================
setInterval(async () => {
    try {
        await analyserMarche();
    } catch (e) {
        console.error("Erreur globale:", e);
    }
}, 60000);

analyserMarche();

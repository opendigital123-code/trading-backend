const express = require('express');
const MetaApi = require('metaapi.cloud-sdk').default;
const { RSI } = require('technicalindicators');

const app = express();
const PORT = process.env.PORT || 3000;
const META_API_TOKEN = process.env.META_API_TOKEN || 'NON_CONFIGURE';
const ACCOUNT_ID = process.env.META_API_ACCOUNT_ID || 'NON_CONFIGURE';

// ====================================================================
// LISTE DES ACTIFS A SURVEILLER (5 FOREX + 5 CRYPTO)
// ====================================================================
const SYMBOLS = [
    // Forex
    'EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD',
    // Crypto
    'BTCUSD', 'ETHUSD', 'BNBUSD', 'SOLUSD', 'XRPUSD'
];

// Configuration du RSI
const RSI_PERIOD = 14;
const SURVENDU = 30;  // En dessous de 30 = ACHAT
const SURACHETE = 70; // Au dessus de 70 = VENTE

// Page web minimaliste pour garder le bot en vie sur Render
app.get('/', (req, res) => res.send('🟢 Bot RSI Autonome Actif ! Surveillance de 10 paires.'));
app.listen(PORT, () => console.log(`🚀 Serveur web démarré sur le port ${PORT}`));

// ====================================================================
// FONCTION PRINCIPALE : L'ANALYSE DU MARCHE
// ====================================================================
async function analyserMarche() {
    console.log('\n⏳ --- DÉBUT DE L\'ANALYSE DES 10 PAIRES ---');

    // MODE SIMULATION : Si clés non configurées
    if (META_API_TOKEN === 'NON_CONFIGURE') {
        console.log('⚠️ MODE SIMULATION : Génération de faux prix pour test...');
        
        for (const symbol of SYMBOLS) {
            // Génère 15 faux prix entre 50 et 150 pour que le RSI calcule quelque chose
            let fauxPrixCloture = Array.from({length: 15}, () => Math.random() * 100 + 50);
            calculerEtAfficherSignal(symbol, fauxPrixCloture);
        }
        return; 
    }

    // MODE REEL/DEMO (FP MARKETS via MetaApi)
    try {
        const api = new MetaApi(META_API_TOKEN);
        const account = await api.metatraderAccountApi.getAccount(ACCOUNT_ID);
        
        if (account.state !== 'DEPLOYED') await account.deploy();
        await account.waitConnected();
        
        const connection = account.getRPCConnection();
        await connection.connect();
        await connection.waitSynchronized();

        for (const symbol of SYMBOLS) {
            console.log(`📊 Lecture de ${symbol}...`);
            // Historique des 15 dernières heures
            const history = await connection.getHistoryStorage().getHistoricalCandles(symbol, '1h', new Date(Date.now() - 24*60*60*1000), new Date());
            
            if (history && history.length >= RSI_PERIOD) {
                const prixCloture = history.map(candle => candle.close);
                calculerEtAfficherSignal(symbol, prixCloture);
            } else {
                console.log(`❌ Pas assez de données MT5 pour ${symbol}`);
            }
        }
    } catch (error) {
        console.error('❌ ERREUR MT5 :', error.message);
    }
}

// ====================================================================
// CALCUL DU RSI ET AFFICHAGE
// ====================================================================
function calculerEtAfficherSignal(symbol, prixCloture) {
    const rsiResultat = RSI.calculate({
        values: prixCloture,
        period: RSI_PERIOD
    });

    const rsiActuel = rsiResultat[rsiResultat.length - 1]; 
    const rsiArrondi = rsiActuel.toFixed(2);
    
    // Détection automatique Crypto / Forex pour un bel affichage
    const cryptosTokens = ['BTC', 'ETH', 'BNB', 'SOL', 'XRP'];
    const estCrypto = cryptosTokens.some(crypto => symbol.includes(crypto));
    const typeMarche = estCrypto ? 'CRYPTO' : 'FOREX';

    console.log(`\n---------------------------------`);
    console.log(`🪙 Actif  : ${symbol} (${typeMarche})`);
    console.log(`📈 RSI    : ${rsiArrondi}`);

    if (rsiActuel <= SURVENDU) {
        console.log('🟢 SIGNAL : ACHAT (BUY) 🟢');
    } else if (rsiActuel >= SURACHETE) {
        console.log('🔴 SIGNAL : VENTE (SELL) 🔴');
    } else {
        console.log('🟡 SIGNAL : HOLD (Zone Neutre)');
    }
}

// ====================================================================
// LE MOTEUR
// ====================================================================
console.log("👀 Démarrage du moteur de trading...");

// 1er lancement immédiat
analyserMarche();

// Boucle infinie : Relance l'analyse toutes les minutes (60000 ms)
setInterval(analyserMarche, 60000);

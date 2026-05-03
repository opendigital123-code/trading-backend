import { MaterialIcons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type DimensionValue,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

type RsiResponse = {
  type?: MarketType;
  symbol?: string;
  marketPrice?: number | string;
  rsi: number | string;
};

type MarketSnapshot = {
  type: MarketType;
  symbol: string;
  marketPrice: number;
  rsi: number;
  updatedAt: Date;
};

type MarketType = 'crypto' | 'forex';
type AlertSignal = 'BUY' | 'SELL' | 'HOLD';
type MarketOption = {
  label: string;
  symbol: string;
};

const BACKEND_PORT = 3000;
const MARKET_TYPES: MarketType[] = ['crypto', 'forex'];
const MARKET_OPTIONS: Record<MarketType, MarketOption[]> = {
  crypto: [
    { label: 'BTC/USDT', symbol: 'BTCUSDT' },
    { label: 'ETH/USDT', symbol: 'ETHUSDT' },
    { label: 'BNB/USDT', symbol: 'BNBUSDT' },
    { label: 'SOL/USDT', symbol: 'SOLUSDT' },
  ],
  forex: [
    { label: 'EUR/USD', symbol: 'EURUSD=X' },
    { label: 'GBP/USD', symbol: 'GBPUSD=X' },
    { label: 'USD/JPY', symbol: 'USDJPY=X' },
    { label: 'AUD/USD', symbol: 'AUDUSD=X' },
  ],
};

function getApiUrl() {
  const configuredUrl = process.env.EXPO_PUBLIC_API_URL?.trim();

  if (configuredUrl) {
    return configuredUrl.replace(/\/$/, '');
  }

  const hostUri = Constants.expoConfig?.hostUri ?? Constants.platform?.hostUri;
  const host = hostUri?.split(':')[0];

  if (host && host !== 'localhost' && host !== '127.0.0.1') {
    return `http://${host}:${BACKEND_PORT}`;
  }

  return `http://10.194.124.220:${BACKEND_PORT}`;
}

const API_URL = getApiUrl();

function formatTime(date: Date) {
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');

  return `${hours}:${minutes}:${seconds}`;
}

function formatPrice(snapshot: MarketSnapshot) {
  if (snapshot.type === 'forex') {
    const decimals = snapshot.symbol === 'USD/JPY' ? 3 : 5;

    return snapshot.marketPrice.toLocaleString('en-US', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
  }

  return `$${snapshot.marketPrice.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export default function HomeScreen() {
  const [marketType, setMarketType] = useState<MarketType>('crypto');
  const [selectedSymbol, setSelectedSymbol] = useState(MARKET_OPTIONS.crypto[0].symbol);
  const [snapshot, setSnapshot] = useState<MarketSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;
    setSnapshot(null);
    setError(null);

    const fetchRSI = async () => {
      try {
        const params = new URLSearchParams({
          type: marketType,
          symbol: selectedSymbol,
        });
        const response = await fetch(`${API_URL}/market?${params.toString()}`);

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const data = (await response.json()) as RsiResponse;
        const nextRsi = Number(data.rsi);
        const nextMarketPrice = Number(data.marketPrice);

        if (!Number.isFinite(nextRsi)) {
          throw new Error('Invalid RSI value');
        }

        if (!Number.isFinite(nextMarketPrice)) {
          throw new Error('Invalid market price');
        }

        if (isMounted) {
          setSnapshot({
            type: data.type ?? marketType,
            symbol: data.symbol ?? selectedSymbol,
            marketPrice: nextMarketPrice,
            rsi: nextRsi,
            updatedAt: new Date(),
          });
          setError(null);
        }
      } catch (err) {
        if (isMounted) {
          setError(err instanceof Error ? err.message : 'Unable to load RSI');
        }
      }
    };

    void fetchRSI();

    const interval = setInterval(fetchRSI, 5000);

    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [marketType, selectedSymbol]);

  const signal = useMemo<AlertSignal | null>(() => {
    if (!snapshot) {
      return null;
    }

    if (snapshot.rsi > 70) {
      return 'SELL';
    }

    if (snapshot.rsi < 30) {
      return 'BUY';
    }

    return 'HOLD';
  }, [snapshot]);

  const rsiColor = useMemo(() => {
    if (!snapshot) {
      return styles.neutralText;
    }

    if (snapshot.rsi > 70) {
      return styles.overbought;
    }

    if (snapshot.rsi < 30) {
      return styles.oversold;
    }

    return styles.neutralText;
  }, [snapshot]);

  const signalStyle = useMemo(() => {
    if (signal === 'BUY') {
      return styles.buySignal;
    }

    if (signal === 'SELL') {
      return styles.sellSignal;
    }

    return styles.holdSignal;
  }, [signal]);

  const signalCopy = useMemo(() => {
    if (signal === 'BUY') {
      return 'Oversold zone';
    }

    if (signal === 'SELL') {
      return 'Overbought zone';
    }

    return 'Neutral momentum';
  }, [signal]);

  const rsiNeedlePosition = (snapshot
    ? `${Math.min(Math.max(snapshot.rsi, 0), 100)}%`
    : '0%') as DimensionValue;

  const handleMarketTypePress = (nextMarketType: MarketType) => {
    setMarketType(nextMarketType);
    setSelectedSymbol(MARKET_OPTIONS[nextMarketType][0].symbol);
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.container}>
        <View style={styles.topBar}>
          <View>
            <Text style={styles.screenTitle}>Market Watch</Text>
            <Text style={styles.screenSubtitle}>Crypto and forex momentum</Text>
          </View>
          <View style={styles.livePill}>
            <View style={styles.liveDot} />
            <Text style={styles.liveText}>LIVE</Text>
          </View>
        </View>

        <View style={styles.controls}>
          <View style={styles.segmentedControl}>
            {MARKET_TYPES.map((type) => {
              const isActive = type === marketType;

              return (
                <Pressable
                  key={type}
                  onPress={() => handleMarketTypePress(type)}
                  style={[styles.segmentButton, isActive && styles.segmentButtonActive]}>
                  <Text style={[styles.segmentText, isActive && styles.segmentTextActive]}>
                    {type === 'crypto' ? 'Crypto' : 'Forex'}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.assetRail}>
            {MARKET_OPTIONS[marketType].map((option) => {
              const isActive = option.symbol === selectedSymbol;

              return (
                <Pressable
                  key={option.symbol}
                  onPress={() => setSelectedSymbol(option.symbol)}
                  style={[styles.assetChip, isActive && styles.assetChipActive]}>
                  <Text style={[styles.assetChipText, isActive && styles.assetChipTextActive]}>
                    {option.label}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>

        {snapshot === null ? (
          <View style={styles.loadingPanel}>
            <ActivityIndicator size="large" color="#1f7a5c" />
            <Text style={styles.loadingText}>Chargement du marche...</Text>
          </View>
        ) : (
          <View style={styles.dashboard}>
            <View style={styles.pricePanel}>
              <View style={styles.panelHeader}>
                <View style={styles.iconBox}>
                  <MaterialIcons name="show-chart" size={22} color="#1f7a5c" />
                </View>
                <View>
                  <Text style={styles.panelLabel}>Market price</Text>
                  <Text style={styles.symbol}>{snapshot.symbol}</Text>
                </View>
              </View>

              <Text adjustsFontSizeToFit numberOfLines={1} style={styles.priceValue}>
                {formatPrice(snapshot)}
              </Text>

              <View style={styles.updateRow}>
                <MaterialIcons name="schedule" size={16} color="#64748b" />
                <Text style={styles.updatedText}>Updated {formatTime(snapshot.updatedAt)}</Text>
              </View>
            </View>

            <View style={[styles.alertPanel, signalStyle]}>
              <View>
                <Text style={styles.alertLabel}>Alert</Text>
                <Text style={styles.alertTitle}>{signal}</Text>
              </View>
              <Text style={styles.alertCopy}>{signalCopy}</Text>
            </View>

            <View style={styles.rsiPanel}>
              <View style={styles.metricHeader}>
                <View style={styles.iconBox}>
                  <MaterialIcons name="speed" size={22} color="#334155" />
                </View>
                <View>
                  <Text style={styles.panelLabel}>RSI</Text>
                  <Text style={[styles.rsiValue, rsiColor]}>{snapshot.rsi.toFixed(2)}</Text>
                </View>
              </View>

              <View style={styles.gauge}>
                <View style={styles.gaugeTrack}>
                  <View style={styles.buyBand} />
                  <View style={styles.holdBand} />
                  <View style={styles.sellBand} />
                </View>
                <View style={[styles.gaugeNeedle, { left: rsiNeedlePosition }]} />
              </View>

              <View style={styles.gaugeLabels}>
                <Text style={styles.gaugeLabel}>BUY</Text>
                <Text style={styles.gaugeLabel}>HOLD</Text>
                <Text style={styles.gaugeLabel}>SELL</Text>
              </View>
            </View>

          </View>
        )}

        {error ? <Text style={styles.error}>Backend: {error}</Text> : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#f5f7fb',
  },
  container: {
    flexGrow: 1,
    gap: 24,
    padding: 20,
    paddingBottom: 28,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 16,
  },
  screenTitle: {
    color: '#111827',
    fontSize: 30,
    fontWeight: '800',
  },
  screenSubtitle: {
    marginTop: 4,
    color: '#64748b',
    fontSize: 15,
    fontWeight: '600',
  },
  livePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#b7e4d2',
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#e8f8f0',
  },
  liveDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#16a34a',
  },
  liveText: {
    color: '#166534',
    fontSize: 12,
    fontWeight: '800',
  },
  controls: {
    gap: 12,
  },
  segmentedControl: {
    flexDirection: 'row',
    gap: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#dde5ee',
    padding: 4,
    backgroundColor: '#ffffff',
  },
  segmentButton: {
    flex: 1,
    alignItems: 'center',
    borderRadius: 6,
    paddingVertical: 11,
  },
  segmentButtonActive: {
    backgroundColor: '#111827',
  },
  segmentText: {
    color: '#64748b',
    fontSize: 15,
    fontWeight: '800',
  },
  segmentTextActive: {
    color: '#ffffff',
  },
  assetRail: {
    gap: 8,
    paddingRight: 20,
  },
  assetChip: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#d8e0eb',
    paddingHorizontal: 14,
    paddingVertical: 9,
    backgroundColor: '#ffffff',
  },
  assetChipActive: {
    borderColor: '#1f7a5c',
    backgroundColor: '#e8f8f0',
  },
  assetChipText: {
    color: '#475569',
    fontSize: 14,
    fontWeight: '800',
  },
  assetChipTextActive: {
    color: '#166534',
  },
  loadingPanel: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    minHeight: 360,
  },
  loadingText: {
    color: '#475569',
    fontSize: 15,
  },
  dashboard: {
    gap: 14,
  },
  pricePanel: {
    gap: 20,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#dde5ee',
    padding: 20,
    backgroundColor: '#ffffff',
  },
  panelHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  iconBox: {
    width: 42,
    height: 42,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    backgroundColor: '#edf4f1',
  },
  panelLabel: {
    color: '#64748b',
    fontSize: 14,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  symbol: {
    marginTop: 2,
    color: '#111827',
    fontSize: 18,
    fontWeight: '800',
  },
  priceValue: {
    color: '#0f172a',
    fontSize: 44,
    fontWeight: '900',
  },
  updateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  updatedText: {
    color: '#64748b',
    fontSize: 14,
    fontWeight: '600',
  },
  alertPanel: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 14,
    borderRadius: 8,
    padding: 20,
  },
  alertLabel: {
    color: 'rgba(255, 255, 255, 0.82)',
    fontSize: 13,
    fontWeight: '800',
    textTransform: 'uppercase',
  },
  alertTitle: {
    color: '#ffffff',
    fontSize: 34,
    fontWeight: '900',
  },
  alertCopy: {
    flexShrink: 1,
    color: 'rgba(255, 255, 255, 0.9)',
    fontSize: 16,
    fontWeight: '700',
    textAlign: 'right',
  },
  rsiPanel: {
    gap: 18,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#dde5ee',
    padding: 20,
    backgroundColor: '#ffffff',
  },
  metricHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  rsiValue: {
    marginTop: 2,
    fontSize: 34,
    fontWeight: '900',
  },
  gauge: {
    position: 'relative',
    height: 22,
    justifyContent: 'center',
  },
  gaugeTrack: {
    flexDirection: 'row',
    height: 10,
    overflow: 'hidden',
    borderRadius: 999,
    backgroundColor: '#e5e7eb',
  },
  buyBand: {
    flex: 3,
    backgroundColor: '#22c55e',
  },
  holdBand: {
    flex: 4,
    backgroundColor: '#facc15',
  },
  sellBand: {
    flex: 3,
    backgroundColor: '#ef4444',
  },
  gaugeNeedle: {
    position: 'absolute',
    top: 0,
    width: 4,
    height: 22,
    marginLeft: -2,
    borderRadius: 2,
    backgroundColor: '#111827',
  },
  gaugeLabels: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  gaugeLabel: {
    color: '#64748b',
    fontSize: 12,
    fontWeight: '800',
  },
  neutralText: {
    color: '#0f172a',
  },
  overbought: {
    color: '#dc2626',
  },
  oversold: {
    color: '#16a34a',
  },
  buySignal: {
    color: '#ffffff',
    backgroundColor: '#15965a',
  },
  sellSignal: {
    color: '#ffffff',
    backgroundColor: '#d93636',
  },
  holdSignal: {
    color: '#ffffff',
    backgroundColor: '#b7791f',
  },
  error: {
    color: '#b91c1c',
    fontSize: 14,
    textAlign: 'center',
  },
});

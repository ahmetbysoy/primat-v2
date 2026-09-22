# PRIMAT V2 — Para Mıknatısı

> Gerçek piyasa, gerçek para, gerçek av. Simülasyon yok, mock yok.

Profesyonel kripto terminal: **Event Bus → Multi-Exchange WS → Whale Tracker → CVD → Volume Profile POC → Multi-TF Confluence → Liquidation Hunter → Arbitrage Scanner → Smart Trading Plan.**

## Özellikler

- **Core Engine:** Pub/Sub EventBus, Binance/Bybit/OKX WebSocket, exponential backoff reconnect, rate limiter, buffer queue
- **Whale Tracker:** zScore >3.5, $100K+ whale, $10K shark, iceberg absorption, order flow imbalance
- **CVD Engine:** Tick-by-tick Cumulative Volume Delta + divergence (price vs CVD)
- **Volume Profile:** Otomatik binSize, POC, VAH/VAL (%70 value area), destek/direnç
- **Confluence:** 1m/5m/15m/1h/4h EMA9/21/50, RSI14, MACD, volume — ağırlıklı skor 0-100
- **Trading Plan:** ATR 1.5× SL, 1:2 / 1:3 / 1:5 TP, risk bazlı pozisyon + volatilite kaldıracı
- **Liquidation Hunter:** Orderbook yakın hacim kümeleri, cascade riski, heatmap
- **Arbitrage:** Cross-exchange (Binance vs Bybit vs OKX) + triangular + funding rate
- **UI:** Dopamin tetikleyici — canlı profit counter, whale sireni, confluence metre, FOMO

## Hızlı Başlat

```bash
# 1. Projeyi aç (sadece statik - build yok)
# index.html'i direkt aç veya bir server ile:
npx serve .

# 2. Vercel deploy
vercel --prod
# Vercel env ekle (dashboard'dan)
vercel env add BINANCE_API_KEY
```

## Mimari

```
js/core/EventBus.js          -> Pub/Sub + queue + middleware
js/core/ExchangeWS.js         -> Binance/Bybit/OKX WS + rate limiter + heartbeat
js/engines/WhaleTracker.js    -> zScore & hacim kümeleri
js/engines/CVDEngine.js       -> tick CVD + divergence
js/engines/VolumeProfile.js   -> POC/VAH/VAL
js/engines/ConfluenceEngine.js-> MTF EMA/RSI/MACD + skor
js/engines/TradingPlan.js     -> ATR + R:R + kaldıraç
js/engines/LiquidationHunter.js -> heatmap + cascade
js/engines/ArbitrageScanner.js  -> cross + triangular
js/app.js                    -> orchestration + UI
```

## Gerçek Veri

- WebSocket: `wss://stream.binance.com:9443/stream?streams=...` (combined), `wss://stream.bybit.com/v5/public/spot`, `wss://ws.okx.com:8443/ws/v5/public`
- REST: `https://api.binance.com/api/v3/klines` + `ticker/24hr` + `fapi/v1/premiumIndex` (funding)
- Hiçbir yerde `Math.random()` ile fiyat üretilmez. Tüm sinyaller gerçek tick'ten.

## Güvenlik

- API anahtarlarını **frontend'e koyma**. `api/ws-proxy.js` gibi Edge Function'da server-side imzala.
- Repo'yu **private** tut.
- Token leak olursa hemen revoke et: GitHub → Settings → Developer settings → Personal access tokens → Revoke. Vercel → Tokens → Revoke & rotate.

## Risk Uyarısı

Yatırım tavsiyesi değildir. Kaldıraçlı işlem tüm sermayeyi kaybettirebilir. Sinyaller algoritmiktir, garanti değildir.

## Lisans

Private — Tüm hakları saklı.

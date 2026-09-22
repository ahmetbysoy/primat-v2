/**
 * PRIMAT V2 - Multi-Timeframe Confluence Engine
 * EMA, RSI, MACD, Volume - score 0-100
 * Uses real kline data from Binance REST
 */

class ConfluenceEngine {
  constructor(bus = PRIMAT_BUS, opts = {}) {
    this.bus = bus;
    this.opts = { symbol: 'BTCUSDT', intervals: ['1m','5m','15m','1h','4h'], ...opts };
    this.timeframes = {}; // interval -> { rsi, ema, macd, volume, price, ... }
    this.score = 0;
    this.signal = 'NEUTRAL';
    this.weights = { rsi: 0.25, ema: 0.30, macd: 0.25, volume: 0.20 };
    this.klineCache = new Map();
    this.isFetching = false;

    // Poll every 10s for MTF
    this.pollInterval = null;
  }

  start() {
    this.fetchAll();
    this.pollInterval = setInterval(() => this.fetchAll(), 10000);
    // Also update on trade for 1m micro
    this.bus.on('trade', (t) => {
      if (t.symbol === this.opts.symbol) {
        // micro update: adjust score slightly based on momentum
      }
    });
  }

  stop() {
    if (this.pollInterval) clearInterval(this.pollInterval);
  }

  async fetchAll() {
    if (this.isFetching) return;
    this.isFetching = true;
    try {
      const promises = this.opts.intervals.map(iv => this.fetchKlines(this.opts.symbol, iv, 100));
      const results = await Promise.allSettled(promises);
      results.forEach((r, idx) => {
        const iv = this.opts.intervals[idx];
        if (r.status === 'fulfilled' && r.value) {
          this.timeframes[iv] = this.analyze(r.value, iv);
        }
      });
      const confluence = this.calculateConfluence();
      this.bus.emit('confluence:update', confluence);
    } catch (e) {
      console.warn('[Confluence] fetch error', e);
    } finally {
      this.isFetching = false;
    }
  }

  async fetchKlines(symbol, interval, limit = 100) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    // Try direct, fallback to proxy if CORS blocked
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      // data: [ [openTime, open, high, low, close, volume, closeTime, quoteVolume, ...], ... ]
      return data.map(k => ({
        openTime: k[0],
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
        closeTime: k[6],
        quoteVolume: parseFloat(k[7])
      }));
    } catch (e) {
      // CORS fallback via allorigins or binance via proxy is not needed in most browsers for binance (CORS enabled)
      console.warn(`[Confluence] fetch failed ${interval}`, e.message);
      return null;
    }
  }

  // Indicators
  calcEMA(prices, period) {
    const k = 2 / (period + 1);
    let ema = prices[0];
    for (let i = 1; i < prices.length; i++) {
      ema = prices[i] * k + ema * (1 - k);
    }
    return ema;
  }

  calcRSI(closes, period = 14) {
    if (closes.length < period + 1) return 50;
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
      const diff = closes[closes.length - i] - closes[closes.length - i - 1];
      if (diff >= 0) gains += diff;
      else losses -= diff;
    }
    let avgGain = gains / period;
    let avgLoss = losses / period;
    for (let i = closes.length - period - 1; i >= 1; i--) {
      const diff = closes[i+1] - closes[i];
      if (diff >= 0) {
        avgGain = (avgGain * (period - 1) + diff) / period;
        avgLoss = (avgLoss * (period - 1)) / period;
      } else {
        avgGain = (avgGain * (period - 1)) / period;
        avgLoss = (avgLoss * (period - 1) - diff) / period;
      }
    }
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
  }

  calcMACD(closes) {
    if (closes.length < 26) return { macd: 0, signal: 0, histogram: 0 };
    const ema12 = this.calcEMA(closes.slice(-26), 12);
    const ema26 = this.calcEMA(closes.slice(-26), 26);
    const macd = ema12 - ema26;
    // Signal 9 EMA of MACD - approximate using last 9 closes diff
    const macdSeries = [];
    for (let i = closes.length - 35; i < closes.length; i++) {
      if (i < 26) continue;
      const slice = closes.slice(i-26, i);
      macdSeries.push(this.calcEMA(slice.slice(-12), 12) - this.calcEMA(slice, 26));
    }
    const signal = macdSeries.length >= 9 ? this.calcEMA(macdSeries.slice(-9), 9) : macd;
    return { macd, signal, histogram: macd - signal };
  }

  analyze(klines, interval) {
    if (!klines || klines.length < 30) return null;
    const closes = klines.map(k => k.close);
    const volumes = klines.map(k => k.volume);
    const lastClose = closes[closes.length - 1];

    const ema9 = this.calcEMA(closes.slice(-20), 9);
    const ema21 = this.calcEMA(closes.slice(-30), 21);
    const ema50 = this.calcEMA(closes.slice(-60), 50);
    const rsi = this.calcRSI(closes, 14);
    const macd = this.calcMACD(closes);
    const avgVolume = volumes.slice(-20).reduce((a,b)=>a+b,0)/20;
    const lastVolume = volumes[volumes.length - 1];

    let emaSignal = 'neutral';
    if (ema9 > ema21 && ema21 > ema50) emaSignal = 'bullish';
    else if (ema9 < ema21 && ema21 < ema50) emaSignal = 'bearish';
    else if (ema9 > ema21) emaSignal = 'bullish_cross';
    else if (ema9 < ema21) emaSignal = 'bearish_cross';

    return {
      interval,
      price: lastClose,
      ema9, ema21, ema50,
      emaSignal,
      emaCross: emaSignal.includes('bullish') ? 'bullish' : emaSignal.includes('bearish') ? 'bearish' : 'neutral',
      rsi: Number(rsi.toFixed(2)),
      macd: Number(macd.macd.toFixed(2)),
      macdSignal: Number(macd.signal.toFixed(2)),
      macdHistogram: Number(macd.histogram.toFixed(2)),
      volume: lastVolume,
      avgVolume,
      volumeRatio: Number((lastVolume / (avgVolume || 1)).toFixed(2)),
      klines
    };
  }

  calculateConfluence() {
    let score = 0;
    let maxScore = 0;
    const details = {};

    for (const [iv, tf] of Object.entries(this.timeframes)) {
      if (!tf) continue;
      let tfScore = 0;
      // RSI scoring
      if (tf.rsi > 65 && tf.rsi < 85) tfScore += this.weights.rsi * 10;
      else if (tf.rsi > 50 && tf.rsi < 65) tfScore += this.weights.rsi * 5;
      else if (tf.rsi < 25 && tf.rsi > 5) tfScore += this.weights.rsi * 10; // oversold bounce potential for shorts? count neutral
      // For bearish, invert: low RSI gives buy signal, high gives sell - we score absolute momentum
      //EMA
      if (tf.emaCross === 'bullish') tfScore += this.weights.ema * 10;
      else if (tf.emaCross === 'bearish') tfScore += this.weights.ema * 2; // bearish still counts but low
      // MACD
      if (tf.macdHistogram > 0) tfScore += this.weights.macd * 10;
      else if (tf.macdHistogram > -0.5) tfScore += this.weights.macd * 3;
      // Volume
      if (tf.volumeRatio > 1.5) tfScore += this.weights.volume * 10;
      else if (tf.volumeRatio > 1.0) tfScore += this.weights.volume * 5;

      // Weight by timeframe importance: 4h 30%, 1h 25%, 15m 20%, 5m 15%, 1m 10%
      const tfWeights = { '4h': 0.30, '1h': 0.25, '15m': 0.20, '5m': 0.15, '1m': 0.10 };
      const w = tfWeights[iv] || 0.15;
      score += tfScore * w * 10; // scale to 0-100
      maxScore += 10 * w * 10;
      details[iv] = { ...tf, tfScore: Number(tfScore.toFixed(2)) };
    }

    const normalized = maxScore > 0 ? Math.min(100, (score / maxScore) * 100) : 0;

    let signal = 'NEUTRAL';
    let action = 'Bekle';
    if (normalized > 75) { signal = 'STRONG_BUY'; action = 'GÜÇLÜ AL'; }
    else if (normalized > 60) { signal = 'BUY'; action = 'AL'; }
    else if (normalized > 45) { signal = 'NEUTRAL_BULL'; action = 'Hafif Bullish'; }
    else if (normalized < 25) { signal = 'STRONG_SELL'; action = 'GÜÇLÜ SAT'; }
    else if (normalized < 40) { signal = 'SELL'; action = 'SAT'; }

    this.score = Number(normalized.toFixed(1));
    this.signal = signal;

    return {
      score: this.score,
      signal,
      action,
      details,
      timestamp: Date.now(),
      summary: this.generateSummary(details, normalized)
    };
  }

  generateSummary(details, score) {
    const bullishTFs = Object.entries(details).filter(([k,v])=> v.emaCross==='bullish' && v.macdHistogram>0).map(([k])=>k);
    const bearishTFs = Object.entries(details).filter(([k,v])=> v.emaCross==='bearish').map(([k])=>k);
    if (bullishTFs.length >= 3) return `${bullishTFs.join(', ')} bullish alignment — trend continuation yüksek olasılık`;
    if (bearishTFs.length >= 3) return `${bearishTFs.join(', ')} bearish — short tarafı baskın`;
    if (score > 60) return 'Multi-TF momentum pozitif, breakout potansiyeli';
    if (score < 40) return 'Momentum zayıf, range veya düzeltme beklentisi';
    return 'Kararsız bölge — teyit için CVD ve volume profile ile birleştir';
  }

  setSymbol(symbol) {
    this.opts.symbol = symbol.toUpperCase();
    this.timeframes = {};
    this.fetchAll();
  }
}

/**
 * PRIMAT V2 - CVD Engine
 * Tick-by-tick Cumulative Volume Delta + Divergence
 */

class CVDEngine {
  constructor(bus = PRIMAT_BUS, opts = {}) {
    this.bus = bus;
    this.opts = {
      divergenceLookback: 30,
      trendPeriod: 20,
      ...opts
    };
    this.cvd = 0;
    this.prevCVD = 0;
    this.history = []; // { time, price, cvd, delta }
    this.maxHistory = 500;
    this.priceHistory = [];
    this.divergence = null;

    this.bus.on('trade', (t) => this.onTrade(t));
  }

  onTrade(trade) {
    const delta = trade.isBuyer ? trade.quoteVolume || trade.volume * trade.price : -(trade.quoteVolume || trade.volume * trade.price);
    this.prevCVD = this.cvd;
    this.cvd += delta;

    const point = {
      time: trade.time || Date.now(),
      price: trade.price,
      cvd: this.cvd,
      delta,
      symbol: trade.symbol
    };
    this.history.push(point);
    this.priceHistory.push(trade.price);
    if (this.history.length > this.maxHistory) this.history.shift();
    if (this.priceHistory.length > this.maxHistory) this.priceHistory.shift();

    const trend = this.calculateTrend();
    const div = this.detectDivergence();

    const payload = {
      ...point,
      prevCVD: this.prevCVD,
      trend,
      divergence: div,
      deltaImbalance: this.getDeltaImbalance()
    };

    this.bus.emit('cvd:update', payload);
    if (div && div.type !== 'none') {
      this.bus.emit('cvd:divergence', { ...payload, divergence: div });
    }
  }

  calculateTrend(period = this.opts.trendPeriod) {
    if (this.history.length < period) return 'neutral';
    const recent = this.history.slice(-period);
    const first = recent[0].cvd;
    const last = recent[recent.length - 1].cvd;
    const slope = (last - first) / period;
    // Also check price trend
    const pFirst = recent[0].price;
    const pLast = recent[recent.length - 1].price;
    const pSlope = (pLast - pFirst) / period;

    if (slope > 0 && pSlope > 0) return 'bullish';
    if (slope < 0 && pSlope < 0) return 'bearish';
    if (slope > 0 && pSlope < 0) return 'bullish_divergence';
    if (slope < 0 && pSlope > 0) return 'bearish_divergence';
    return 'neutral';
  }

  getDeltaImbalance(window = 20) {
    const slice = this.history.slice(-window);
    if (slice.length === 0) return 0;
    const buy = slice.filter(h => h.delta > 0).reduce((a,b)=>a+b.delta,0);
    const sell = Math.abs(slice.filter(h => h.delta < 0).reduce((a,b)=>a+b.delta,0));
    const total = buy + sell;
    if (total === 0) return 0;
    return Number(((buy - sell)/total * 100).toFixed(2));
  }

  detectDivergence() {
    const lb = this.opts.divergenceLookback;
    if (this.history.length < lb * 2) return { type: 'none', strength: 0 };

    const recent = this.history.slice(-lb);
    const prior = this.history.slice(-lb*2, -lb);

    const recentPriceHigh = Math.max(...recent.map(h=>h.price));
    const recentPriceLow = Math.min(...recent.map(h=>h.price));
    const priorPriceHigh = Math.max(...prior.map(h=>h.price));
    const priorPriceLow = Math.min(...prior.map(h=>h.price));

    const recentCvdHigh = Math.max(...recent.map(h=>h.cvd));
    const recentCvdLow = Math.min(...recent.map(h=>h.cvd));
    const priorCvdHigh = Math.max(...prior.map(h=>h.cvd));
    const priorCvdLow = Math.min(...prior.map(h=>h.cvd));

    // Bearish divergence: price higher high but CVD lower high
    if (recentPriceHigh > priorPriceHigh && recentCvdHigh < priorCvdHigh) {
      const strength = Math.min(100, ((recentPriceHigh - priorPriceHigh)/priorPriceHigh*1000) + ((priorCvdHigh - recentCvdHigh)/Math.abs(priorCvdHigh||1)*100));
      return { type: 'bearish', strength: Math.round(strength), desc: 'Price ↑ but CVD ↓ — selling pressure hidden' };
    }
    // Bullish divergence: price lower low but CVD higher low
    if (recentPriceLow < priorPriceLow && recentCvdLow > priorCvdLow) {
      const strength = Math.min(100, ((priorPriceLow - recentPriceLow)/priorPriceLow*1000) + ((recentCvdLow - priorCvdLow)/Math.abs(priorCvdLow||1)*100));
      return { type: 'bullish', strength: Math.round(strength), desc: 'Price ↓ but CVD ↑ — buying pressure building' };
    }

    return { type: 'none', strength: 0, desc: 'No divergence' };
  }

  getHistory() { return [...this.history]; }
  getCurrent() {
    return {
      cvd: this.cvd,
      delta: this.cvd - this.prevCVD,
      trend: this.calculateTrend(),
      divergence: this.detectDivergence(),
      imbalance: this.getDeltaImbalance()
    };
  }

  reset() {
    this.cvd = 0;
    this.prevCVD = 0;
    this.history = [];
    this.priceHistory = [];
  }
}

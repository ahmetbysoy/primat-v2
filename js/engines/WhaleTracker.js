/**
 * PRIMAT V2 - Whale Tracker
 * Real statistical detection: zScore, volume clustering, iceberg, order flow
 */

class WhaleTracker {
  constructor(bus = PRIMAT_BUS, opts = {}) {
    this.bus = bus;
    this.opts = {
      whaleThresholdUSD: 100_000,
      sharkThresholdUSD: 10_000,
      zScoreWhale: 3.5,
      zScoreShark: 2.0,
      windowSize: 200,
      ...opts
    };
    this.trades = []; // rolling window
    this.mean = 0;
    this.stdDev = 0;
    this.whaleCount = 0;
    this.volume24h = 0;
    this.buyerVolume = 0;
    this.sellerVolume = 0;
    this.lastUpdate = Date.now();
    this.orderFlow = []; // last 100 deltas

    // Iceberg detection state
    this.priceLevels = new Map(); // price -> { volume, count, lastTime }

    this.bus.on('trade', (t) => this.ingest(t));
  }

  ingest(trade) {
    const quoteVol = trade.quoteVolume || trade.price * trade.volume;
    this.trades.push({ ...trade, quoteVol });
    if (this.trades.length > this.opts.windowSize) this.trades.shift();

    // Update stats
    this._recalcStats();

    // Order flow
    const delta = trade.isBuyer ? quoteVol : -quoteVol;
    this.orderFlow.push(delta);
    if (this.orderFlow.length > 100) this.orderFlow.shift();

    // Iceberg tracking
    const key = trade.price.toFixed(1);
    const lvl = this.priceLevels.get(key) || { volume: 0, count: 0, lastTime: 0 };
    lvl.volume += trade.volume;
    lvl.count += 1;
    lvl.lastTime = Date.now();
    this.priceLevels.set(key, lvl);
    if (this.priceLevels.size > 500) {
      // prune oldest
      const oldest = [...this.priceLevels.entries()].sort((a,b)=>a[1].lastTime-b[1].lastTime)[0];
      this.priceLevels.delete(oldest[0]);
    }

    const detection = this.detect(trade);
    if (detection.isWhale || detection.isShark) {
      this.whaleCount++;
      this.bus.emit('whale:detected', detection);
      if (detection.isWhale) this.bus.emit('whale:whale', detection);
      else this.bus.emit('whale:shark', detection);
    }

    // Always emit flow update
    this.bus.emit('whale:flow', this.getFlowMetrics());
  }

  _recalcStats() {
    if (this.trades.length < 10) return;
    const vols = this.trades.map(t => t.quoteVol);
    const mean = vols.reduce((a,b)=>a+b,0)/vols.length;
    const variance = vols.reduce((a,b)=>a+Math.pow(b-mean,2),0)/vols.length;
    const stdDev = Math.sqrt(variance) || 1;
    this.mean = mean;
    this.stdDev = stdDev;

    this.buyerVolume = this.trades.filter(t=>t.isBuyer).reduce((a,t)=>a+t.quoteVol,0);
    this.sellerVolume = this.trades.filter(t=>!t.isBuyer).reduce((a,t)=>a+t.quoteVol,0);
    this.volume24h = vols.reduce((a,b)=>a+b,0); // window volume (approx)
  }

  detect(trade) {
    const quoteVol = trade.quoteVolume || trade.price * trade.volume;
    const zScore = this.stdDev > 0 ? (quoteVol - this.mean) / this.stdDev : 0;

    // Confidence based on zScore + orderbook depth proxy
    const depthProxy = Math.min(1, quoteVol / (this.mean * 5 + 1));
    const confidence = Math.min(99, Math.max(0, (Math.abs(zScore) * 15 + depthProxy * 20)));

    const isWhale = quoteVol >= this.opts.whaleThresholdUSD || zScore > this.opts.zScoreWhale;
    const isShark = !isWhale && (quoteVol >= this.opts.sharkThresholdUSD || zScore > this.opts.zScoreShark);

    // Market impact estimation: volume vs recent avg
    const impact = Math.min(10, (quoteVol / (this.mean || quoteVol)) );

    // Iceberg detection: repeated fills at same price level with many small trades
    const lvl = this.priceLevels.get(trade.price.toFixed(1));
    const iceberg = lvl && lvl.count > 8 && lvl.volume > this.mean * 3 && quoteVol < this.mean * 1.5;

    return {
      isWhale,
      isShark,
      isIceberg: !!iceberg,
      symbol: trade.symbol,
      price: trade.price,
      volume: trade.volume,
      quoteVolume: quoteVol,
      direction: trade.isBuyer ? 'LONG' : 'SHORT',
      isBuyer: trade.isBuyer,
      zScore: Number(zScore.toFixed(2)),
      confidence: Math.round(confidence),
      impact: Number(impact.toFixed(2)),
      icebergHint: iceberg ? `Absorption @ ${trade.price.toFixed(1)} (${lvl.count} fills)` : null,
      exchange: trade.exchange,
      time: trade.time
    };
  }

  getFlowMetrics() {
    const total = this.buyerVolume + this.sellerVolume;
    const delta = this.buyerVolume - this.sellerVolume;
    const imbalance = total > 0 ? (delta / total) * 100 : 0;
    const aggressive = imbalance > 10 ? 'BUYERS' : imbalance < -10 ? 'SELLERS' : 'NEUTRAL';
    const recentDelta = this.orderFlow.slice(-20).reduce((a,b)=>a+b,0);
    return {
      buyerVolume: this.buyerVolume,
      sellerVolume: this.sellerVolume,
      delta,
      imbalance: Number(imbalance.toFixed(2)),
      aggressive,
      recentDelta: Number(recentDelta.toFixed(2)),
      whaleCount: this.whaleCount,
      mean: this.mean,
      stdDev: this.stdDev,
      count: this.trades.length
    };
  }

  getWhaleHistory(limit = 50) {
    // Would be filled via bus listener in UI; this is helper
    return this.trades.filter(t => (t.quoteVol >= this.opts.sharkThresholdUSD)).slice(-limit).reverse();
  }

  reset() {
    this.trades = [];
    this.orderFlow = [];
    this.priceLevels.clear();
    this.whaleCount = 0;
  }
}

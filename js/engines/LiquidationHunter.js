/**
 * PRIMAT V2 - Liquidation Hunter
 * Heatmap + Cascade risk from orderbook + ticker distance
 * Uses real depth from WS
 */

class LiquidationHunter {
  constructor(bus = PRIMAT_BUS) {
    this.bus = bus;
    this.orderBook = { bids: [], asks: [] };
    this.currentPrice = 0;
    this.clusters = [];
    this.cascadeRisk = 0;
    this.history = [];

    this.bus.on('depth', (payload) => this.onDepth(payload));
    this.bus.on('ticker', (t) => {
      if (t.bid && t.ask) this.currentPrice = (t.bid + t.ask) / 2;
      else if (t.price) this.currentPrice = t.price;
      this.analyze();
    });
    this.bus.on('trade', (t) => {
      this.currentPrice = t.price;
    });
  }

  onDepth(payload) {
    const data = payload.data;
    // Binance depth: { bids: [[price, qty],...], asks: [[...]] }
    // Bybit/OKX normalized differently
    try {
      if (data.bids && data.asks) {
        // Binance style already
        this.orderBook.bids = data.bids.map(b => ({ price: parseFloat(b[0]), volume: parseFloat(b[1]) })).slice(0, 20);
        this.orderBook.asks = data.asks.map(a => ({ price: parseFloat(a[0]), volume: parseFloat(a[1]) })).slice(0, 20);
      } else if (data.b) {
        // Binance depthUpdate
        // b: bids, a: asks
        // We merge but for simple hunter we just replace top
        if (data.b && data.b.length) {
          this.orderBook.bids = data.b.map(b => ({ price: parseFloat(b[0]), volume: parseFloat(b[1]) })).slice(0,20);
        }
        if (data.a && data.a.length) {
          this.orderBook.asks = data.a.map(a => ({ price: parseFloat(a[0]), volume: parseFloat(a[1]) })).slice(0,20);
        }
      } else if (Array.isArray(data) && data.length && data[0].bids) {
        // OKX
        this.orderBook.bids = data[0].bids.map(b => ({ price: parseFloat(b[0]), volume: parseFloat(b[1]) })).slice(0,20);
        this.orderBook.asks = data[0].asks.map(a => ({ price: parseFloat(a[0]), volume: parseFloat(a[1]) })).slice(0,20);
      }
    } catch (e) {
      console.warn('[LiqHunter] depth parse', e);
    }
    this.analyze();
  }

  analyze() {
    if (!this.currentPrice || this.orderBook.bids.length === 0) return;
    const price = this.currentPrice;
    const allLevels = [
      ...this.orderBook.bids.map(l => ({ ...l, side: 'bid' })),
      ...this.orderBook.asks.map(l => ({ ...l, side: 'ask' }))
    ];

    const clusters = [];
    let cumulativeLeverage = 0;
    const threshold = price * 0.015; // 1.5% distance proxy for liquidation density

    for (const lvl of allLevels) {
      const distance = Math.abs(lvl.price - price) / price;
      // Liquidity that is close with high volume = likely stop cluster
      const estimatedLeverage = lvl.volume * price / (distance * 100 + 0.1);
      cumulativeLeverage += estimatedLeverage;

      // Heuristic: high volume close to price => liquidation pool
      const isCluster = lvl.volume * price > 50000 && distance < 0.02;
      if (isCluster) {
        const risk = distance < 0.005 ? 'CRITICAL' : distance < 0.01 ? 'HIGH' : 'MEDIUM';
        const cascadeProb = Math.min(95, (estimatedLeverage / 50000) * 10 + (1 - distance * 50) * 30);
        clusters.push({
          price: lvl.price,
          volume: lvl.volume,
          quoteVolume: lvl.volume * lvl.price,
          distance: Number((distance * 100).toFixed(3)),
          distanceUSD: Number(Math.abs(lvl.price - price).toFixed(2)),
          side: lvl.side,
          risk,
          cascadeProbability: Math.round(cascadeProb),
          estimatedLeverage: Math.round(estimatedLeverage)
        });
      }
    }

    // Sort by risk * volume
    clusters.sort((a,b) => b.cascadeProbability - a.cascadeProbability);
    this.clusters = clusters.slice(0, 8);

    // Cascade risk 0-100
    const totalClusterVol = this.clusters.reduce((a,c)=>a+c.quoteVolume,0);
    this.cascadeRisk = Math.min(100, Math.round((totalClusterVol / 200000) * 30 + this.clusters.filter(c=>c.risk==='CRITICAL').length * 20));

    const payload = {
      price,
      clusters: this.clusters,
      cascadeRisk: this.cascadeRisk,
      totalClusterVol,
      alert: this.cascadeRisk > 70 ? 'IMMINENT_SWEEP' : this.cascadeRisk > 45 ? 'BUILDING' : 'LOW',
      nextTarget: this.clusters[0] || null
    };

    this.history.push({ ...payload, time: Date.now() });
    if (this.history.length > 100) this.history.shift();

    this.bus.emit('liquidation:update', payload);
    // Throttle alerts at source: max 1 per 35s, and only on rising risk
    if (payload.alert === 'IMMINENT_SWEEP') {
      const now = Date.now();
      const last = this._lastAlertAt || 0;
      const lastRisk = this._lastAlertRisk || 0;
      const riskJump = payload.cascadeRisk - lastRisk > 8;
      const timeOk = now - last > 35000;
      // Also don't spam same price: require >0.2% move
      const lastPrice = this._lastAlertPrice || 0;
      const priceMove = lastPrice ? Math.abs(payload.price - lastPrice)/payload.price > 0.002 : true;
      if ( (timeOk && priceMove) || riskJump) {
        this._lastAlertAt = now;
        this._lastAlertRisk = payload.cascadeRisk;
        this._lastAlertPrice = payload.price;
        this.bus.emit('liquidation:alert', payload);
      }
    } else {
      // reset if risk dropped
      if (payload.cascadeRisk < 55) {
        this._lastAlertRisk = payload.cascadeRisk;
      }
    }
  }

  getHeatmapData() {
    // For visualization: price vs volume
    const bids = this.orderBook.bids.map(b => ({ x: b.price, y: b.volume * b.price, side: 'bid' }));
    const asks = this.orderBook.asks.map(a => ({ x: a.price, y: a.volume * a.price, side: 'ask' }));
    return [...bids, ...asks].sort((a,b)=>a.x-b.x);
  }

  estimateLiquidationPrice(entry, leverage, direction) {
    // Simple isolated margin liquidation approx
    // Long: liq = entry * (1 - 1/leverage + 0.004) ; Short: entry * (1 + 1/leverage - 0.004)
    const fee = 0.004;
    if (direction === 'LONG') return entry * (1 - (1 / leverage) + fee);
    return entry * (1 + (1 / leverage) - fee);
  }
}

/**
 * PRIMAT V2 - Arbitrage Scanner
 * Cross-exchange + Triangular + Funding Rate
 * Real ticker comparison
 */

class ArbitrageScanner {
  constructor(bus = PRIMAT_BUS, opts = {}) {
    this.bus = bus;
    this.opts = {
      minProfitPct: 0.15, // after fees
      fees: { binance: 0.1, bybit: 0.1, okx: 0.08 }, // % per side (taker)
      pairs: ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT'],
      ...opts
    };
    this.tickers = new Map(); // exchange -> symbol -> ticker
    this.opportunities = [];
    this.triangularOps = [];
    this.scanInterval = null;

    this.bus.on('ticker', (t) => this.onTicker(t));
  }

  onTicker(ticker) {
    const key = `${ticker.exchange}:${ticker.symbol}`;
    if (!this.tickers.has(ticker.exchange)) this.tickers.set(ticker.exchange, new Map());
    this.tickers.get(ticker.exchange).set(ticker.symbol, ticker);
    // Throttle scan: every 500ms max
    if (!this._throttle) {
      this._throttle = setTimeout(() => {
        this.scan();
        this._throttle = null;
      }, 500);
    }
  }

  scan() {
    const opportunities = [];
    const exchanges = Array.from(this.tickers.keys());

    for (const pair of this.opts.pairs) {
      const tickersForPair = [];
      for (const ex of exchanges) {
        const m = this.tickers.get(ex);
        const t = m ? m.get(pair) : null;
        if (t && t.bid && t.ask) tickersForPair.push({ exchange: ex, ticker: t });
      }
      if (tickersForPair.length < 2) continue;

      // Compare every pair of exchanges
      for (let i = 0; i < tickersForPair.length; i++) {
        for (let j = i + 1; j < tickersForPair.length; j++) {
          const a = tickersForPair[i];
          const b = tickersForPair[j];

          // Direction 1: buy on A (ask), sell on B (bid)
          const spread1 = (b.ticker.bid - a.ticker.ask) / a.ticker.ask;
          const net1 = this.calculateNetProfit(spread1, a.exchange, b.exchange);
          if (net1 * 100 > this.opts.minProfitPct) {
            opportunities.push({
              pair,
              type: 'cross',
              buyExchange: a.exchange,
              sellExchange: b.exchange,
              buyPrice: a.ticker.ask,
              sellPrice: b.ticker.bid,
              spread: Number((spread1 * 100).toFixed(4)),
              netProfitPct: Number((net1 * 100).toFixed(4)),
              profitUSD: Number((net1 * a.ticker.ask).toFixed(2)), // per 1 coin
              volume: Math.min(a.ticker.askQty || 0, b.ticker.bidQty || 0),
              timestamp: Date.now()
            });
          }

          // Direction 2: buy on B, sell on A
          const spread2 = (a.ticker.bid - b.ticker.ask) / b.ticker.ask;
          const net2 = this.calculateNetProfit(spread2, b.exchange, a.exchange);
          if (net2 * 100 > this.opts.minProfitPct) {
            opportunities.push({
              pair,
              type: 'cross',
              buyExchange: b.exchange,
              sellExchange: a.exchange,
              buyPrice: b.ticker.ask,
              sellPrice: a.ticker.bid,
              spread: Number((spread2 * 100).toFixed(4)),
              netProfitPct: Number((net2 * 100).toFixed(4)),
              profitUSD: Number((net2 * b.ticker.ask).toFixed(2)),
              volume: Math.min(b.ticker.askQty || 0, a.ticker.bidQty || 0),
              timestamp: Date.now()
            });
          }
        }
      }
    }

    opportunities.sort((a,b)=> b.netProfitPct - a.netProfitPct);
    this.opportunities = opportunities.slice(0, 10);

    // Triangular check for BTC/ETH combos if we have USDT pairs
    this.scanTriangular();

    const payload = {
      opportunities: this.opportunities,
      triangular: this.triangularOps,
      count: this.opportunities.length,
      best: this.opportunities[0] || null
    };

    this.bus.emit('arbitrage:update', payload);
    if (payload.best && payload.best.netProfitPct > 0.5) {
      this.bus.emit('arbitrage:alert', payload.best);
    }
  }

  calculateNetProfit(grossSpread, buyEx, sellEx) {
    const feeBuy = (this.opts.fees[buyEx] || 0.1) / 100;
    const feeSell = (this.opts.fees[sellEx] || 0.1) / 100;
    // Net = gross - fees both sides - 0.05% slippage buffer
    return grossSpread - feeBuy - feeSell - 0.0005;
  }

  scanTriangular() {
    // Triangular: BTC/USDT -> ETH/BTC -> ETH/USDT
    // We simulate using existing tickers: need BTCUSDT, ETHUSDT, ETHBTC
    // If we have all three on same exchange, check loop
    const results = [];
    for (const [exchange, map] of this.tickers.entries()) {
      const btcUsdt = map.get('BTCUSDT');
      const ethUsdt = map.get('ETHUSDT');
      const ethBtc = map.get('ETHBTC');
      if (btcUsdt && ethUsdt && ethBtc) {
        // Path 1: USDT -> BTC -> ETH -> USDT
        // 1 USDT -> 1/btcAsk BTC -> (btc * ethBtcBid) ETH -> ETH * ethUsdtBid USDT
        const start = 1000; // $1000
        const btcGot = start / btcUsdt.ask;
        const ethGot = btcGot / ethBtc.ask; // buy ETH with BTC (ask)
        const usdtGot = ethGot * ethUsdt.bid;
        const profit = (usdtGot - start) / start;
        const net = profit - 0.003; // ~0.3% fees 3 trades
        if (net * 100 > this.opts.minProfitPct) {
          results.push({
            exchange,
            path: 'USDT → BTC → ETH → USDT',
            grossPct: Number((profit*100).toFixed(4)),
            netPct: Number((net*100).toFixed(4)),
            start, end: Number(usdtGot.toFixed(2))
          });
        }
      }
    }
    this.triangularOps = results;
  }

  // Funding rate arbitrage (perp vs spot) - fetch via REST occasionally
  async fetchFundingRates() {
    try {
      const [binance, bybit] = await Promise.allSettled([
        fetch('https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT').then(r=>r.json()),
        fetch('https://api.bybit.com/v5/market/funding/history?category=linear&symbol=BTCUSDT&limit=1').then(r=>r.json())
      ]);
      const out = {};
      if (binance.status === 'fulfilled' && binance.value) {
        out.binance = parseFloat(binance.value.lastFundingRate || 0) * 100;
      }
      if (bybit.status === 'fulfilled' && bybit.value && bybit.value.result && bybit.value.result.list) {
        out.bybit = parseFloat(bybit.value.result.list[0]?.fundingRate || 0) * 100;
      }
      this.bus.emit('arbitrage:funding', out);
      return out;
    } catch (e) {
      console.warn('[Arb] funding fetch fail', e);
      return null;
    }
  }

  startFundingPoll() {
    this.fetchFundingRates();
    this.fundingInterval = setInterval(() => this.fetchFundingRates(), 60000);
  }
  stop() {
    if (this.fundingInterval) clearInterval(this.fundingInterval);
  }
}

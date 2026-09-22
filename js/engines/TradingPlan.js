/**
 * PRIMAT V2 - Smart Trading Plan Generator
 * ATR-based SL/TP + Position Sizing + Leverage
 */

class TradingPlanEngine {
  constructor(bus = PRIMAT_BUS) {
    this.bus = bus;
    this.lastPlan = null;
    this.accountBalance = 1000; // default USDT, user can change
    this.riskPerTrade = 2; // %
  }

  // ATR calc from klines
  calculateATR(klines, period = 14) {
    if (!klines || klines.length < period + 1) return null;
    const trs = [];
    for (let i = 1; i < klines.length; i++) {
      const high = klines[i].high;
      const low = klines[i].low;
      const prevClose = klines[i-1].close;
      const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
      trs.push(tr);
    }
    const recent = trs.slice(-period);
    return recent.reduce((a,b)=>a+b,0)/recent.length;
  }

  calculateOptimalLeverage(atr, price, volatility) {
    // Volatility based: higher ATR => lower leverage
    const atrPct = (atr / price) * 100;
    if (atrPct > 3) return 3;
    if (atrPct > 2) return 5;
    if (atrPct > 1) return 10;
    if (atrPct > 0.5) return 15;
    return 20;
  }

  async generate(signal, symbol = 'BTCUSDT') {
    // signal: { direction: 'LONG'|'SHORT', entryPrice, confidence, confluenceScore, ... }
    if (!signal || !signal.entryPrice) {
      // Try to get current price from last ticker
      throw new Error('Entry price required');
    }

    const entry = signal.entryPrice;
    const direction = signal.direction || (signal.signal && signal.signal.includes('BUY') ? 'LONG' : 'SHORT');

    // Fetch ATR via Binance klines 1m
    let atr = signal.atr;
    let klines = null;
    if (!atr) {
      try {
        const res = await fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=15m&limit=30`);
        if (res.ok) {
          const data = await res.json();
          klines = data.map(k=>({ high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]) }));
          atr = this.calculateATR(klines, 14);
        }
      } catch (e) {
        console.warn('[TradingPlan] ATR fetch failed', e);
      }
    }
    if (!atr) {
      // Fallback: 1% of price
      atr = entry * 0.01;
    }

    const atrMultiSL = 1.5;
    const stopLoss = direction === 'LONG' ? entry - (atr * atrMultiSL) : entry + (atr * atrMultiSL);
    const riskPerUnit = Math.abs(entry - stopLoss);
    if (riskPerUnit === 0) throw new Error('Invalid risk');

    const takeProfit1 = direction === 'LONG' ? entry + riskPerUnit * 2 : entry - riskPerUnit * 2;
    const takeProfit2 = direction === 'LONG' ? entry + riskPerUnit * 3 : entry - riskPerUnit * 3;
    const takeProfit3 = direction === 'LONG' ? entry + riskPerUnit * 5 : entry - riskPerUnit * 5;

    const riskAmount = this.accountBalance * (this.riskPerTrade / 100);
    const positionSize = riskAmount / riskPerUnit; // in coin
    const positionValue = positionSize * entry;
    const leverage = this.calculateOptimalLeverage(atr, entry);
    const marginRequired = positionValue / leverage;

    // Validation: margin should be <= balance * 0.95
    let adjLeverage = leverage;
    if (marginRequired > this.accountBalance * 0.9) {
      adjLeverage = Math.ceil(positionValue / (this.accountBalance * 0.8));
    }

    const riskReward1 = Math.abs(takeProfit1 - entry) / riskPerUnit;
    const riskReward2 = Math.abs(takeProfit2 - entry) / riskPerUnit;

    // Entry zone using volume profile if available
    let entryZone = { low: entry * 0.999, high: entry * 1.001 };
    if (signal.volumeProfile) {
      const { poc, vah, val } = signal.volumeProfile;
      if (direction === 'LONG' && val) {
        entryZone = { low: val, high: poc || entry };
      } else if (direction === 'SHORT' && vah) {
        entryZone = { low: poc || entry, high: vah };
      }
    }

    const plan = {
      symbol,
      direction,
      entry: Number(entry.toFixed(2)),
      entryZone: { low: Number(entryZone.low.toFixed(2)), high: Number(entryZone.high.toFixed(2)) },
      stopLoss: Number(stopLoss.toFixed(2)),
      takeProfit1: Number(takeProfit1.toFixed(2)),
      takeProfit2: Number(takeProfit2.toFixed(2)),
      takeProfit3: Number(takeProfit3.toFixed(2)),
      atr: Number(atr.toFixed(2)),
      atrPercent: Number(((atr/entry)*100).toFixed(2)),
      riskPerUnit: Number(riskPerUnit.toFixed(2)),
      riskAmount: Number(riskAmount.toFixed(2)),
      positionSize: Number(positionSize.toFixed(6)),
      positionValue: Number(positionValue.toFixed(2)),
      leverage: adjLeverage,
      marginRequired: Number((positionValue / adjLeverage).toFixed(2)),
      riskReward1: Number(riskReward1.toFixed(2)),
      riskReward2: Number(riskReward2.toFixed(2)),
      riskPerTrade: this.riskPerTrade,
      accountBalance: this.accountBalance,
      confidence: signal.confidence || signal.confluenceScore || 0,
      timestamp: Date.now(),
      notes: this.generateNotes(direction, atr, riskReward1, signal),
      invalidation: direction === 'LONG' ? `Close below ${stopLoss.toFixed(2)} invalidates` : `Close above ${stopLoss.toFixed(2)} invalidates`
    };

    this.lastPlan = plan;
    this.bus.emit('trading:plan', plan);
    return plan;
  }

  generateNotes(direction, atr, rr, signal) {
    const notes = [];
    if (atr / signal.entryPrice > 0.02) notes.push('Yüksek volatilite — pozisyonu küçült, SL geniş');
    if (rr < 2) notes.push('R:R düşük — sadece yüksek confluence ile gir');
    if (signal.divergence) notes.push(`CVD divergence: ${signal.divergence.type}`);
    if (signal.whaleFlow && Math.abs(signal.whaleFlow.imbalance) > 15) notes.push(`Whale flow ${signal.whaleFlow.aggressive} tarafında güçlü`);
    if (notes.length === 0) notes.push(direction === 'LONG' ? 'Trend long yönünde, momentum teyitli' : 'Trend short yönünde, dikkatli ol');
    return notes;
  }

  setRiskParams(balance, riskPct) {
    this.accountBalance = parseFloat(balance) || this.accountBalance;
    this.riskPerTrade = parseFloat(riskPct) || this.riskPerTrade;
  }

  getLastPlan() { return this.lastPlan; }
}

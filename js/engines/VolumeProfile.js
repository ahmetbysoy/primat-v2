/**
 * PRIMAT V2 - Volume Profile & POC Engine
 */

class VolumeProfile {
  constructor(bus = PRIMAT_BUS, opts = {}) {
    this.bus = bus;
    this.opts = {
      binSize: 0, // auto
      valueAreaPercent: 0.70,
      maxBins: 200,
      ...opts
    };
    this.trades = [];
    this.maxTrades = 2000;
    this.profile = {};
    this.poc = null;
    this.vah = null;
    this.val = null;

    this.bus.on('trade', (t) => this.ingest(t));
  }

  ingest(trade) {
    this.trades.push(trade);
    if (this.trades.length > this.maxTrades) this.trades.shift();
    // Throttle heavy calc: update every 20 trades or 500ms
    if (this.trades.length % 20 === 0) {
      this.build();
    }
  }

  autoBinSize() {
    if (this.trades.length < 10) return 1;
    const prices = this.trades.map(t=>t.price);
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const range = max - min;
    if (range === 0) return 0.1;
    // Aim for ~50 bins
    const raw = range / 50;
    // Round to nice step
    const magnitude = Math.pow(10, Math.floor(Math.log10(raw)));
    const residual = raw / magnitude;
    let nice;
    if (residual < 1.5) nice = 1;
    else if (residual < 3.5) nice = 2;
    else if (residual < 7.5) nice = 5;
    else nice = 10;
    return nice * magnitude;
  }

  build() {
    if (this.trades.length === 0) return;
    const binSize = this.opts.binSize || this.autoBinSize();
    const profile = {};
    let totalVolume = 0;

    for (const t of this.trades) {
      const vol = t.quoteVolume || t.volume * t.price;
      const bin = (Math.floor(t.price / binSize) * binSize).toFixed(2);
      profile[bin] = (profile[bin] || 0) + vol;
      totalVolume += vol;
    }

    // Sort bins by price
    const sortedBins = Object.entries(profile).sort((a,b)=> parseFloat(a[0]) - parseFloat(b[0]));
    // Find POC
    const pocEntry = Object.entries(profile).sort((a,b)=> b[1]-a[1])[0];
    const poc = pocEntry ? parseFloat(pocEntry[0]) : null;

    // Value Area 70% around POC
    let vah = null, val = null;
    if (poc !== null) {
      // Expand from POC outward by volume
      const idx = sortedBins.findIndex(([p])=> parseFloat(p) === poc);
      let vaVolume = profile[poc.toFixed(2)];
      let up = idx + 1;
      let down = idx - 1;
      const target = totalVolume * this.opts.valueAreaPercent;

      while (vaVolume < target && (up < sortedBins.length || down >= 0)) {
        const upVol = up < sortedBins.length ? sortedBins[up][1] : -1;
        const downVol = down >=0 ? sortedBins[down][1] : -1;
        if (upVol > downVol) {
          vaVolume += upVol;
          up++;
        } else {
          vaVolume += downVol;
          down--;
        }
      }
      vah = sortedBins[Math.min(sortedBins.length-1, up-1)] ? parseFloat(sortedBins[Math.min(sortedBins.length-1, up-1)][0]) : poc;
      val = sortedBins[Math.max(0, down+1)] ? parseFloat(sortedBins[Math.max(0, down+1)][0]) : poc;
      // Ensure vah > poc > val
      if (vah < poc) [vah, val] = [val, vah];
      // If calculation weird, fallback
      if (vah < val) [vah, val] = [val, vah];
    }

    this.profile = profile;
    this.poc = poc;
    this.vah = vah;
    this.val = val;
    this.binSize = binSize;
    this.totalVolume = totalVolume;

    const payload = {
      profile,
      poc,
      vah,
      val,
      binSize,
      totalVolume,
      bins: sortedBins,
      support: val,
      resistance: vah,
      isBalanced: vah && val ? ((poc - val)/(vah - val) > 0.4 && (poc - val)/(vah - val) < 0.6) : false
    };

    this.bus.emit('volume:profile', payload);
    return payload;
  }

  getLevels(currentPrice) {
    if (!this.poc) return null;
    const distPOC = ((currentPrice - this.poc)/currentPrice*100).toFixed(2);
    let position = 'at POC';
    if (currentPrice > this.vah) position = 'above value area (overbought)';
    else if (currentPrice < this.val) position = 'below value area (oversold)';
    else if (currentPrice > this.poc) position = 'above POC (bullish)';
    else if (currentPrice < this.poc) position = 'below POC (bearish)';

    return {
      poc: this.poc,
      vah: this.vah,
      val: this.val,
      distPOC: parseFloat(distPOC),
      position,
      support: this.val,
      resistance: this.vah
    };
  }

  // Quick helper for Trading Plan
  getNearestSupportResistance(price) {
    const bins = Object.entries(this.profile).sort((a,b)=> Math.abs(parseFloat(a[0])-price) - Math.abs(parseFloat(b[0])-price));
    // Top 3 nearest high volume levels
    const top = Object.entries(this.profile).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([p,v])=>({ price: parseFloat(p), volume: v }));
    return top;
  }
}

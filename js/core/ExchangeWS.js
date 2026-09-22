/**
 * PRIMAT V2 - Multi-Exchange WebSocket Manager
 * Real connections: Binance, Bybit, OKX
 * Features: auto-reconnect exponential backoff, heartbeat, rate limiter, queue
 */

class RateLimiter {
  constructor(maxPerSecond = 10) {
    this.maxPerSecond = maxPerSecond;
    this.queue = [];
    this.timestamps = [];
    this.running = false;
  }

  async throttle(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this._process();
    });
  }

  async _process() {
    if (this.running) return;
    this.running = true;
    while (this.queue.length > 0) {
      const now = Date.now();
      // Clean old timestamps >1s
      this.timestamps = this.timestamps.filter(t => now - t < 1000);
      if (this.timestamps.length >= this.maxPerSecond) {
        const wait = 1000 - (now - this.timestamps[0]) + 5;
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      const { fn, resolve, reject } = this.queue.shift();
      this.timestamps.push(Date.now());
      try {
        const res = await fn();
        resolve(res);
      } catch (e) { reject(e); }
    }
    this.running = false;
  }
}

class ExchangeWS {
  constructor({ exchange, pairs = ['BTCUSDT'], bus = PRIMAT_BUS } = {}) {
    this.exchange = exchange; // 'binance' | 'bybit' | 'okx'
    this.pairs = pairs.map(p => p.toUpperCase());
    this.bus = bus;
    this.ws = null;
    this.isManualClose = false;
    this.reconnectAttempts = 0;
    this.maxReconnect = 20;
    this.baseDelay = 1000;
    this.heartbeatInterval = null;
    this.rateLimiter = new RateLimiter(exchange === 'binance' ? 5 : 10);
    this.buffer = [];
    this.maxBuffer = 5000;
    this.status = 'disconnected'; // disconnected | connecting | connected | error
    this.stats = { messages: 0, reconnects: 0, errors: 0 };
  }

  getUrl() {
    switch (this.exchange) {
      case 'binance': {
        // Binance combined stream: wss://stream.binance.com:9443/ws/<stream1>/<stream2>
        // For trades: btcusdt@trade , bookTicker: btcusdt@bookTicker , depth: btcusdt@depth20@100ms
        const streams = this.pairs.map(p => `${p.toLowerCase()}@trade`).join('/');
        // Also add bookTicker for arbitrage
        const tickers = this.pairs.map(p => `${p.toLowerCase()}@bookTicker`).join('/');
        // Use combined
        return `wss://stream.binance.com:9443/ws/${streams}/${tickers}`;
        // Fallback single: if URL too long, we fallback to stream.binance.com:9443/stream?streams=
      }
      case 'bybit':
        return 'wss://stream.bybit.com/v5/public/spot';
      case 'okx':
        return 'wss://ws.okx.com:8443/ws/v5/public';
      default:
        throw new Error(`Unknown exchange ${this.exchange}`);
    }
  }

  // For Binance combined stream alternative (supports many streams correctly)
  getBinanceCombinedUrl() {
    const streams = [];
    for (const p of this.pairs) {
      const l = p.toLowerCase();
      streams.push(`${l}@trade`);
      streams.push(`${l}@bookTicker`);
      streams.push(`${l}@depth20@100ms`);
    }
    return `wss://stream.binance.com:9443/stream?streams=${streams.join('/')}`;
  }

  connect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    this.isManualClose = false;
    this.status = 'connecting';
    this.bus.emit('ws:status', { exchange: this.exchange, status: this.status });

    let url = this.getUrl();
    // Binance özel: combined url daha stabil
    if (this.exchange === 'binance') url = this.getBinanceCombinedUrl();

    console.log(`[PRIMAT][WS] Connecting ${this.exchange} -> ${url}`);
    try {
      this.ws = new WebSocket(url);
    } catch (e) {
      console.error('[WS] construct failed', e);
      this._scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      console.log(`[PRIMAT][WS] ✅ ${this.exchange} connected`);
      this.status = 'connected';
      this.reconnectAttempts = 0;
      this.bus.emit('ws:status', { exchange: this.exchange, status: this.status });
      this.bus.emit('ws:connected', { exchange: this.exchange });
      this._subscribe();
      this._startHeartbeat();
    };

    this.ws.onmessage = (event) => {
      this.stats.messages++;
      // Rate limit processing
      this.rateLimiter.throttle(() => this._handleMessage(event)).catch(console.error);
    };

    this.ws.onerror = (err) => {
      console.warn(`[PRIMAT][WS] ⚠️ ${this.exchange} error`, err);
      this.stats.errors++;
      this.status = 'error';
      this.bus.emit('ws:status', { exchange: this.exchange, status: this.status });
    };

    this.ws.onclose = (ev) => {
      console.log(`[PRIMAT][WS] closed ${this.exchange} code=${ev.code} reason=${ev.reason}`);
      this._stopHeartbeat();
      this.status = 'disconnected';
      this.bus.emit('ws:status', { exchange: this.exchange, status: this.status });
      if (!this.isManualClose) this._scheduleReconnect();
    };
  }

  _subscribe() {
    if (this.exchange === 'bybit') {
      const args = this.pairs.flatMap(p => [
        `publicTrade.${p}`,
        `orderbook.50.${p}`,
        `tickers.${p}`
      ]);
      this.send({ op: 'subscribe', args });
    } else if (this.exchange === 'okx') {
      const args = this.pairs.flatMap(p => [
        { channel: 'trades', instId: p.replace('USDT', '-USDT') },
        { channel: 'books', instId: p.replace('USDT', '-USDT') },
        { channel: 'tickers', instId: p.replace('USDT', '-USDT') }
      ]);
      this.send({ op: 'subscribe', args });
    } else {
      // Binance combined stream auto-subscribed via URL
    }
  }

  _handleMessage(event) {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    // Handle Binance combined stream wrapper: { stream, data }
    if (msg.stream && msg.data) {
      msg = msg.data;
    }

    // Binance trade: { e: 'trade', s: 'BTCUSDT', p: '...', q: '...', T: ..., m: bool }
    if (msg.e === 'trade' && msg.s) {
      const trade = {
        exchange: 'binance',
        symbol: msg.s,
        price: parseFloat(msg.p),
        volume: parseFloat(msg.q),
        quoteVolume: parseFloat(msg.p) * parseFloat(msg.q),
        isBuyerMaker: msg.m, // true = seller aggressive? Actually m true means buyer is maker -> seller aggressive
        isBuyer: !msg.m,
        time: msg.T,
        id: msg.t
      };
      this._pushBuffer(trade);
      this.bus.emit('trade', trade);
      this.bus.emit(`trade:${trade.symbol}`, trade);
      return;
    }

    // Binance bookTicker: { e: 'bookTicker' or no e, s, b, B, a, A }
    if ((msg.e === 'bookTicker' || (msg.b && msg.a)) && msg.s) {
      const ticker = {
        exchange: 'binance',
        symbol: msg.s,
        bid: parseFloat(msg.b),
        bidQty: parseFloat(msg.B),
        ask: parseFloat(msg.a),
        askQty: parseFloat(msg.A),
        spread: ((parseFloat(msg.a) - parseFloat(msg.b)) / parseFloat(msg.b)) * 100,
        time: Date.now()
      };
      this.bus.emit('ticker', ticker);
      this.bus.emit(`ticker:${ticker.symbol}`, ticker);
      return;
    }

    // Binance depth
    if (msg.e === 'depthUpdate' || msg.lastUpdateId) {
      this.bus.emit('depth', { exchange: 'binance', data: msg });
      return;
    }

    // Bybit
    if (msg.topic && msg.topic.startsWith('publicTrade.')) {
      const symbol = msg.topic.split('.')[1];
      if (msg.data && Array.isArray(msg.data)) {
        msg.data.forEach(d => {
          const trade = {
            exchange: 'bybit',
            symbol,
            price: parseFloat(d.p),
            volume: parseFloat(d.v),
            quoteVolume: parseFloat(d.p) * parseFloat(d.v),
            isBuyer: d.S === 'Buy',
            time: parseInt(d.T),
            id: d.i
          };
          this.bus.emit('trade', trade);
        });
      }
      return;
    }
    if (msg.topic && msg.topic.startsWith('tickers.')) {
      const t = msg.data;
      if (t) {
        const ticker = {
          exchange: 'bybit',
          symbol: msg.topic.split('.')[1],
          bid: parseFloat(t.bid1Price),
          ask: parseFloat(t.ask1Price),
          bidQty: parseFloat(t.bid1Size),
          askQty: parseFloat(t.ask1Size),
          time: Date.now()
        };
        if (ticker.bid && ticker.ask) this.bus.emit('ticker', ticker);
      }
      return;
    }

    // OKX
    if (msg.arg && msg.data) {
      const { channel, instId } = msg.arg;
      const symbol = instId.replace('-', '');
      if (channel === 'trades') {
        msg.data.forEach(d => {
          const trade = {
            exchange: 'okx',
            symbol,
            price: parseFloat(d[1]),
            volume: parseFloat(d[2]),
            quoteVolume: parseFloat(d[1]) * parseFloat(d[2]),
            isBuyer: d[0] === 'buy',
            time: parseInt(d[3]),
            id: d[0] + d[3]
          };
          this.bus.emit('trade', trade);
        });
      } else if (channel === 'tickers') {
        const d = msg.data[0];
        if (d) {
          const ticker = {
            exchange: 'okx',
            symbol,
            bid: parseFloat(d.bidPx),
            ask: parseFloat(d.askPx),
            bidQty: parseFloat(d.bidSz),
            askQty: parseFloat(d.askSz),
            time: Date.now()
          };
          this.bus.emit('ticker', ticker);
        }
      } else if (channel === 'books') {
        this.bus.emit('depth', { exchange: 'okx', symbol, data: msg.data[0] });
      }
      return;
    }

    // Pong etc
    if (msg.pong || msg.op === 'pong') return;
  }

  _pushBuffer(trade) {
    this.buffer.push(trade);
    if (this.buffer.length > this.maxBuffer) this.buffer.shift();
  }

  send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this.heartbeatInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        if (this.exchange === 'bybit' || this.exchange === 'okx') {
          this.send({ op: 'ping' });
        } else {
          // Binance doesn't need ping, but we can send nothing, browser auto pings
          // We emit a heartbeat event
          this.bus.emit('ws:heartbeat', { exchange: this.exchange });
        }
      }
    }, 20000);
  }

  _stopHeartbeat() {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    this.heartbeatInterval = null;
  }

  _scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnect) {
      console.error(`[PRIMAT][WS] ❌ Max reconnect reached for ${this.exchange}`);
      this.bus.emit('ws:failed', { exchange: this.exchange });
      return;
    }
    const delay = Math.min(this.baseDelay * Math.pow(1.8, this.reconnectAttempts) + Math.random() * 1000, 30000);
    this.reconnectAttempts++;
    this.stats.reconnects++;
    console.log(`[PRIMAT][WS] Reconnect ${this.exchange} in ${Math.round(delay)}ms (attempt ${this.reconnectAttempts})`);
    this.bus.emit('ws:reconnecting', { exchange: this.exchange, attempt: this.reconnectAttempts, delay });
    setTimeout(() => this.connect(), delay);
  }

  disconnect() {
    this.isManualClose = true;
    this._stopHeartbeat();
    if (this.ws) {
      try { this.ws.close(1000, 'manual'); } catch {}
      this.ws = null;
    }
    this.status = 'disconnected';
  }

  getBuffer() { return [...this.buffer]; }
}

// Multi-manager
class ExchangeManager {
  constructor(pairs, bus = PRIMAT_BUS) {
    this.pairs = pairs;
    this.bus = bus;
    this.exchanges = new Map();
  }
  add(exchange) {
    const ws = new ExchangeWS({ exchange, pairs: this.pairs, bus: this.bus });
    this.exchanges.set(exchange, ws);
    return ws;
  }
  connectAll() {
    for (const ws of this.exchanges.values()) ws.connect();
  }
  disconnectAll() {
    for (const ws of this.exchanges.values()) ws.disconnect();
  }
  getStatus() {
    const out = {};
    for (const [k, ws] of this.exchanges.entries()) out[k] = ws.status;
    return out;
  }
}

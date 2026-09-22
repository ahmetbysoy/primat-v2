/**
 * PRIMAT V2 - Event Bus Core
 * Pub/Sub + Event Queue + Memory Management
 * Real event-driven architecture - zero mock
 */
class EventBus {
  constructor(maxQueueSize = 10000) {
    this.events = new Map();
    this.queue = [];
    this.maxQueueSize = maxQueueSize;
    this.stats = { published: 0, delivered: 0, dropped: 0, errors: 0 };
    this.middlewares = [];
  }

  use(middleware) {
    this.middlewares.push(middleware);
  }

  on(event, callback, priority = 0) {
    if (!this.events.has(event)) this.events.set(event, []);
    const listeners = this.events.get(event);
    listeners.push({ callback, priority });
    listeners.sort((a, b) => b.priority - a.priority);
    // Return unsubscribe
    return () => this.off(event, callback);
  }

  off(event, callback) {
    if (!this.events.has(event)) return;
    const filtered = this.events.get(event).filter(l => l.callback !== callback);
    this.events.set(event, filtered);
  }

  once(event, callback) {
    const wrapper = (data) => {
      callback(data);
      this.off(event, wrapper);
    };
    return this.on(event, wrapper);
  }

  async emit(event, data) {
    // Middleware chain
    let payload = data;
    for (const mw of this.middlewares) {
      try {
        const res = await mw(event, payload);
        if (res === false) return; // blocked
        if (res !== undefined) payload = res;
      } catch (e) {
        console.warn('[EventBus] middleware error', e);
      }
    }

    // Queue management - circular buffer behavior
    this.queue.push({ event, data: payload, ts: Date.now() });
    if (this.queue.length > this.maxQueueSize) {
      this.queue.shift();
      this.stats.dropped++;
    }
    this.stats.published++;

    const listeners = this.events.get(event);
    if (!listeners || listeners.length === 0) {
      // wildcard support: e.g., 'trade:*'
      for (const [key, cbs] of this.events.entries()) {
        if (key.endsWith('*') && event.startsWith(key.slice(0, -1))) {
          for (const { callback } of cbs) {
            try { await callback(payload, event); this.stats.delivered++; } 
            catch(e){ this.stats.errors++; console.error(e); }
          }
        }
      }
      return;
    }

    for (const { callback } of listeners) {
      try {
        await callback(payload, event);
        this.stats.delivered++;
      } catch (e) {
        this.stats.errors++;
        console.error(`[EventBus] ${event} handler error:`, e);
      }
    }
  }

  // For debugging
  getStats() {
    return { ...this.stats, queueSize: this.queue.length, eventTypes: this.events.size };
  }

  clearHistory() { this.queue = []; }

  // Replay last N events for new subscribers
  replay(event, callback, n = 100) {
    const recent = this.queue.filter(q => q.event === event).slice(-n);
    recent.forEach(q => callback(q.data));
  }
}

// Singleton global bus
const PRIMAT_BUS = new EventBus(15000);

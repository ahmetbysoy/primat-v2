/**
 * PRIMAT V2 - Main App
 * Orchestrates all engines + UI
 */

const state = {
  symbol: 'BTCUSDT',
  price: 0,
  prevPrice: 0,
  change24h: 0,
  connected: false,
  soundEnabled: false
};

// Engines
let manager, whale, cvd, vp, confluence, liq, arb, tradingPlan;

// Audio dopamine
const audioCtx = { enabled: false, ctx: null };
function ensureAudio() {
  if (!audioCtx.ctx) audioCtx.ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.ctx.state === 'suspended') audioCtx.ctx.resume();
}
function beep(freq=880, dur=0.12, vol=0.15, type='sine') {
  if (!state.soundEnabled) return;
  ensureAudio();
  const o = audioCtx.ctx.createOscillator();
  const g = audioCtx.ctx.createGain();
  o.type = type; o.frequency.value = freq;
  g.gain.value = vol;
  o.connect(g); g.connect(audioCtx.ctx.destination);
  o.start();
  g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.ctx.currentTime + dur);
  o.stop(audioCtx.ctx.currentTime + dur);
}
function triggerDopamine(type, amount) {
  if (type === 'whale') { beep(300,0.3,0.2,'square'); beep(600,0.15,0.15,'sine'); flashScreen(); }
  if (type === 'profit') { beep(900,0.2,0.2,'sine'); setTimeout(()=>beep(1200,0.2,0.2,'sine'),120); }
  if (type === 'arb') { beep(700,0.18,0.18,'triangle'); }
}
function flashScreen() {
  document.body.style.transition = 'background 0.1s';
  const prev = document.body.style.background;
  document.body.style.background = 'rgba(255,59,92,0.08)';
  setTimeout(()=> document.body.style.background = prev, 180);
}

// Toast - ANTI-SPAM: cooldown + dedup + max 3 visible + mobile safe
const toastState = { last: new Map(), counts: new Map() }; // key -> timestamp
function toast(title, msg, kind='', opts={}) {
  const cooldown = opts.cooldown ?? 8000; // ms same title cooldown
  const dedupWindow = opts.dedup ?? 4000;
  const key = `${kind}:${title}`;
  const now = Date.now();
  const lastTime = toastState.last.get(key) || 0;

  // Dedup: same title+msg within window -> bump counter instead of new toast
  const msgKey = `${key}:${msg}`;
  const lastMsgTime = toastState.counts.get(msgKey) || 0;
  if (now - lastMsgTime < dedupWindow) {
    // find existing toast with same title and bump count
    const stack = document.getElementById('toastStack');
    const existing = [...stack.children].find(el => el.dataset.key === key);
    if (existing) {
      const counter = existing.querySelector('.toast-count');
      if (counter) {
        const c = (parseInt(counter.textContent.replace('×','')) || 1) + 1;
        counter.textContent = `×${c}`;
        counter.style.display = 'inline-flex';
      }
      // refresh timer
      clearTimeout(existing._hideTimer);
      existing._hideTimer = setTimeout(()=> dismissToast(existing), 3500);
      // pulse
      existing.style.transform = 'scale(1.02)';
      setTimeout(()=> existing.style.transform='',150);
      toastState.counts.set(msgKey, now);
      return;
    }
  }

  // Cooldown: same kind+title too frequent -> drop
  if (now - lastTime < cooldown) return;

  toastState.last.set(key, now);
  toastState.counts.set(msgKey, now);

  const stack = document.getElementById('toastStack');
  // Enforce max visible: desktop 3, mobile 2
  const isMobile = window.innerWidth < 640;
  const maxVisible = isMobile ? 2 : 3;
  while (stack.children.length >= maxVisible) {
    stack.removeChild(stack.firstChild);
  }

  const el = document.createElement('div');
  el.dataset.key = key;
  el.className = `toast ${kind}`;
  el.innerHTML = `
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px">
      <div style="flex:1;min-width:0">
        <div style="font-weight:800;font-size:13px;display:flex;align-items:center;gap:6px">${title} <span class="toast-count" style="display:none;background:rgba(255,255,255,0.12);padding:2px 6px;border-radius:999px;font-size:10px">×2</span></div>
        <div style="font-size:12px;color:#8a94a6;margin-top:4px;line-height:1.4;word-break:break-word">${msg}</div>
      </div>
      <button onclick="this.closest('.toast').remove()" style="background:rgba(255,255,255,0.08);border:1px solid var(--border);color:var(--muted);width:24px;height:24px;border-radius:6px;cursor:pointer;flex-shrink:0;display:grid;place-items:center;font-size:12px">✕</button>
    </div>
  `;
  stack.appendChild(el);
  el._hideTimer = setTimeout(()=> dismissToast(el), isMobile ? 3000 : 4000);
  // tap to dismiss on mobile
  el.addEventListener('click', (e)=>{ if(e.target.tagName!=='BUTTON') dismissToast(el); });
}
function dismissToast(el){
  if (!el || !el.parentNode) return;
  el.style.opacity='0'; el.style.transform='translateY(8px)';
  setTimeout(()=> el.remove(),280);
}
// Global helper for manual close in toast HTML
window.dismissToast = dismissToast;

// DOM helpers
const $ = (s) => document.querySelector(s);
function formatUSD(n) {
  if (n >= 1000000) return '$' + (n/1000000).toFixed(2) + 'M';
  if (n >= 1000) return '$' + (n/1000).toFixed(2) + 'K';
  return '$' + Number(n).toFixed(2);
}
function formatPrice(p) {
  if (p >= 10000) return p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (p >= 1000) return p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (p >= 1) return p.toFixed(4);
  return p.toFixed(6);
}

// Init
window.addEventListener('DOMContentLoaded', async () => {
  // Init engines
  manager = new ExchangeManager([state.symbol], PRIMAT_BUS);
  manager.add('binance');
  manager.add('bybit');
  manager.add('okx');
  // Don't auto-connect until user hits Başlat (avoid autoplay block)
  whale = new WhaleTracker(PRIMAT_BUS);
  cvd = new CVDEngine(PRIMAT_BUS);
  vp = new VolumeProfile(PRIMAT_BUS);
  confluence = new ConfluenceEngine(PRIMAT_BUS, { symbol: state.symbol });
  liq = new LiquidationHunter(PRIMAT_BUS);
  arb = new ArbitrageScanner(PRIMAT_BUS, { pairs: ['BTCUSDT','ETHUSDT','SOLUSDT','AVAXUSDT','BNBUSDT'] });
  tradingPlan = new TradingPlanEngine(PRIMAT_BUS);

  bindEvents();
  confluence.start();
  arb.startFundingPoll();

  // Poll 24h ticker for change
  fetch24h();

  // UI loops
  setInterval(renderStats, 800);
  setInterval(fetch24h, 30000);

  // Auto-start after 600ms
  setTimeout(() => startAll(), 600);
});

function bindEvents() {
  PRIMAT_BUS.on('trade', onTrade);
  PRIMAT_BUS.on('ticker', onTicker);
  PRIMAT_BUS.on('whale:detected', onWhale);
  PRIMAT_BUS.on('whale:flow', onFlow);
  PRIMAT_BUS.on('cvd:update', onCVD);
  PRIMAT_BUS.on('cvd:divergence', onDivergence);
  PRIMAT_BUS.on('volume:profile', onVolumeProfile);
  PRIMAT_BUS.on('confluence:update', onConfluence);
  PRIMAT_BUS.on('liquidation:update', onLiquidation);
  PRIMAT_BUS.on('liquidation:alert', onLiqAlert);
  PRIMAT_BUS.on('arbitrage:update', onArbitrage);
  PRIMAT_BUS.on('arbitrage:alert', onArbAlert);
  PRIMAT_BUS.on('trading:plan', onPlan);
  PRIMAT_BUS.on('ws:status', onWsStatus);

  // Controls
  $('#btnStart').addEventListener('click', startAll);
  $('#btnStop').addEventListener('click', stopAll);
  $('#selSymbol').addEventListener('change', (e) => switchSymbol(e.target.value));
  $('#btnSound').addEventListener('click', () => {
    state.soundEnabled = !state.soundEnabled;
    $('#btnSound').textContent = state.soundEnabled ? '🔊 Ses Açık' : '🔈 Ses Kapalı';
    if (state.soundEnabled) { ensureAudio(); beep(800,0.12); }
  });
  $('#riskBalance').addEventListener('input', updateRisk);
  $('#riskPct').addEventListener('input', updateRisk);
  $('#btnGenPlan').addEventListener('click', genPlan);
  $('#customSymbol').addEventListener('keydown', (e)=>{ if(e.key==='Enter') switchSymbol(e.target.value.toUpperCase()); });
}

function startAll() {
  manager.connectAll();
  $('#btnStart').disabled = true;
  $('#btnStop').disabled = false;
  toast('🚀 PRIMAT V2 Başlatıldı', `${state.symbol} için Binance/Bybit/OKX WebSocket'leri bağlanıyor...`, '');
}

function stopAll() {
  manager.disconnectAll();
  $('#btnStart').disabled = false;
  $('#btnStop').disabled = true;
  toast('⏸️ Duraklatıldı', 'Tüm WebSocket bağlantıları kapatıldı', '');
}

function switchSymbol(sym) {
  sym = sym.toUpperCase().trim();
  if (!sym) return;
  if (!sym.endsWith('USDT')) sym += 'USDT';
  state.symbol = sym;
  $('#selSymbol').value = sym;
  $('#customSymbol').value = sym;
  $('#symLabel').textContent = sym;
  $('#chartSymbol').textContent = sym;
  // Reset engines
  whale.reset();
  cvd.reset();
  vp.trades = [];
  manager.disconnectAll();
  // Recreate manager with new symbol
  manager = new ExchangeManager([sym], PRIMAT_BUS);
  manager.add('binance');
  manager.add('bybit');
  manager.add('okx');
  manager.connectAll();
  confluence.setSymbol(sym);
  toast('🔄 Parite Değişti', `${sym} takip ediliyor`, '');
  // clear tables
  $('#whaleBody').innerHTML = '';
  $('#arbBody').innerHTML = '';
}

function updateRisk() {
  const bal = parseFloat($('#riskBalance').value) || 1000;
  const pct = parseFloat($('#riskPct').value) || 2;
  tradingPlan.setRiskParams(bal, pct);
  $('#riskLabel').textContent = `%${pct} risk • $${bal}`;
}

// === Handlers ===
function onTrade(trade) {
  if (trade.symbol !== state.symbol) return;
  state.prevPrice = state.price || trade.price;
  state.price = trade.price;

  const el = $('#livePrice');
  el.textContent = '$' + formatPrice(trade.price);
  el.className = 'price ' + (trade.price >= state.prevPrice ? 'up' : 'down');
  $('#priceTime').textContent = new Date(trade.time).toLocaleTimeString('tr-TR');
  $('#priceEx').textContent = trade.exchange;

  // sparkline-ish: update mini counter
  const dir = trade.isBuyer ? '🟢' : '🔴';
  $('#lastTrade').textContent = `${dir} ${formatPrice(trade.price)} • ${trade.volume.toFixed(5)} ${trade.symbol.replace('USDT','')} • ${trade.exchange}`;

  // profit counter easter: animate
  const counter = $('#profitCounter');
  const flow = whale.getFlowMetrics();
  const imb = flow.imbalance;
  counter.querySelector('b').textContent = (imb > 0 ? '+' : '') + imb.toFixed(2) + '% FLOW';
  counter.style.background = imb > 8 ? 'linear-gradient(135deg,#00ff88,#00d4ff)' : imb < -8 ? 'linear-gradient(135deg,#ff3b5c,#ffb020)' : 'linear-gradient(135deg,#8a94a6,#5a6478)';
}

function onTicker(t) {
  if (t.symbol !== state.symbol) return;
  // also update price if needed
}

function onWhale(ev) {
  const tr = ev;
  const cls = tr.isWhale ? 'badge-whale' : 'badge-shark';
  const label = tr.isWhale ? 'WHALE' : 'SHARK';
  const row = document.createElement('tr');
  row.innerHTML = `
    <td><span class="badge ${cls}">${label}</span></td>
    <td class="mono">${formatPrice(tr.price)}</td>
    <td>${formatUSD(tr.quoteVolume)}</td>
    <td><span class="${tr.isBuyer ? 'badge badge-long' : 'badge badge-short'}">${tr.direction}</span></td>
    <td>z${tr.zScore} • %${tr.confidence}</td>
    <td class="muted">${new Date(tr.time).toLocaleTimeString('tr-TR')}</td>
  `;
  row.style.animation = 'flash 0.6s';
  const body = $('#whaleBody');
  body.prepend(row);
  while (body.children.length > 14) body.removeChild(body.lastChild);

  $('#whaleCount').textContent = whale.whaleCount;
  triggerDopamine('whale');
  // Whale cooldown 10s, Shark 12s - avoid flood
  toast(`🐋 ${label} Tespit!`, `${tr.symbol} @ ${formatPrice(tr.price)} — ${formatUSD(tr.quoteVolume)} • ${tr.direction} • Güven %${tr.confidence}`, 'whale', { cooldown: tr.isWhale ? 10000 : 12000 });
  if (tr.isIceberg) {
    toast('🧊 Iceberg Algılandı', tr.icebergHint, 'whale', { cooldown: 15000 });
  }
}

function onFlow(flow) {
  // update flow bar
  const buyPct = flow.buyerVolume + flow.sellerVolume > 0 ? (flow.buyerVolume / (flow.buyerVolume + flow.sellerVolume) * 100) : 50;
  $('#flowBuy').style.width = buyPct.toFixed(1) + '%';
  $('#flowSell').style.width = (100 - buyPct).toFixed(1) + '%';
  $('#flowBuyLabel').textContent = 'ALIŞ ' + buyPct.toFixed(1) + '%';
  $('#flowSellLabel').textContent = 'SATIŞ ' + (100 - buyPct).toFixed(1) + '%';
  $('#flowDelta').textContent = (flow.delta > 0 ? '+' : '') + formatUSD(flow.delta);
  $('#flowImb').textContent = (flow.imbalance > 0 ? '+' : '') + flow.imbalance.toFixed(2) + '%';
  $('#flowImb').style.color = flow.imbalance > 5 ? 'var(--accent)' : flow.imbalance < -5 ? 'var(--danger)' : 'var(--muted)';
}

let cvdPoints = [];
function onCVD(ev) {
  cvdPoints.push(ev);
  if (cvdPoints.length > 120) cvdPoints.shift();
  drawCVD();
  $('#cvdVal').textContent = formatUSD(ev.cvd);
  $('#cvdDelta').textContent = (ev.delta > 0 ? '+' : '') + formatUSD(ev.delta);
  $('#cvdTrend').textContent = ev.trend.toUpperCase();
  $('#cvdTrend').className = 'badge ' + (ev.trend.includes('bull') ? 'badge-long' : ev.trend.includes('bear') ? 'badge-short' : 'badge-shark');
  $('#cvdImb').textContent = ev.deltaImbalance + '%';
}

let _lastDivAlert = 0;
function onDivergence(ev) {
  if (!ev.divergence || ev.divergence.type === 'none') return;
  const d = ev.divergence;
  // max 1 divergence toast per 20s
  if (Date.now() - _lastDivAlert < 20000) {
    // still update badge
  } else {
    _lastDivAlert = Date.now();
    toast(d.type === 'bullish' ? '📈 Bullish Divergence' : '📉 Bearish Divergence', `${d.desc} • Güç %${d.strength}`, 'whale', { cooldown: 20000 });
  }
  $('#cvdAlert').textContent = (d.type === 'bullish' ? '🟢 BULLISH DIV' : '🔴 BEARISH DIV') + ` %${d.strength}`;
  $('#cvdAlert').className = 'badge ' + (d.type === 'bullish' ? 'badge-long' : 'badge-short');
}

function onVolumeProfile(payload) {
  $('#pocVal').textContent = payload.poc ? '$' + formatPrice(payload.poc) : '-';
  $('#vahVal').textContent = payload.vah ? '$' + formatPrice(payload.vah) : '-';
  $('#valVal').textContent = payload.val ? '$' + formatPrice(payload.val) : '-';
  $('#vpBins').textContent = Object.keys(payload.profile).length + ' bins';
  // draw
  drawVolumeProfile(payload);
  // update trading plan hint
  $('#vpHint').textContent = payload.isBalanced ? 'Dengeli profil — breakout bekle' : state.price > payload.poc ? 'Fiyat POC üstünde — alıcı üstün' : 'Fiyat POC altında — satıcı üstün';
}

function onConfluence(payload) {
  $('#confScore').textContent = payload.score.toFixed(1);
  $('#confSignal').textContent = payload.signal;
  $('#confAction').textContent = payload.action;
  $('#confMeter').style.width = payload.score + '%';
  $('#confSummary').textContent = payload.summary;

  // color
  const sigEl = $('#confSignal');
  sigEl.className = 'badge ' + (payload.signal.includes('BUY') ? 'badge-long' : payload.signal.includes('SELL') ? 'badge-short' : 'badge-shark');
  if (payload.score > 70) triggerDopamine('profit');
  // details table
  const body = $('#confBody');
  body.innerHTML = '';
  for (const [iv, tf] of Object.entries(payload.details)) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><b>${iv}</b></td>
      <td class="mono">${formatPrice(tf.price)}</td>
      <td><span class="badge ${tf.emaCross==='bullish'?'badge-long':'badge-short'}">${tf.emaCross}</span></td>
      <td>${tf.rsi.toFixed(1)}</td>
      <td style="color:${tf.macdHistogram>0?'var(--accent)':'var(--danger)'}">${tf.macdHistogram.toFixed(2)}</td>
      <td>${tf.volumeRatio.toFixed(2)}x</td>
    `;
    body.appendChild(tr);
  }
}

function onLiquidation(payload) {
  $('#liqPrice').textContent = '$' + formatPrice(payload.price);
  $('#liqRisk').textContent = payload.cascadeRisk + '/100';
  $('#liqRiskMeter').style.width = payload.cascadeRisk + '%';
  $('#liqAlertLabel').textContent = payload.alert;
  $('#liqAlertLabel').className = 'badge ' + (payload.alert==='IMMINENT_SWEEP'?'badge-short':payload.alert==='BUILDING'?'badge-whale':'badge-shark');
  $('#liqClusters').textContent = payload.clusters.length + ' pool';
  // heatmap
  const wrap = $('#heatmap');
  wrap.innerHTML = '';
  payload.clusters.forEach(c => {
    const div = document.createElement('div');
    div.className = 'hm-cell ' + c.risk.toLowerCase();
    div.innerHTML = `<div style="font-weight:800" class="mono">$${formatPrice(c.price)}</div><div style="font-size:11px;color:var(--muted)">${formatUSD(c.quoteVolume)} • ${c.distance}%</div><div style="margin-top:4px"><span class="badge ${c.risk==='CRITICAL'?'badge-short':'badge-shark'}">${c.risk} • %${c.cascadeProbability}</span></div><div style="font-size:10px;color:var(--muted)">${c.side.toUpperCase()}</div>`;
    wrap.appendChild(div);
  });
  if (payload.clusters.length === 0) wrap.innerHTML = '<div class="muted" style="grid-column:1/-1;text-align:center;padding:12px">Yakında likidasyon kümelenmesi yok — market dengeli</div>';
}

let _lastLiqAlert = 0;
let _lastLiqPrice = 0;
function onLiqAlert(payload) {
  const now = Date.now();
  // Hard throttle: max 1 per 30s, and only if price moved >0.15% or risk jumped
  const priceMoved = Math.abs(payload.price - _lastLiqPrice) / payload.price > 0.0015;
  const timeOk = now - _lastLiqAlert > 30000;
  if (!timeOk && !priceMoved) return;
  // Also ignore repeated same target within 45s
  if (now - _lastLiqAlert < 45000 && Math.abs(payload.price - _lastLiqPrice) < 20) return;

  _lastLiqAlert = now;
  _lastLiqPrice = payload.price;
  if (payload.nextTarget) {
    toast('⚠️ Liquidation Süpürme Riski', `Fiyat $${formatPrice(payload.price)} — Cascade risk %${payload.cascadeRisk} • Hedef $${formatPrice(payload.nextTarget.price)}`, 'liq', { cooldown: 35000, dedup: 5000 });
  }
  beep(250,0.4,0.2,'square');
}

function onArbitrage(payload) {
  $('#arbCount').textContent = payload.count;
  $('#arbBest').textContent = payload.best ? `${payload.best.pair} %${payload.best.netProfitPct}` : '-';
  const body = $('#arbBody');
  body.innerHTML = '';
  payload.opportunities.forEach(op => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><b>${op.pair}</b></td>
      <td><span class="badge badge-shark">${op.buyExchange}</span> → <span class="badge badge-long">${op.sellExchange}</span></td>
      <td class="mono">${formatPrice(op.buyPrice)} → ${formatPrice(op.sellPrice)}</td>
      <td style="color:var(--accent)">%${op.netProfitPct}</td>
      <td class="muted">${op.volume ? op.volume.toFixed(4) : '-'}</td>
    `;
    body.appendChild(tr);
  });
  if (payload.opportunities.length === 0) {
    body.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:14px">Şu an karlı cross-exchange fırsat yok — spread < 0.15%</td></tr>`;
  }
  // triangular
  const tri = $('#triBody');
  tri.innerHTML = '';
  if (payload.triangular.length === 0) tri.innerHTML = `<div class="muted" style="text-align:center;padding:8px;font-size:12px">Triangular fırsat yok</div>`;
  else payload.triangular.forEach(t=> {
    const d=document.createElement('div');d.className='row';d.innerHTML=`<span class="badge badge-long">${t.exchange}</span><span class="mono" style="font-size:12px">${t.path} — net %${t.netPct} ($${t.start} → $${t.end})</span>`;tri.appendChild(d);
  });
}

let _lastArbAlert = 0;
function onArbAlert(best) {
  if (Date.now() - _lastArbAlert < 25000) return;
  _lastArbAlert = Date.now();
  triggerDopamine('arb');
  toast('💸 Arbitraj Fırsatı', `${best.pair} ${best.buyExchange}→${best.sellExchange} net %${best.netProfitPct} spread`, 'arb', { cooldown: 25000 });
}

function onPlan(plan) {
  $('#planSymbol').textContent = plan.symbol;
  $('#planDir').textContent = plan.direction;
  $('#planDir').className = 'badge ' + (plan.direction==='LONG'?'badge-long':'badge-short');
  $('#planEntry').textContent = '$' + formatPrice(plan.entry);
  $('#planZone').textContent = `$${formatPrice(plan.entryZone.low)} — $${formatPrice(plan.entryZone.high)}`;
  $('#planSL').textContent = '$' + formatPrice(plan.stopLoss);
  $('#planTP1').textContent = '$' + formatPrice(plan.takeProfit1);
  $('#planTP2').textContent = '$' + formatPrice(plan.takeProfit2);
  $('#planTP3').textContent = '$' + formatPrice(plan.takeProfit3);
  $('#planLev').textContent = plan.leverage + 'x';
  $('#planMargin').textContent = formatUSD(plan.marginRequired);
  $('#planSize').textContent = plan.positionSize + ' ' + plan.symbol.replace('USDT','');
  $('#planRR').textContent = '1:' + plan.riskReward1;
  $('#planNotes').innerHTML = plan.notes.map(n=>`<li>${n}</li>`).join('');
  $('#planInvalid').textContent = plan.invalidation;
  $('#planBox').classList.remove('hidden');
  $('#planBox').scrollIntoView({ behavior:'smooth', block:'nearest' });
}

function onWsStatus(s) {
  const map = { binance: '#stBinance', bybit: '#stBybit', okx: '#stOkx' };
  const el = document.querySelector(map[s.exchange]);
  if (!el) return;
  const dot = el.querySelector('.dot');
  const txt = el.querySelector('span');
  if (s.status === 'connected') { dot.className='dot on'; txt.textContent = s.exchange + ' ●'; }
  else if (s.status === 'connecting') { dot.className='dot'; dot.style.background='#ffb020'; txt.textContent = s.exchange + ' …'; }
  else { dot.className='dot off'; txt.textContent = s.exchange + ' ✕'; }
}

async function genPlan() {
  const bal = parseFloat($('#riskBalance').value) || 1000;
  const pct = parseFloat($('#riskPct').value) || 2;
  tradingPlan.setRiskParams(bal, pct);
  // Build signal from confluence + whale + price
  const price = state.price || 65000;
  const conf = confluence.score;
  let direction = conf > 55 ? 'LONG' : conf < 45 ? 'SHORT' : (whale.getFlowMetrics().imbalance > 0 ? 'LONG' : 'SHORT');
  // User override
  const selDir = $('#planDirSelect').value;
  if (selDir !== 'AUTO') direction = selDir;

  const signal = {
    direction,
    entryPrice: price,
    confidence: conf,
    confluenceScore: conf,
    atr: null,
    whaleFlow: whale.getFlowMetrics(),
    divergence: cvd.getCurrent().divergence,
    volumeProfile: { poc: vp.poc, vah: vp.vah, val: vp.val }
  };
  try {
    $('#btnGenPlan').textContent = 'Hesaplanıyor…';
    $('#btnGenPlan').disabled = true;
    const plan = await tradingPlan.generate(signal, state.symbol);
    toast(`📋 Trading Plan: ${plan.direction}`, `${plan.symbol} Entry $${formatPrice(plan.entry)} • SL $${formatPrice(plan.stopLoss)} • TP1 $${formatPrice(plan.takeProfit1)} • ${plan.leverage}x`, '');
    triggerDopamine('profit');
  } catch (e) {
    toast('Hata', e.message, 'whale');
  } finally {
    $('#btnGenPlan').textContent = '⚡ Plan Oluştur';
    $('#btnGenPlan').disabled = false;
  }
}

async function fetch24h() {
  try {
    const res = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${state.symbol}`);
    if (!res.ok) return;
    const j = await res.json();
    const chg = parseFloat(j.priceChangePercent);
    state.change24h = chg;
    const el = $('#chg24');
    el.textContent = (chg > 0 ? '+' : '') + chg.toFixed(2) + '%';
    el.className = 'chg ' + (chg >= 0 ? 'up' : 'down');
    $('#high24').textContent = '$' + formatPrice(parseFloat(j.highPrice));
    $('#low24').textContent = '$' + formatPrice(parseFloat(j.lowPrice));
    $('#vol24').textContent = formatUSD(parseFloat(j.quoteVolume));
  } catch {}
}

function renderStats() {
  const s = PRIMAT_BUS.getStats();
  $('#busStats').textContent = `${s.published} events • ${s.delivered} delivered • queue ${s.queueSize}`;
  const wsStats = manager ? manager.getStatus() : {};
  $('#wsStats').textContent = Object.entries(wsStats).map(([k,v])=> `${k}:${v}`).join(' • ');
}

// Canvas drawings - simple
function drawCVD() {
  const canvas = $('#cvdCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr,dpr);
  const W = rect.width, H = rect.height;
  ctx.clearRect(0,0,W,H);
  if (cvdPoints.length < 2) return;
  const cvds = cvdPoints.map(p=>p.cvd);
  const min = Math.min(...cvds), max = Math.max(...cvds);
  const range = max - min || 1;
  ctx.strokeStyle = '#00ff88';
  ctx.lineWidth = 2;
  ctx.beginPath();
  cvdPoints.forEach((p,i)=>{
    const x = (i/(cvdPoints.length-1))*W;
    const y = H - ((p.cvd - min)/range)*H*0.8 - H*0.1;
    if (i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
  });
  ctx.stroke();
  // gradient fill
  const grad = ctx.createLinearGradient(0,0,0,H);
  grad.addColorStop(0,'rgba(0,255,136,0.18)');
  grad.addColorStop(1,'rgba(0,255,136,0)');
  ctx.lineTo(W,H); ctx.lineTo(0,H); ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();

  // price overlay (light)
  const prices = cvdPoints.map(p=>p.price);
  const pMin=Math.min(...prices), pMax=Math.max(...prices);
  const pRange=pMax-pMin||1;
  ctx.strokeStyle='rgba(0,212,255,0.6)';
  ctx.lineWidth=1.2;
  ctx.beginPath();
  cvdPoints.forEach((p,i)=>{
    const x=(i/(cvdPoints.length-1))*W;
    const y=H - ((p.price-pMin)/pRange)*H*0.6 - H*0.2;
    if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
  });
  ctx.stroke();
}

function drawVolumeProfile(payload) {
  const wrap = $('#vpBars');
  wrap.innerHTML = '';
  if (!payload.bins || payload.bins.length===0) return;
  const maxVol = Math.max(...payload.bins.map(b=>b[1]));
  payload.bins.forEach(([priceStr, vol]) => {
    const price = parseFloat(priceStr);
    const h = Math.max(6, (vol/maxVol)*100);
    const bar = document.createElement('div');
    bar.className = 'vbar ' + (Math.abs(price - payload.poc) < payload.binSize ? 'poc bid' : price > state.price ? 'ask' : 'bid');
    bar.style.height = h + '%';
    bar.title = `$${formatPrice(price)} — ${formatUSD(vol)}`;
    wrap.appendChild(bar);
  });
}

// Lightweight chart via canvas (real price history from trades)
let priceHistory = [];
PRIMAT_BUS.on('trade', (t)=>{
  if (t.symbol!==state.symbol) return;
  priceHistory.push({ time:t.time, price:t.price });
  if (priceHistory.length>180) priceHistory.shift();
  drawPriceChart();
});
function drawPriceChart(){
  const canvas = $('#priceCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio||1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr,dpr);
  const W=rect.width,H=rect.height;
  ctx.clearRect(0,0,W,H);
  // grid
  ctx.strokeStyle='rgba(30,42,69,0.35)'; ctx.lineWidth=1;
  for(let i=0;i<4;i++){ const y=(H/4)*i; ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke(); }
  if(priceHistory.length<2) return;
  const prices=priceHistory.map(p=>p.price);
  const min=Math.min(...prices), max=Math.max(...prices);
  const range=max-min||1;
  ctx.strokeStyle='#00d4ff'; ctx.lineWidth=2; ctx.beginPath();
  priceHistory.forEach((p,i)=>{
    const x=(i/(priceHistory.length-1))*W;
    const y=H - ((p.price-min)/range)*H*0.8 - H*0.1;
    if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
  });
  ctx.stroke();
  // fill
  const grad=ctx.createLinearGradient(0,0,0,H);
  grad.addColorStop(0,'rgba(0,212,255,0.22)'); grad.addColorStop(1,'rgba(0,212,255,0)');
  ctx.lineTo(W,H); ctx.lineTo(0,H); ctx.closePath(); ctx.fillStyle=grad; ctx.fill();
}

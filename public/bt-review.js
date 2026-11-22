/* ===================== 回测复盘 · 逻辑 =====================
   图表不再是独立复刻品：直接复用看盘页那套图表本体，另建一个实例。
   四副图、自绘十字线、图例、手势、缩放档位因此天然与看盘页一致，
   买卖点作为标记叠加在同一张图上，不会出现「两边画法不一样」的错位。 */
(function(){
  const FEE = 0.13;                       // 单边合计费用估算（%）
  const MODE_TXT = { next_open:'次日开盘卖', next_close:'次日收盘卖', mid:'等回当日中间价卖' };
  const KS = [0.6, 0.8, 1.0, 1.2];
  const MODES = ['next_open', 'next_close', 'mid'];
  // 复盘池：与最初做日内回测时用的 8 只票一致，行情统一走服务端日线接口。
  const STOCKS = [
    { code:'sh600000', name:'浦发银行' }, { code:'sh600519', name:'贵州茅台' },
    { code:'sh601318', name:'中国平安' }, { code:'sz000001', name:'平安银行' },
    { code:'sz000858', name:'五粮液' },   { code:'sz002594', name:'比亚迪' },
    { code:'sz300059', name:'东方财富' }, { code:'sz300750', name:'宁德时代' },
  ];

  const el = id => document.getElementById(id);
  const $stock = el('s-stock'), $k = el('s-k'), $mode = el('s-mode'), $span = el('s-span');
  if (!$stock || !el('rv-canvas')) return;   // 页面上没有复盘结构就不启动

  let chart = null;            // 看盘图表本体的第二个实例
  let klines = [];             // 当前票的日线（由图表实例提供，与服务端同一份）
  let trades = [];             // 当前口径下的成交（索引即 klines 下标）
  let lastSv = -1, lastEv = -1;
  let started = false;

  const fmt = (v, n) => (v == null || !isFinite(v)) ? '—' : v.toFixed(n == null ? 2 : n);
  const cls = v => v > 0 ? 'pos' : (v < 0 ? 'neg' : '');
  const fmtPct = v => v == null ? '' : (v > 0 ? '+' : '') + v.toFixed(2) + '%';

  /* ---------- 统计 ---------- */
  function stats(list){
    if (!list.length) return null;
    let win = 0, sum = 0, gw = 0, gl = 0;
    for (const t of list){
      const r = t.ret; sum += r;
      if (r > 0){ win++; gw += r; } else { gl += r; }
    }
    const n = list.length, nw = win, nl = n - nw;
    return {
      n, win: win / n * 100,
      aw: nw ? gw / nw : 0,
      al: nl ? gl / nl : 0,
      pf: (nl && gl !== 0) ? (gw / Math.abs(gl)) : Infinity,
      avg: sum / n,
      net: sum / n - FEE,
      // 每笔固定 1 万元：收益百分点 ×100 元，并扣掉每笔费用
      pnl: (sum - FEE * n) * 100
    };
  }

  function renderStats(list){
    const s = stats(list || []);
    const box = el('rv-stats');
    if (!s){ box.innerHTML = '<div class="rv-card"><div class="k">当前视野无成交</div><div class="v">—</div></div>'; return; }
    const card = (k, v, c) => `<div class="rv-card"><div class="k">${k}</div><div class="v ${c||''}">${v}</div></div>`;
    box.innerHTML = [
      card('成交笔数', s.n),
      card('胜率', fmt(s.win,1) + '%'),
      card('均盈', '+' + fmt(s.aw) + '%', 'pos'),
      card('均亏', fmt(s.al) + '%', 'neg'),
      card('盈亏比', isFinite(s.pf) ? fmt(s.pf) : '∞', s.pf >= 1 ? 'pos' : 'neg'),
      card('每笔毛收益', (s.avg>0?'+':'') + fmt(s.avg,3) + '%', cls(s.avg)),
      card('扣费后每笔', (s.net>0?'+':'') + fmt(s.net,3) + '%', cls(s.net)),
      card('累计盈亏(1万/笔)', (s.pnl>0?'+':'') + Math.round(s.pnl).toLocaleString() + ' 元', cls(s.pnl)),
    ].join('');
  }

  /* ---------- 买卖点重算（5 分钟口径） ----------
     图上画的是 5 分钟 K 线，所以买卖点也必须在同一份 5 分钟数据上算，否则标点会错位。
     做法：先把 5 分钟序列按「交易日」归拢成日线级别的开高低收，用它算两条日级指标
     （5 日均线、60 日平均振幅），再用 5 分钟逐根去判断「当天有没有跌到买入价」、
     「次日哪一根卖掉」。指标看日级、成交看分钟级，这是原有规则的最小移植。 */
  function groupDays(bars){
    const days = [];
    let cur = null;
    for (let i = 0; i < bars.length; i++){
      const b = bars[i];
      if (!cur || cur.date !== b.date){
        cur = { date: b.date, s: i, e: i, o: b.o, h: b.h, l: b.l, c: b.c };
        days.push(cur);
      } else {
        cur.e = i;
        if (b.h > cur.h) cur.h = b.h;
        if (b.l < cur.l) cur.l = b.l;
        cur.c = b.c;
      }
    }
    return days;
  }

  function computeTrades(){
    const bars = klines;
    const n = bars.length;
    trades = [];
    const days = groupDays(bars);
    const dn = days.length;
    if (dn < 70) return;

    const amp1 = new Array(dn).fill(null);
    for (let i = 1; i < dn; i++){
      const pc = days[i-1].c;
      if (pc > 0) amp1[i] = (days[i].h - days[i].l) / pc;
    }
    const ma5 = new Array(dn).fill(null);
    for (let i = 4; i < dn; i++){
      let s = 0;
      for (let j = i - 4; j <= i; j++) s += days[j].c;
      ma5[i] = s / 5;
    }
    const amp60 = new Array(dn).fill(null);
    for (let i = 60; i < dn; i++){
      let s = 0, c = 0;
      for (let j = i - 59; j <= i; j++){ if (amp1[j] != null){ s += amp1[j]; c++; } }
      if (c >= 40) amp60[i] = s / c;
    }

    const k = Number($k.value) || 1;
    const mode = $mode.value || 'next_close';
    for (let i = 62; i < dn - 1; i++){
      if (ma5[i-1] == null || days[i-1].c <= ma5[i-1]) continue;
      const a = amp60[i];
      if (!a || a <= 0) continue;
      const pc = days[i-1].c;
      const trig = pc * (1 - k * a);
      // 当天逐根 5 分钟找成交：第一根最低价跌到买入价就按买入价成交
      let bi = -1;
      for (let j = days[i].s; j <= days[i].e; j++){
        if (bars[j].l <= trig){ bi = j; break; }
      }
      if (bi < 0) continue;
      const buy = trig;
      const nd = days[i+1];
      const mid = (days[i].h + days[i].l) / 2;
      let si = -1, sell = null;
      if (mode === 'next_open'){ si = nd.s; sell = bars[nd.s].o; }
      else if (mode === 'next_close'){ si = nd.e; sell = bars[nd.e].c; }
      else {
        for (let j = nd.s; j <= nd.e; j++){
          if (bars[j].h >= mid){ si = j; sell = mid; break; }
        }
        if (si < 0){ si = nd.e; sell = bars[nd.e].c; }
      }
      if (si <= bi || sell == null) continue;
      trades.push({ bi, si, buy, sell, ret: (sell / buy - 1) * 100 });
    }
  }

  const barKey = (b) => (b && b.time) ? `${b.date} ${b.time}` : ((b && b.date) || '');
  const barLabel = (b) => {
    if (!b) return '—';
    const s = barKey(b);
    return s.length > 10 ? s.slice(5, 10) + ' ' + s.slice(11) : s;
  };

  /* ---------- 标记 ---------- */
  function buildMarks(sv, ev){
    const out = [];
    for (const t of trades){
      if (t.bi < sv || t.bi > ev) continue;
      // 买点贴在成交那根 5 分钟 K 线的下方、卖点贴在卖出那根的上方，符号不压住 K 线实体
      const bb = klines[t.bi], sb = klines[t.si];
      out.push({ key: barKey(bb), y: bb.l, kind:'buy', text: fmt(t.buy) });
      if (sb) out.push({ key: barKey(sb), y: sb.h, kind:'sell', text: fmt(t.sell) });
    }
    return out;
  }

  /* ---------- 视野联动 ---------- */
  function syncView(force){
    if (!chart || !klines.length) return;
    const r = chart.range();
    if (!r) return;
    if (!force && r.sv === lastSv && r.ev === lastEv) return;
    lastSv = r.sv; lastEv = r.ev;
    const inView = trades.filter(t => t.bi >= r.sv && t.bi <= r.ev);
    renderStats(inView);
    renderRows(inView);
    // setMarks 会整图重画并还原缩放窗口，随之再触发一次缩放回调，
    // 上面的「窗口没变就直接返回」把这一次回环挡掉，不会来回震荡。
    chart.setMarks(buildMarks(r.sv, r.ev));
  }

  /* ---------- 明细表 ---------- */
  function renderRows(inView){
    const list = inView.slice().reverse();
    el('rv-cnt').textContent = list.length;
    el('rv-empty').hidden = list.length > 0;
    el('rv-rows').innerHTML = list.slice(0, 1200).map(t => {
      const bd = barLabel(klines[t.bi]), sd = barLabel(klines[t.si]);
      const net = t.ret - FEE;
      return `<tr data-i="${t.bi}"><td class="d">${bd}</td><td class="d">${sd}</td>` +
        `<td>${fmt(t.buy)}</td><td>${fmt(t.sell)}</td>` +
        `<td class="${cls(t.ret)}">${fmtPct(t.ret)}</td>` +
        `<td class="${cls(net)}">${fmtPct(net)}</td></tr>`;
    }).join('');
  }

  /* ---------- 取数 ---------- */
  async function loadStock(code, name){
    const box = el('rv-canvas');
    box.style.opacity = '.45';
    try {
      await chart.open(code, name);
      klines = chart.klines() || [];
      computeTrades();
      applySpan();
      lastSv = -1; lastEv = -1;
      syncView(true);
    } catch (e){
      el('rv-stats').innerHTML = '<div class="rv-card"><div class="k">数据加载失败</div><div class="v">—</div></div>';
      console.error(e);
    } finally {
      box.style.opacity = '1';
    }
  }

  function applySpan(){
    if (!klines.length) return;
    let span = Number($span.value);
    if (!span || span <= 0) span = klines.length;
    span = Math.min(span, klines.length);
    chart.gotoDate(barKey(klines[klines.length - 1]), span);
  }

  function refreshTrades(){
    if (!klines.length) return;
    computeTrades();
    lastSv = -1; lastEv = -1;
    syncView(true);
  }

  /* ---------- 启动 ---------- */
  $stock.innerHTML = STOCKS.map(s => `<option value="${s.code}">${s.name} ${s.code.slice(2)}</option>`).join('');
  $k.innerHTML = KS.map(v => `<option value="${v}">${v} 倍振幅</option>`).join('');
  $k.value = '1';
  $mode.innerHTML = MODES.map(m => `<option value="${m}">${MODE_TXT[m] || m}</option>`).join('');
  $mode.value = 'next_close';

  // 第二个实例：默认行为全关掉，只保留画图与手势。
  chart = window.TdxChartCreate({
    emitSwitch: false,       // 复盘页只有一只票，不抛换股事件
    offlineEl: null,         // 不按 id 去找看盘页的离线提示条
    period: 'min5',          // 复盘用 5 分钟 K 线
    adjust: 'qfq',
    dayBars: 3000,
    weekBars: 1200,
    min5Bars: 20000,         // 服务端 5 分钟单次上限，约 1.6 年
    maxSpan: 20000,          // 允许缩到「全程」而不是看盘页的 260 根
    visibleBars: 3000,       // 默认露出约 3 个月（每月约 1000 根）
    onZoom: () => syncView(),
  });
  chart.init({ canvas: el('rv-canvas'), quote: el('rv-quote'), nameEl: null, offlineEl: null });

  el('rv-rows').addEventListener('click', e => {
    const tr = e.target.closest('tr');
    if (!tr || !chart || !klines.length) return;
    document.querySelectorAll('#rv-rows tr.on').forEach(x => x.classList.remove('on'));
    tr.classList.add('on');
    const i = Number(tr.dataset.i);
    let span = Number($span.value);
    if (!span || span <= 0) span = 1000;
    chart.gotoDate(barKey(klines[i]), span);
    lastSv = -1; lastEv = -1;
    syncView(true);
  });

  $stock.addEventListener('change', () => {
    const s = STOCKS.find(x => x.code === $stock.value) || STOCKS[0];
    loadStock(s.code, s.name);
  });
  $k.addEventListener('change', refreshTrades);
  $mode.addEventListener('change', refreshTrades);
  $span.addEventListener('change', () => {
    applySpan();
    lastSv = -1; lastEv = -1;
    syncView(true);
  });

  loadStock(STOCKS[0].code, STOCKS[0].name);

  /* 页签按需激活：面板隐藏时容器高度为 0，画布会画成空条，
     所以切到复盘时必须重新校准尺寸。 */
  function matchWatchHeight(){
    // 直接量看盘页那块画布的真实高度照抄过来，做到「复盘页和看盘页一样高」。
    // 看盘抽屉平时是 visibility:hidden（仍参与布局），所以能直接量到高度。
    const src = el('chart-canvas');
    const h = src && src.clientHeight;
    const box = el('rv-canvas');
    if (!box) return;
    const target = (h && h > 200) ? h : 631;
    if (Math.abs(box.clientHeight - target) > 2) box.style.height = target + 'px';
  }
  window.RVShow = function(){
    started = true;
    if (!chart) return;
    requestAnimationFrame(() => {
      matchWatchHeight();
      chart.resize();
      lastSv = -1; lastEv = -1;
      syncView(true);
    });
  };
  window.addEventListener('resize', () => { if (started) matchWatchHeight(); });
  window.RVStarted = () => started;
})();

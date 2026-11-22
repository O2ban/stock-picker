/* 看盘模块：通达信风格 K 线 + 成交量 + MACD。
 * 设计要点：
 *  - panels 配置数组驱动网格；加指标只往数组塞一项 + 一个 compute，不动绘图内核。
 *  - 十字线自绘（zrender），遍历所有 panel 网格绘制；单击锁定 / 再点取消。
 *  - MA / MACD 全部前端计算，后端只给 OHLCV。
 *  - 双画布：mainPane 显示当前股票（可交互），previewPane 预渲染相邻股票；
 *    副图左右滑时两幅图一起跟手位移，新票的图形随手指滑入，松手即换股。
 */
(function () {
  'use strict';

  const UP = '#E0184B', DOWN = '#00A848';
  const SURGE_PCT = 9.5;               // 涨幅超过该值（%）的 K 线加金色描边
  const SURGE_COLOR = '#FFC53D';
  const MA_COLORS = { ma5: '#e8a33d', ma10: '#3d7ee8', ma20: '#b44fd0', ma60: '#20a4a4' };
  const API_BASE = location.pathname.startsWith('/stock-picker') ? '/stock-picker' : '';
  const KL_BASE = API_BASE + '/api/kline';
  const KL_BATCH_BASE = API_BASE + '/api/klines';

  // ---------- K 线缓存（三天有效，跨刷新保留）----------
  // 选股结果出来后批量预取命中股票，点击时直接命中缓存秒开；
  // 只有缓存缺失或超过三天才回后端重新拉取。
  const CACHE_TTL = 3 * 24 * 60 * 60 * 1000;
  const memCache = new Map();          // key -> { payload, ts }
  const pendingLoads = new Map();      // key -> Promise，合并同 key 并发请求
  let loadToken = 0;                   // 主图加载序号：快速换股/切周期时丢弃过期结果
  let tlToken = 0;                     // 分时校准序号：独立于 loadToken，避免与换股加载互踩

  const idb = (() => {
    let dbp = null;
    function openDb() {
      if (dbp) return dbp;
      dbp = new Promise((resolve) => {
        if (!window.indexedDB) { resolve(null); return; }
        try {
          const req = indexedDB.open('sp-kline-cache', 2);
          // 版本 2 新增 snap 库：存行情快照与分时曲线，供断网时回看。
          // 旧用户是从版本 1 升上来的，那时只有 kline 库，所以两个库都要按存在与否分别创建。
          req.onupgradeneeded = () => {
            const d = req.result;
            if (!d.objectStoreNames.contains('kline')) d.createObjectStore('kline');
            if (!d.objectStoreNames.contains('snap')) d.createObjectStore('snap');
          };
          req.onsuccess = () => resolve(req.result);
          // 升级被旧的页面占用而卡住时不能干等：一直 pending 会让断网时读本地留存全部挂死，
          // 表现为"明明存过数据却一片空白"。这里直接放行（当次返回空），下次调用再重新尝试打开。
          req.onblocked = () => { dbp = null; resolve(null); };
          req.onerror = () => resolve(null);
        } catch { resolve(null); }
      });
      return dbp;
    }
    async function get(key) {
      const db = await openDb(); if (!db) return null;
      return new Promise((resolve) => {
        try {
          const r = db.transaction('kline', 'readonly').objectStore('kline').get(key);
          r.onsuccess = () => resolve(r.result || null);
          r.onerror = () => resolve(null);
        } catch { resolve(null); }
      });
    }
    async function put(key, val) {
      const db = await openDb(); if (!db) return;
      try { db.transaction('kline', 'readwrite').objectStore('kline').put(val, key); } catch { /* 忽略 */ }
    }
    // snap 库：行情快照与分时曲线，断网时从这里取最近一次的完整留存。
    async function getSnap(key) {
      const db = await openDb(); if (!db) return null;
      return new Promise((resolve) => {
        try {
          const r = db.transaction('snap', 'readonly').objectStore('snap').get(key);
          r.onsuccess = () => resolve(r.result || null);
          r.onerror = () => resolve(null);
        } catch { resolve(null); }
      });
    }
    async function putSnap(key, val) {
      const db = await openDb(); if (!db) return;
      try { db.transaction('snap', 'readwrite').objectStore('snap').put(val, key); } catch { /* 忽略 */ }
    }
    return { get, put, getSnap, putSnap };
  })();

  const cacheKey = (code, period, adjust) => `${code}|${period}|${adjust}`;

  // stale=true 时忽略有效期：断网了没有新数据可拿，过期的旧 K 线也比空白图强。
  async function readCache(key, opts) {
    const now = Date.now();
    const stale = !!(opts && opts.stale);
    const mem = memCache.get(key);
    if (mem && (stale || now - mem.ts < CACHE_TTL)) return mem.payload;
    if (!stale && mem) memCache.delete(key);
    const rec = await idb.get(key);
    if (rec && (stale || now - rec.ts < CACHE_TTL)) {
      memCache.set(key, rec);
      return rec.payload;
    }
    return null;
  }
  function writeCache(key, payload) {
    const rec = { payload, ts: Date.now() };
    memCache.set(key, rec);
    idb.put(key, rec);
  }

  // 取 K 线：命中缓存直接返回，否则请求后端并写入缓存。返回 { name, klines }。
  async function fetchKlines(code, period, adjust, bars, opts) {
    const key = cacheKey(code, period, adjust);
    // fresh=true 表示跳过本地缓存、强制回源：eltdx 每个交易日 15:45 才落库，
    // 而本地缓存 TTL 是 3 天，看盘主图只读缓存会一直停在上一交易日。
    if (!(opts && opts.fresh)) {
      const cached = await readCache(key);
      if (cached) return cached;
    }
    if (pendingLoads.has(key)) return pendingLoads.get(key);
    const p = (async () => {
      const url = `${KL_BASE}?code=${encodeURIComponent(code)}&period=${period}` +
        `&adjust=${adjust}&bars=${bars}`;
      let data = null;
      try {
        const res = await fetch(url);
        data = await res.json().catch(() => ({}));
        if (!res.ok) {
          // 后端明确回错了（500/404 之类）不当成断网，照常把错误抛出去，
          // 否则服务端出故障会被一份旧数据悄悄盖住，谁都发现不了。
          const e = new Error(data.error || `加载失败 (${res.status})`);
          e.httpStatus = res.status;
          throw e;
        }
      } catch (err) {
        if (err && err.httpStatus) throw err;
        // 真的断网（请求发不出去）时，有效期过了的旧 K 线也照旧拿出来用：
        // 通达信断网时同样能翻已经下载过的历史，比一片空白强。
        const stale = await readCache(key, { stale: true });
        if (stale && stale.klines && stale.klines.length) {
          // 时间戳要问持久层要：内存层可能已经按 TTL 清掉了，拿不到就会显示空日期。
          const rec = await idb.get(key);
          return Object.assign({}, stale, { cached: true, staleTs: (rec && rec.ts) || 0 });
        }
        throw err;
      }
      const payload = { name: data.name || '', klines: data.klines || [] };
      writeCache(key, payload);
      return payload;
    })();
    pendingLoads.set(key, p);
    try { return await p; } finally { pendingLoads.delete(key); }
  }

  // 把一笔实时行情并入 state.klines 的最后一根（或在日期更新时补一根）。返回是否发生改动。
  // 日线视图专用：周/月线是按周期聚合出来的柱，拿日线行情去改会把整根聚合柱算坏（MA、MACD、VOL 全错）。
  // 后复权序列的相对价格被整体放大，与行情原始现价不同量纲，混进去会把最后一根画到天上。
  function mergeQuoteIntoSeries(q) {
    if (!q || !state.klines || !state.klines.length) return false;
    let appended = false;
    if (q.suspended || q.price == null) return false;
    if (state.period !== 'day' || state.adjust === 'hfq') return false;
    const last = state.klines[state.klines.length - 1];
    const price = Number(q.price);
    if (!isFinite(price) || price <= 0) return false;
    // 集合竞价刚结束、停牌复牌瞬间，open/high/low 可能是 0，不能当成真实价位用；
    // 成交量 0 表示这一笔还没成交，绝不回退成上一交易日的全天量（那会把量柱画成假柱）。
    const pos = (v) => (v != null && isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);
    const open = pos(q.open), high = pos(q.high), low = pos(q.low);
    const sameDay = (q.date || last.date) === last.date;
    const bar = {
      date: q.date || last.date,
      o: open != null ? open : (sameDay ? last.o : price),
      h: high != null ? Math.max(high, price) : price,
      l: low != null ? Math.min(low, price) : price,
      c: price,
      vol: Number(q.vol) > 0 ? Number(q.vol) : (sameDay ? last.vol : 0),
      amount: Number(q.amount) > 0 ? Number(q.amount) : (sameDay ? last.amount : 0),
    };
    if (bar.date === last.date) {
      state.klines[state.klines.length - 1] = bar;
    } else if (bar.date > last.date) {
      state.klines.push(bar);
      appended = true;
    } else {
      return false; // 行情日期早于最后一根，忽略，避免把历史改坏
    }
    state.maCache = {}; state.macd = null; state.volMa5 = null; state.amp = null;
    // 返回 'append' 表示新补了一根（跨日），调用方据此把 x 轴与可视窗口一起往前推
    return appended ? 'append' : 'replace';
  }

  // 把一份 K 线载荷写入图表状态并重绘（供主图首屏与回源结果共用）。
  function applyPayload(payload) {
    // 浅拷贝一层：state.klines 随后会被 mergeQuoteIntoSeries 原地替换/追加当日实时 bar。
    // 若直接引用 payload.klines，实时 bar 就写进了 memCache / IndexedDB 里的同一个数组，
    // 等于把盘中残价污染进缓存 —— 之后回源失败或离线重开就会画出一根假的当日 K 线。
    state.klines = (payload.klines || []).slice();
    state.name = payload.name || state.name;
    // 记住这份数据是不是断网时从本地留存里翻出来的，行情条上要据此提示
    state.srcCached = !!payload.cached;
    state.cacheTs = payload.cached ? (payload.staleTs || 0) : 0;
    if (els.nameEl) els.nameEl.textContent = state.name || '';
    state.currentIdx = -1;
    state.maCache = {}; state.macd = null; state.volMa5 = null; state.amp = null;
    // 回源/切周期会整段替换 K 线，缓存里没有当日这根，要把已知的实时价重新叠回去，
    // 否则每次切周期、每次强制回源都会退回「最后一根是昨天」，价格和图形又对不上了。
    if (state.quote) mergeQuoteIntoSeries(state.quote);
    render();
  }

  // ---------- 指标计算 ----------
  function sma(values, n, i) {
    if (i < n - 1) return null;
    let s = 0;
    for (let k = i - n + 1; k <= i; k++) s += values[k];
    return s / n;
  }
  function emaSeries(values, n) {
    const k = 2 / (n + 1);
    const out = new Array(values.length).fill(null);
    let prev = null;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v == null) { out[i] = prev; continue; }
      prev = prev == null ? v : v * k + prev * (1 - k);
      out[i] = prev;
    }
    return out;
  }
  function calcMA(rows, n) {
    const closes = rows.map(r => r.c);
    return rows.map((_, i) => sma(closes, n, i));
  }
  // MACD(12,26,9)：DIF=EMA12-EMA26，DEA=EMA9(DIF)，柱=2*(DIF-DEA)
  function calcMACD(rows, fast = 12, slow = 26, signal = 9) {
    const closes = rows.map(r => r.c);
    const ef = emaSeries(closes, fast);
    const es = emaSeries(closes, slow);
    const dif = closes.map((_, i) => (ef[i] == null || es[i] == null) ? null : ef[i] - es[i]);
    const dea = emaSeries(dif, signal);
    const hist = dif.map((v, i) => (v == null || dea[i] == null) ? null : 2 * (v - dea[i]));
    return { dif, dea, hist };
  }
  // 振幅（百分比口径，与行情软件一致）：
  //   高 = H/REF(C,1)*100-100   低 = L/REF(C,1)*100-100   日振幅 = 高 - 低
  // 也就是「当日最高相对昨收涨几个点」减去「当日最低相对昨收跌几个点」，
  // 结果就是当天上下的总波动幅度（百分数）。首根没有前收，留空。
  // PJ 为振幅的 100 日均线（公式里的 DOTLINE 虚线），用来看当前波动是否偏离常态。
  function calcAmp(rows, n = 100) {
    const amp = rows.map((r, i) => {
      const prevC = i > 0 ? rows[i - 1].c : null;
      if (!prevC || prevC <= 0) return null;
      const high = r.h / prevC * 100 - 100;
      const low = r.l / prevC * 100 - 100;
      return high - low;
    });
    const pj = rows.map((_, i) => sma(amp, n, i));
    return { amp, pj };
  }

  // ---------- panel 配置：要加副图就在这里加一项 ----------
  // weight 决定网格高度占比；compute 返回该 panel 的 series 片段。
  const PANELS = [
    { id: 'candle', weight: 6, kind: 'candle' },
    { id: 'vol', weight: 2, kind: 'volume' },
    { id: 'macd', weight: 2, kind: 'macd', compute: calcMACD },
    // 振幅副图：当日上下总波动（%），0/5/10 三条参考线 + 100 日振幅均线（虚线）
    { id: 'amp', weight: 2, kind: 'amp', compute: calcAmp },
  ];
  // 分时图三个 panel：价格 + 每分钟量 + 量比曲线。
  // 没有 MACD（分时上算 MACD 没有意义，242 个点的分钟序列算出来的指标也没人看）。
  const TIMELINE_PANELS = [
    // 价格 panel 的图例有 7 项（价格/均价/涨跌 + 四条公式线），窄屏必然折成两行，
    // 所以按两行预留高度；量比和量各一行。
    { id: 'price', weight: 6, kind: 'line', legendRows: 2 },
    { id: 'vol', weight: 2, kind: 'volume' },
    { id: 'ratio', weight: 2, kind: 'ratio' },
  ];
  // 公式曲线配色：绘制（buildTimelineOption）和图例（renderTimelineLegend）共用同一份，
  // 分开放两处必然漂移——改一处忘另一处，图上颜色和图例色块就对不上。
  // PP 与 M20 同色是有意的：PP 是当日压力、M20 是 20 分钟均线，两条都在图上但优先级低，
  // 用同一档黄色弱化，主力还是「中」那条青色线。
  const FORMULA_COLORS = { '中': '#00e5ff', PP: '#e8d33d', HH: '#7aa8ff', M20: '#e8d33d' };
  // 当前生效的 panel 集合：分时走 TIMELINE_PANELS，日线/周线走 PANELS。
  function activePanels() {
    return state && state.period === 'min' ? TIMELINE_PANELS : PANELS;
  }

  // 每个 panel 的指标图例行画在该网格「上方」：网格顶部为它预留高度，
  // 这样价格纵轴刻度（inside）只会落在图例下方，不会被图例压住。
  const LEGEND_ROW_H = 14;            // 图例行高（px），需与 css 字号/行高匹配
  const LEGEND_GAP = 2;               // 图例与网格之间的间距（px）
  // 单个 panel 图例预留的总高度：图例行是 flex-wrap 容器，内容多会向下折行，
  // 所以预留高度要按「行数」算，否则第二行会压到网格里的价格曲线上。
  function legendReserve(panel) {
    return LEGEND_ROW_H * (panel && panel.legendRows ? panel.legendRows : 1) + LEGEND_GAP;
  }

  function buildGrids() {
    const panels = activePanels();
    const total = panels.reduce((s, p) => s + p.weight, 0);
    // 用像素布局：图例高度是固定像素，百分比没法精确给每个 panel 预留这一段。
    const H = Math.max(200, els && els.canvas ? els.canvas.clientHeight : 0);
    const gapPx = 12;                 // 各 panel 之间的间隔
    // 底部留给时间/日期标签。分时把 09:30 / 15:00 挪到网格之外（不再压在量比副图里面），
    // 所以要多留一行字的高度；日线仍沿用原来的 12px。
    const bottomPad = state.period === 'min' ? 17 : 12;
    const reserve = panels.reduce((s, p) => s + legendReserve(p), 0)
      + gapPx * (panels.length - 1) + bottomPad;
    const avail = Math.max(60, H - reserve);
    // 左右只留极小边距：价格刻度叠放在网格内部（axisLabel.inside），不占布局空间
    const leftPad = '2%', rightPad = '2%';
    let cursor = 0;
    return panels.map(p => {
      const h = avail * (p.weight / total);
      const lr = legendReserve(p);
      const g = {
        top: cursor + lr,
        height: h,
        left: leftPad, right: rightPad,
      };
      cursor += lr + h + gapPx;
      return g;
    });
  }

  // ---------- 状态 ----------
  const state = {
    chart: null, code: null, name: '', period: 'day', adjust: 'qfq',
    klines: [], currentIdx: -1, visibleBars: 120, dz: null,
    crosshair: null, ignoreClickUntil: 0, lastToggleAt: 0, locked: false,
    maCache: {}, volMa5: null, macd: null, gridRects: [],
    quote: null,   // 当前股票最近一笔实时行情，回源/切周期重画后重新叠加当日 bar
    srcCached: false,   // 当前 K 线是否断网时取自本地留存（用于顶部离线提示）
    srcTlCached: false, // 当前分时是否断网时取自本地留存
    cacheTs: 0,         // K 线本地留存的写入时刻（离线提示里显示"留存于"，0 表示未知）
    tlCacheTs: 0,       // 分时本地留存的写入时刻
    timeline: null, // 分时周期数据 { date, prevClose, points, byT }
    crossY: null,      // 分时十字线横线的像素位置（上下拖动改它）
    crossYPanel: null, // 分时横线当前落在哪个面板（0 价格 / 1 成交量 / 2 量比）
    crosshairIdx: -1,  // 当前十字线所在槽位（分时）
    tlDatePair: '',    // 跨日重载限流标记：记录已触发过重载的「timeline日期>行情日期」
    mainSlot: null, previewSlot: null,
    // grid 按像素布局（给图例预留固定高度），需记录依据的画布高度，高度变了重算
    _layoutH: 0,
    // 邻票预览：previewPane 预渲染上一只/下一只，滑动时跟手滑入
    previewDir: 0, previewReady: false, switching: false,
    previewTl: null,   // 邻票分时预取结果 { code, tl }，换股提交时用它立即填顶部数据区
    neighbors: { '-1': null, '1': null },   // 结果列表中相邻股票 { code, name, match }
  };

  let els = {};

  // 一个 slot = 一块画布 + 它的指标行/日期 DOM 覆盖层（覆盖层挂在 pane 内，随 pane 一起位移）
  function makeSlot(pane, chart) {
    const legendLayer = document.createElement('div');
    legendLayer.className = 'chart-legend-layer';
    const legendRows = PANELS.map(() => {
      const row = document.createElement('div');
      row.className = 'chart-legend-row';
      legendLayer.appendChild(row);
      return row;
    });
    pane.appendChild(legendLayer);

    const dateLayer = document.createElement('div');
    dateLayer.className = 'chart-date-layer';
    const left = document.createElement('span'); left.className = 'chart-date-label';
    const right = document.createElement('span'); right.className = 'chart-date-label';
    dateLayer.appendChild(left); dateLayer.appendChild(right);
    // 量比副图的两个极值数字也放在这层：ECharts 自己的轴刻度是「按刻度值上下居中」摆的，
    // 首尾两个刻度会有一半伸到面板框外，往上撞图例、往下压时间标签，压不住也躲不开。
    // 改成 DOM 覆盖层贴着面板内侧的上下沿画，位置完全由我们控制。
    const ratioHi = document.createElement('span'); ratioHi.className = 'chart-ratio-label';
    const ratioLo = document.createElement('span'); ratioLo.className = 'chart-ratio-label';
    dateLayer.appendChild(ratioHi); dateLayer.appendChild(ratioLo);
    pane.appendChild(dateLayer);

    return { pane, chart, rows: [], cache: null, rects: [], legendLayer, legendRows, dateLayer, dateLabels: { left, right }, ratioLabels: { hi: ratioHi, lo: ratioLo }, ratioAxis: null };
  }

  function init(dom) {
    els = dom;
    // 双画布：mainPane 承载当前股票，previewPane 预渲染邻票（默认停在屏外）。
    // 放在内层 pane 上做 transform（而非直接动 #chart-canvas），滑动时两幅图一起位移，
    // 就能看到新票的图形随手指滑入；指标/日期覆盖层挂各自 pane 内同步移动。
    els.mainPane = document.createElement('div');
    els.mainPane.className = 'chart-pane chart-pane-main';
    els.canvas.appendChild(els.mainPane);
    els.previewPane = document.createElement('div');
    els.previewPane.className = 'chart-pane chart-pane-preview';
    els.canvas.appendChild(els.previewPane);

    state.chart = echarts.init(els.mainPane, null, { renderer: 'canvas' });
    state.previewChart = echarts.init(els.previewPane, null, { renderer: 'canvas' });
    state.mainSlot = makeSlot(els.mainPane, state.chart);
    state.previewSlot = makeSlot(els.previewPane, state.previewChart);

    resetPreviewPane();
    bindInteractions();
    // 记录当前可视窗口首尾，供底部日期标签取窗口首尾日期
    state.chart.on('dataZoom', syncDzWindow);
    window.addEventListener('resize', onResize);
    if (window.ResizeObserver) new ResizeObserver(onResize).observe(els.canvas);

    // 从其他应用/标签页切回：后台期间操作系统可能回收画布尺寸或打断手势，
    // 回到前台必须重新同步一次布局，否则整幅 K 线会横向错位。
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') resyncViewport();
    });
    // iOS Safari 从 bfcache 恢复时不会触发 visibilitychange / resize
    window.addEventListener('pageshow', (e) => {
      if (e.persisted) resyncViewport();
    });
    // 桌面端切窗口 / 移动端从后台恢复后重新聚焦
    window.addEventListener('focus', resyncViewport);
  }

  function paneWidth() { return els.canvas ? els.canvas.clientWidth : 0; }

  function onResize() {
    if (!state.chart) return;
    state.chart.resize();
    if (state.previewChart) state.previewChart.resize();
    // grid 是按像素算的（要给图例预留固定高度），chart.resize() 只会按旧 option 重排，
    // 高度变了必须重算 grid，否则后台旋转/分屏回来后纵向布局会冻在旧高度上。
    const H = els.canvas ? els.canvas.clientHeight : 0;
    if (H && H !== state._layoutH) {
      state._layoutH = H;
      const keepDz = state.dz;
      if (state.period === 'min') {
        if (state.timeline) paintTimeline(state.mainSlot);
      } else if (state.klines.length) {
        state.mainSlot.rows = state.klines;
        paint(state.mainSlot, state.klines, state);
        state.gridRects = state.mainSlot.rects;
        state.dz = state.mainSlot.dz;
        // 重画会把可视窗口拉回默认根数，这里把用户缩放过的窗口还原
        if (keepDz && state.klines.length) {
          const last = state.klines.length - 1;
          const sv = Math.max(0, Math.min(keepDz.sv, last));
          const ev = Math.max(sv, Math.min(keepDz.ev, last));
          if (sv !== state.dz.sv || ev !== state.dz.ev) {
            state.chart.dispatchAction({ type: 'dataZoom', startValue: sv, endValue: ev });
            state.dz = { sv, ev };
          }
        }
      }
      if (state.previewSlot.rows && state.previewSlot.rows.length) {
        paint(state.previewSlot, state.previewSlot.rows, state.previewSlot.cache);
      }
    }
    state.mainSlot.rects = readRects(state.chart);
    state.previewSlot.rects = readRects(state.previewChart);
    layoutLegend(state.mainSlot);
    layoutDateLabels(state.mainSlot);
    layoutRatioLabels(state.mainSlot);
    renderLegend(state.mainSlot, state.currentIdx >= 0 ? state.currentIdx : state.mainSlot.rows.length - 1);
    // 只有十字线确实处于锁定态、且指向有效位置时才重画。
    // 这里若不判 locked/currentIdx，换股后（下标已被清成 -1）任何一次尺寸变化
    // ——手机地址栏收起、转屏、分屏切换——都会把十字线重新画出来，
    // 且 -1 会被下游兜底成第 0 个槽位，表现为「新股票一进来就停在开盘第一分钟」。
    if (state.crosshair && state.locked && state.currentIdx >= 0) renderCrosshair(state.currentIdx);
  }

  function readRects(chart) {
    if (!chart) return [];
    const model = chart.getModel && chart.getModel();
    return activePanels().map((_, gi) => {
      try {
        const cs = model.getComponent('grid', gi).coordinateSystem;
        return cs.getRect();
      } catch (e) { return null; }
    });
  }

  // 同步当前 dataZoom 可视窗口（首尾索引），底部日期标签据此取首尾日期。
  function syncDzWindow() {
    if (!state.chart) { state.dz = null; return; }
    // 分时的窗口固定是全部 242 个槽，标签是 09:30/15:00，不随缩放变化
    if (state.period === 'min') return;
    const opt = state.chart.getOption();
    const dz = opt && opt.dataZoom && opt.dataZoom[0];
    if (!dz) { state.dz = null; return; }
    state.dz = { sv: Math.ceil(dz.startValue), ev: Math.floor(dz.endValue) };
    updateDateLabels(state.mainSlot, state.klines, state.dz);
  }

  // 构建全部 series（K / MA / VOL / VOL MA5 / MACD）。抽出来是为了让「3 秒一次的
  // 尾根增量刷新」能复用同一套指标口径：整图重绘和局部合并都必须吃到完全一致的数据，
  // 否则盘中柱子的颜色、MA 位置会和重绘后对不上。
  // cache = { maCache, macd, volMa5 }，指标结果缓存其中，避免重复计算。
  function buildSeries(rows, cache) {
    const ohlc = rows.map((r, i) => {
      const prevC = i > 0 ? rows[i - 1].c : null;
      // 涨幅超 9.5%（接近涨停）的 K 线加金黄色外描边。涨跌幅按「相对前一根收盘价」计算，
      // 与行情软件口径一致；首根没有前收，不描边。
      const pct = prevC && prevC > 0 ? (r.c - prevC) / prevC * 100 : null;
      if (pct != null && pct > SURGE_PCT) {
        return { value: [r.o, r.c, r.l, r.h], itemStyle: { borderColor: SURGE_COLOR } };
      }
      return [r.o, r.c, r.l, r.h];
    });
    const vols = rows.map(r => ({ value: r.vol, itemStyle: { color: r.c >= r.o ? UP : DOWN } }));

    const maSeries = [5, 10, 20, 60].map(n => {
      const key = 'ma' + n;
      if (!cache.maCache[key]) cache.maCache[key] = calcMA(rows, n);
      return {
        name: 'MA' + n, type: 'line', data: cache.maCache[key],
        xAxisIndex: 0, yAxisIndex: 0, smooth: false, symbol: 'none',
        lineStyle: { width: 1, color: MA_COLORS[key] }, z: 3, connectNulls: false,
      };
    });

    const macd = cache.macd || (cache.macd = calcMACD(rows));

    // 量能均线：VOL 副图叠加 5 日均量线
    const volArr = rows.map(r => r.vol);
    const volMa5 = cache.volMa5 || (cache.volMa5 = rows.map((_, i) => sma(volArr, 5, i)));
    const volMaSeries = {
      name: 'VOL MA5', type: 'line', data: volMa5,
      xAxisIndex: 1, yAxisIndex: 1, symbol: 'none', smooth: false,
      lineStyle: { width: 1, color: '#e8a33d' }, z: 3, connectNulls: false,
    };

    const macdHist = {
      name: 'MACD', type: 'bar', xAxisIndex: 2, yAxisIndex: 2, barWidth: '60%',
      data: macd.hist.map(v => ({ value: v, itemStyle: { color: v >= 0 ? UP : DOWN } })),
    };
    const macdDif = { name: 'DIF', type: 'line', xAxisIndex: 2, yAxisIndex: 2, symbol: 'none', data: macd.dif, lineStyle: { width: 1, color: '#e8a33d' } };
    const macdDea = { name: 'DEA', type: 'line', xAxisIndex: 2, yAxisIndex: 2, symbol: 'none', data: macd.dea, lineStyle: { width: 1, color: '#3d7ee8' } };

    // 振幅副图（panel 3）：当日振幅折线 + 100 日均线（虚线）+ 0/5/10 参考线
    const ampIdx = PANELS.findIndex(p => p.id === 'amp');
    const ampData = cache.amp || (cache.amp = calcAmp(rows));
    const ampSeries = {
      name: '振幅', type: 'line', xAxisIndex: ampIdx, yAxisIndex: ampIdx, symbol: 'none',
      smooth: false, connectNulls: false,
      lineStyle: { width: 1, color: '#5ad2c8' }, z: 3,
      data: ampData.amp,
    };
    const ampPjSeries = {
      name: 'PJ', type: 'line', xAxisIndex: ampIdx, yAxisIndex: ampIdx, symbol: 'none',
      smooth: false, connectNulls: false,
      lineStyle: { width: 1, color: '#e8d33d', type: 'dotted' }, z: 3,
      data: ampData.pj,
    };
    // 0 / 5 / 10 三条水平参考线：画在振幅线上，靠 markLine 撑住整条水平线，
    // 不额外占一条 series，也不影响图例读数。
    const ampRefLine = {
      name: '振幅参考', type: 'line', xAxisIndex: ampIdx, yAxisIndex: ampIdx,
      data: [], silent: true, symbol: 'none', lineStyle: { width: 0 }, z: 1,
      markLine: {
        silent: true, symbol: 'none', animation: false,
        label: { show: true, position: 'insideEndTop', color: '#6f7b77', fontSize: 9 },
        lineStyle: { color: '#3a4340', width: 1, type: 'solid' },
        data: [
          { yAxis: 0, label: { formatter: '0' } },
          { yAxis: 5, label: { formatter: '5' } },
          { yAxis: 10, label: { formatter: '10' }, lineStyle: { color: '#5a4a2a' } },
        ],
      },
    };

    return [
      { name: 'K', type: 'candlestick', xAxisIndex: 0, yAxisIndex: 0, data: ohlc,
        itemStyle: { color: UP, color0: DOWN, borderColor: UP, borderColor0: DOWN, borderWidth: 1 },
        emphasis: { disabled: true } },
      ...maSeries,
      { name: 'VOL', type: 'bar', xAxisIndex: 1, yAxisIndex: 1, data: vols, barWidth: '60%' },
      volMaSeries,
      macdHist, macdDif, macdDea,
      ampSeries, ampPjSeries, ampRefLine,
    ];
  }

  // ---------- 构建 ECharts option（主图 / 预览图共用） ----------
  function buildOption(rows, cache) {
    const grids = buildGrids();
    const dates = rows.map(r => r.date);
    const series = buildSeries(rows, cache);

    const visCount = Math.min(state.visibleBars, rows.length) || rows.length;
    const startValue = Math.max(0, rows.length - visCount);

    const opt = {
      animation: false,
      backgroundColor: '#0d0f0e',
      axisPointer: { link: [{ xAxisIndex: 'all' }] },
      grid: grids,
      xAxis: PANELS.map((p, gi) => ({
        type: 'category', data: dates, gridIndex: gi, boundaryGap: true,
        axisLine: { lineStyle: { color: '#2a312f' } },
        axisTick: { show: false },
        splitLine: { show: false },
        // 日期改由底部 DOM 覆盖层两端对齐显示（保证窄屏也能完整显示，不被画布边缘裁掉），
        // 轴内刻度关掉即可
        axisLabel: { show: false },
        min: 'dataMin', max: 'dataMax',
      })),
      yAxis: PANELS.map((p, gi) => ({
        // 价格轴放到左侧：右侧留给最新 K 线，避免刻度盖住它
        gridIndex: gi, scale: true, position: gi === 0 ? 'left' : 'right',
        // 振幅副图要能同时容纳 0/5/10 三条参考线与真实振幅，否则参考线会被挤出画面。
        // 下限压到 -1 让 0 线不贴边，上限取「数据最大值」与 10 的较大者再留一成余量。
        ...(p.id === 'amp' ? (() => {
          const ampVals = ((cache && cache.amp) || calcAmp(rows)).amp.filter(v => v != null && isFinite(v));
          const maxV = ampVals.length ? Math.max(...ampVals) : 0;
          return { scale: false, min: -1, max: Math.max(10.5, maxV * 1.1) || 10.5 };
        })() : null),
        // 副图（量能/MACD）横线稀疏一些，只留 2 条参考线即可，不必密集铺满
        splitNumber: gi === 0 ? 5 : 2,
        splitLine: { lineStyle: { color: '#1b201f' } },
        axisLine: { show: false }, axisTick: { show: false },
        // 主图显示价格刻度，叠放在图区左侧内部（inside），不挤占 K 线宽度；
        // 副图（量能/MACD）不显示纵轴数据
        axisLabel: gi === 0
          ? { color: '#6f7b77', fontSize: 9, inside: true, formatter: v => fmtNum(v) }
          : { show: false },
      })),
      dataZoom: [{ type: 'inside', xAxisIndex: PANELS.map((_, i) => i), zoomLock: true,
        startValue, endValue: rows.length - 1, minValueSpan: 20, maxValueSpan: 260,
        // 拖动/触摸交互全部交给自定义手势，禁掉 ECharts 内置平移，避免两者叠加造成斜向漂移
        zoomOnMouseWheel: true, moveOnMouseMove: false, moveOnMouseWheel: false, preventDefaultMouseMove: true }],
      series,
    };
    return { opt, startValue };
  }

  // ---------- 分时图 ----------
  // 采用「固定槽位」画法：x 轴永远是当天完整的 242 个分钟槽（09:30-11:30 / 13:00-15:00），
  // 没到的分钟留 null。这样盘中曲线是「从左往右生长」，而不是每个新点都把整条线横向压缩重排，
  // 视觉上和通达信一致。后端已把 15:00 之后的盘后固定价交易点过滤掉。
  const TIMELINE_SLOTS = (() => {
    const out = [];
    const push = (h0, m0, h1, m1) => {
      for (let m = h0 * 60 + m0; m <= h1 * 60 + m1; m++) {
        out.push(String(Math.floor(m / 60)).padStart(2, '0') + String(m % 60).padStart(2, '0'));
      }
    };
    push(9, 30, 11, 30);
    push(13, 0, 15, 0);
    return out;
  })();
  const TIMELINE_SLOT_IDX = new Map(TIMELINE_SLOTS.map((t, i) => [t, i]));

  // 分时的本地留存键：一只票只留最近一次完整曲线。
  const TL_SNAP_KEY = (code) => `tl|${code}`;

  async function fetchTimelineData(code) {
    try {
      const res = await fetch(`${API_BASE}/api/timeline?code=${encodeURIComponent(code)}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const e = new Error(data.error || `分时加载失败 (${res.status})`);
        e.httpStatus = res.status;   // 后端报错 ≠ 断网，下面不允许拿旧数据顶替
        throw e;
      }
      // 每次拉到正常数据就覆盖留存，断网时才有得看。
      if (data && data.points && data.points.length) {
        idb.putSnap(TL_SNAP_KEY(code), { payload: data, ts: Date.now() });
      }
      return data;
    } catch (err) {
      if (err && err.httpStatus) throw err;
      // 联网正常时不用旧数据顶替，不然会把故障藏起来；
      // 断网（或请求根本发不出去）才退回本地留存的那一份。
      const snap = await idb.getSnap(TL_SNAP_KEY(code));
      if (snap && snap.payload && snap.payload.points && snap.payload.points.length) {
        snap.payload = Object.assign({}, snap.payload, { cached: true, cacheTs: snap.ts });
        return snap.payload;
      }
      throw err;
    }
  }

  // 行情里的 q.date 是 "2026-10-19"，分时 payload 的 date 是 "20261019"，
  // 直接比较永远不相等，会导致每 3 秒都误判「跨日」而整条重拉、实时点也叠不进去。
  function normDate(v) {
    return String(v || '').replace(/\D/g, '').slice(0, 8);
  }

  function applyTimelinePayload(payload, keepQuote) {
    const points = (payload && payload.points) || [];
    const byT = new Map();
    for (const p of points) byT.set(p.t, p);
    state.srcTlCached = !!(payload && payload.cached);   // 是否断网回退的本地留存
    state.tlCacheTs = (payload && payload.cached) ? (payload.cacheTs || 0) : 0;   // 留存写入时刻
    state.timeline = {
      date: normDate(payload && payload.date),
      prevClose: payload && payload.prevClose != null ? payload.prevClose : null,
      vol5: payload && payload.vol5 != null ? payload.vol5 : null,   // 5 日均量（手），量比基准
      points,
      byT,
    };
    // 校准（每 30 秒 refreshTimeline）会重走这里。若十字线正锁定，不能把 currentIdx 清成 -1：
    // renderCrosshairMin 会拿它当基准，-1 会被钳到 0，用户停在 14:35 的十字线每 30 秒跳回 09:30。
    // 锁定时把 currentIdx 回填成十字线所在槽位，非锁定时才清空。
    state.currentIdx = (state.locked && state.crosshairIdx >= 0) ? state.crosshairIdx : -1;
    if (keepQuote !== false) renderTimeline();
    return state.timeline;
  }

  // 从行情快照的成交时间戳取出「当前分钟」，用于把实时价写进对应槽位。
  // q.time 形如 20261019161500（14 位），截 8-12 位即 HHMM。
  function quoteMinute(q) {
    const s = String((q && q.time) || '');
    if (s.length < 12) return '';
    const t = s.slice(8, 12);
    return /^\d{4}$/.test(t) ? t : '';
  }

  // ---------- 分时公式曲线（用户提供的通达信公式）----------
  // 原式里的 Y 没给取值。PEAKBARS(1, Y/10, 1) 中 Y/10 是「峰确认幅度（%）」，
  // 分时 242 根如果取 5%~10%，绝大多数股票全天振幅都达不到，P 恒为 0，
  // PP 就退化成当前价。所以按分时尺度取 1.5%。
  // （X 参数只喂给 Z/M 这两条 `:=` 变量，它们不上图，所以 X 已无需取值。）
  const TL_PEAK_Y = 15;   // 对应公式 Y/10 = 1.5%

  // 通达信 PEAKBARS / TROUGHBARS 的 ZigZag 近似：逐根推进，确认一个峰/谷就记一个 pivot。
  // 返回 [{ i, type }]，type 为 'peak' 或 'trough'。
  function zigzagPivots(vals, pct) {
    const pivots = [];
    let dir = 0;                    // 0=未定向 1=上升段 -1=下降段
    let extIdx = -1, extVal = null;
    for (let i = 0; i < vals.length; i++) {
      const v = vals[i];
      if (v == null) continue;
      if (extIdx < 0) { extIdx = i; extVal = v; continue; }
      if (dir !== -1) {             // 上升段（含未定向）：盯最高
        if (v >= extVal) { extIdx = i; extVal = v; }
        else if (extVal > 0 && (extVal - v) / extVal * 100 >= pct) {
          pivots.push({ i: extIdx, type: 'peak' });
          dir = -1; extIdx = i; extVal = v;
        }
      } else {                      // 下降段：盯最低
        if (v <= extVal) { extIdx = i; extVal = v; }
        else if (extVal > 0 && (v - extVal) / extVal * 100 >= pct) {
          pivots.push({ i: extIdx, type: 'trough' });
          dir = 1; extIdx = i; extVal = v;
        }
      }
    }
    return pivots;
  }

  // 距 k 之前（含 k）最近一个指定类型 pivot 的 bar 数；没有则 0（对应公式 T=0 / N=0）。
  function barsSince(pivots, k, type) {
    let last = -1;
    for (const p of pivots) {
      if (p.i > k) break;
      if (p.type === type) last = p.i;
    }
    return last < 0 ? 0 : k - last;
  }

  // 生成公式曲线。长度与 price 一致，未成交段为 null。
  //
  // 只画通达信里真正「输出」的变量，即定义用 `:` 的：
  //   中  = (当日累计最高 + 累计最低)/2      —— 中:(...),COLORCYAN
  //   PP  = (上一个峰价 + 峰后最低)/2        —— PP:IF(...),COLORYELLOW
  //   HH  = 5 根之前的当日累计最高            —— HH:REF(...),COLORLIBLUE,DOTLINE
  //   M20 = 20 分钟简单均线                  —— M20:MA(C,20),COLORYELLOW
  //
  // 原公式里另外四个变量一个都不能画，这是通达信语法决定的，不是审美取舍：
  //   Z:=..., M:=... 用的是 `:=`（赋值而非输出），通达信里根本不上图；
  //   ZG:, ZD: 虽用 `:` 但后缀 NODRAW，同样不上图。
  // 之前把 Z / M 当曲线画出来，正是用户看到「多出两根线」的原因。
  // 顺带省掉一趟 zigzag：只剩 PP 需要峰位（Y 参数），X 参数那条不用算了。
  function timelineFormulas(price) {
    const n = price.length;
    const mid = new Array(n).fill(null);
    const ppLine = new Array(n).fill(null);
    const hhLine = new Array(n).fill(null);
    const ma20 = new Array(n).fill(null);

    const idxs = [];
    for (let i = 0; i < n; i++) if (price[i] != null) idxs.push(i);
    if (!idxs.length) return { mid, pp: ppLine, hh: hhLine, ma20 };

    const vals = idxs.map((i) => price[i]);
    const runHi = [], runLo = [];
    let hi = -Infinity, lo = Infinity;
    for (const v of vals) {
      if (v > hi) hi = v;
      if (v < lo) lo = v;
      runHi.push(hi); runLo.push(lo);
    }
    const pivY = zigzagPivots(vals, TL_PEAK_Y / 10);
    const minFrom = (k, j) => { let m = Infinity; for (let x = j; x <= k; x++) if (vals[x] < m) m = vals[x]; return m; };

    // 20 分钟均线
    let sum = 0;
    for (let k = 0; k < vals.length; k++) {
      sum += vals[k];
      if (k >= 20) sum -= vals[k - 20];
      if (k >= 19) ma20[idxs[k]] = sum / 20;
    }

    for (let k = 0; k < vals.length; k++) {
      const gi = idxs[k];
      mid[gi] = (runHi[k] + runLo[k]) / 2;
      // HH: REF(HHV(H, FROMOPEN), 5)，早期不足 5 根就用第 0 根的累计最高
      hhLine[gi] = runHi[Math.max(0, k - 5)];
      // PP: P=0 时公式退化为 (H+L)/2 = 当前价，用统一式子即可覆盖
      const tY = barsSince(pivY, k, 'peak');
      ppLine[gi] = (vals[k - tY] + minFrom(k, k - tY)) / 2;
    }
    return { mid, pp: ppLine, hh: hhLine, ma20 };
  }

  // 组装分时三条序列：价格线、均价线、每分钟量柱。
  // 已收盘的点来自 tl；最后一段由 quote 实时行情向右延伸。
  // tl / quote 显式传入，是因为邻票预览（previewPane）要画另一只票，不能读 state。
  function timelineSeries(tl, quote) {
    const q0 = quote !== undefined ? quote : state.quote;
    const n = TIMELINE_SLOTS.length;
    const price = new Array(n).fill(null);
    const avg = new Array(n).fill(null);
    const vols = new Array(n).fill(null);
    const cum = new Array(n).fill(null);
    const prevClose = tl.prevClose != null ? tl.prevClose : null;
    let ref = prevClose;                       // 用来给量柱上色（涨红跌绿）
    let lastFilled = -1;
    for (let i = 0; i < n; i++) {
      const p = tl.byT.get(TIMELINE_SLOTS[i]);
      if (!p) continue;
      price[i] = p.price;
      avg[i] = p.avg;
      cum[i] = p.cumVol;
      vols[i] = { value: p.vol, itemStyle: { color: (ref != null && p.price < ref) ? DOWN : UP } };
      ref = p.price;
      lastFilled = i;
    }

    // 实时行情叠加：只在「行情日期与分时日期一致」时生效，避免隔夜的旧快照画进来。
    // 用累计量差算出当前这一分钟的量，累计额算出均价，口径与后端解析保持一致。
    const q = q0;
    let live = -1;
    if (q && !q.suspended && Number(q.price) > 0) {
      const tlDate = normDate(tl.date), qDate = normDate(q.date);
      // 两侧都必须是有效日期才认定同日：任一为空就说明数据不完整，宁可不叠也不要叠错。
      const sameDay = !!tlDate && !!qDate && qDate === tlDate;
      // 分钟不在交易时段槽位内就整段跳过，绝不兜底到 15:00：
      // 收盘后快照时间戳是 161500（盘后固定价交易），集合竞价是 0915，
      // 兜底写进 241 槽会把盘后价盖到 15:00，甚至把全天累计量画成一根天量柱。
      const t = quoteMinute(q);
      const i = t ? TIMELINE_SLOT_IDX.get(t) : undefined;
      if (sameDay && i != null && i >= lastFilled) {
        const pv = i > 0 && price[i - 1] != null ? price[i - 1] : prevClose;
        const p = Number(q.price);
        price[i] = p;
        // 均价用当日累计成交额 / 累计成交量，与后端 parseTimeline 同一公式
        if (q.amount != null && Number(q.vol) > 0) avg[i] = Number(q.amount) / (Number(q.vol) * 100);
        const prevCum = i > 0 && cum[i - 1] != null ? cum[i - 1] : (cum[i] != null ? cum[i] : 0);
        const nowCum = Number(q.vol) > 0 ? Number(q.vol) : prevCum;
        vols[i] = {
          value: Math.max(0, nowCum - prevCum),
          itemStyle: { color: (pv != null && p < pv) ? DOWN : UP },
        };
        cum[i] = nowCum;
        live = i;
      }
    }

    // 当日最高/最低：取已生成的点（含实时点），供顶部行情条使用
    let hi = null, lo = null;
    for (let i = 0; i < n; i++) {
      const v = price[i];
      if (v == null) continue;
      if (hi == null || v > hi) hi = v;
      if (lo == null || v < lo) lo = v;
    }
    // 量比曲线：累计量 /（5 日均量 ÷ 240 分钟 × 已开市分钟数）。
    // 口径对齐通达信：全天按 240 个交易分钟算，09:30 那个点只走了不到一分钟
    // （主要是集合竞价），已开市分钟数按 1 兜底；09:31 起按真实分钟数递增，
    // 下午顺延。若像以前那样用「槽位序号+1」当分钟数，09:31 会被算成走了 2 分钟，
    // 分母翻倍，开盘附近的量比被压掉一半多，越临近收盘差得越少——
    // 正是用户反馈的「开盘偏小、后面接近」。
    const ratio = new Array(n).fill(null);
    const v5 = tl && Number(tl.vol5) > 0 ? Number(tl.vol5) : null;
    if (v5) {
      const perMin = v5 / 240;
      for (let i = 0; i < n; i++) {
        const c = cum[i];
        if (c == null) continue;
        // 09:30 那一槽（i === 0）不画量比：它只有集合竞价那一下的量，画上去会把曲线
        // 从左上角斜拉下来一段，通达信也是从 09:31 才开始有量比曲线。
        // 留 null 后，量比极值统计（timelineRatioAxis）也自然跳过它。
        if (i === 0) continue;
        // 上午 09:30~11:30 共 121 槽，下午 13:00~15:00 共 121 槽；
        // 两个半场各自的第一槽是「整点瞬间」，不计入已走分钟。
        const mins = Math.max(1, i <= 120 ? i : i - 1);
        ratio[i] = c / (perMin * mins);
      }
    }
    return { price, avg, vols, cum, hi, lo, live, lastFilled, ratio };
  }

  // 3 秒一次的实时刷新走这里：只替换三条序列的 data 数组，不重建 option。
  // 若每 3 秒都 setOption(notMerge:true)，整张图会闪一下（ECharts 重排坐标轴），
  // 用户看到的就是「分时线在抖」。只更新 data 则平滑无感。
  function updateTimelineTail() {
    const slot = state.mainSlot;
    const tl = state.timeline;
    if (!slot || !tl || !state.chart) return;
    // 数据源日期换了（隔夜/跨日）：整张重画，否则会把今天的新点画到昨天的槽位上
    const q = state.quote;
    const tlDate = normDate(tl.date), qDate = normDate(q && q.date);
    if (qDate && tlDate && qDate !== tlDate) {
      // 跨日重载必须限流。只要行情日期翻到新交易日而后端 timeline 还停在旧日
      // （后端落库滞后、或该股停牌导致 timeline.date 追不上），这个分支每 3 秒
      // 就会发起一次完整分时拉取，把 30 秒一次的校准放大成 3 秒一次打上游。
      // 用「同一日期对只重载一次」挡住：日期对变了（真的翻篇了）才允许再试一次。
      const pair = `${tlDate}>${qDate}`;
      if (state.tlDatePair !== pair) {
        state.tlDatePair = pair;
        api.load().catch(() => {});
      }
      return;
    }
    state.tlDatePair = '';
    const s = timelineSeries(tl);
    // 纵轴越界保护：分时的 min/max 是构建 option 时算死的，3 秒 tick 只换 series 数据。
    // 盘中创新高/新低时新点会落在 yMin~yMax 之外，被 ECharts 直接裁掉（曲线顶端「断」一截），
    // 要等 30 秒整条校准才恢复。这里实时比对一次极值，越界就立刻整条重绘重算纵轴。
    // 用 2 秒节流兜住「一路上涨连续越界」的情况，避免每 tick 都重绘。
    try {
      // getOption() 会深拷贝整份 option（8 条 242 点序列），3 秒一次调用两次是白烧
      // 移动端的电，所以只取一次，价格轴和量比轴都从这份快照里读。
      const optNow = slot.chart.getOption();
      const yAxis0 = optNow.yAxis[0];
      const aMin = typeof yAxis0.min === 'number' ? yAxis0.min : null;
      const aMax = typeof yAxis0.max === 'number' ? yAxis0.max : null;
      const ax = timelinePriceAxis(s, tl.prevClose);
      const priceChanged = ax.yMin != null && (ax.yMin !== aMin || ax.yMax !== aMax);
      // 量比副图：轴按当日实际极值自适应（见 timelineRatioAxis）。
      // 越界判定刻意只认「要扩」的方向：量比顶破上界、或跌出下界时才动轴；
      // 数据回落、区间该收窄时不在这里收 —— 收窄交给 30 秒整图校准。
      // 原因是双向比较会在量比上下往复时每 3 秒改一次刻度，副图网格跟着一伸一缩。
      const y2 = optNow.yAxis[2];
      const rMaxNow = y2 && typeof y2.max === 'number' ? y2.max : null;
      const rMinNow = y2 && typeof y2.min === 'number' ? y2.min : null;
      const rAxis = timelineRatioAxis(s);
      const ratioChanged = rMaxNow != null && (rAxis.max > rMaxNow || rAxis.min < rMinNow);
      // 成交量副图同理：上限在构建 option 时算死（见 timelineVolAxis），盘中量柱继续走高
      // 就会顶出可视区被裁掉。同样只扩不缩。
      const y1 = optNow.yAxis[1];
      const vMaxNow = y1 && typeof y1.max === 'number' ? y1.max : null;
      const volAxisNow = timelineVolAxis(s);
      const volChanged = vMaxNow != null && volAxisNow.max > vMaxNow;
      // 早先这里用 2000ms 时间节流，但 tick 本身就是 3 秒一次，节流形同虚设；
      // 而整图 notMerge 重绘的开销又让「不节流」不可接受，于是两头都不对。
      // 改成轻量 setOption 后不需要时间节流了：直接算新轴，轴没变就什么都不做，
      // 变了才写 —— 越界这一 tick 立刻生效，之后没有新越界就自然安静。
      if (priceChanged || ratioChanged || volChanged) {
        // 轴区间要变了：先把十字线横线的像素位置换算成数值锚点。
        // 否则 crossY 还是旧区间的像素值，同一像素在新区间里代表完全不同的价位，
        // 十字线读数就会在每次纵轴扩张时莫名漂一下。
        // 横线现在能落在任一子图，锚点要用「所在子图那条轴」换算，且只在该轴真的变了时才换算。
        let anchorVal = null, anchorPanel = 0;
        if (state.locked && state.crossY != null && isFinite(state.crossY)) {
          const p = crossPanelAtY(state.crossY);
          const axisChanged = (p === 0 && priceChanged) || (p === 1 && volChanged) || (p === 2 && ratioChanged);
          if (axisChanged) {
            const v = valueAtY(state.crossY, p);
            if (v != null && isFinite(v)) { anchorVal = v; anchorPanel = p; }
          }
        }
        // 只改真正变化的那个副图轴，不重建整张图。
        // 早先用 paintTimeline(slot) 整条 notMerge 重绘，会连带把数据、网格、图例、
        // 十字线图层全部拆掉重建 —— 盘中单边上行时几乎每 tick 都触发，屏上就是一路闪。
        // 按索引只写变化的那个（价格轴第 1 个、量比轴第 3 个），其余给空对象原样保留。
        const yPatch = [{}, {}, {}];
        if (priceChanged) yPatch[0] = { min: ax.yMin, max: ax.yMax, interval: ax.yInterval };
        if (volChanged) yPatch[1] = { min: volAxisNow.min, max: volAxisNow.max, interval: volAxisNow.interval };
        if (ratioChanged) yPatch[2] = {
          min: rAxis.min, max: rAxis.max, interval: rAxis.interval,
        };
        slot.chart.setOption({ yAxis: yPatch });
        // 量比轴区间变了：记录新区间并重画两端极值数字，否则数字会停在旧区间上
        if (ratioChanged) {
          // 必须把真实极值 hi/lo 一起存下来：覆盖层标数字用的是当日峰值/谷值，
          // 不是扩出来的轴端边界。少存这两项，tick 扩轴后数字会退回读轴端（读高/读低）。
          slot.ratioAxis = { min: rAxis.min, max: rAxis.max, interval: rAxis.interval, hi: rAxis.hi, lo: rAxis.lo };
          layoutRatioLabels(slot);
        }
        // 轴区间变了，网格像素位置不变，但 rects 引用要保证与当前实例一致。
        // 注意方向：slot.rects 为空时绝不能拿它去覆盖 state 里已有的有效值。
        if (slot.rects && slot.rects.length) state.gridRects = slot.rects;
        // 用新轴把锚点映射回像素，横线才停在同一个数值上
        if (anchorVal != null) {
          const ny = valueToY(anchorVal, anchorPanel);
          if (ny != null && isFinite(ny)) {
            const rs = state.gridRects.filter(Boolean);
            if (rs.length) {
              const t = Math.min(...rs.map((q) => q.y));
              const b = Math.max(...rs.map((q) => q.y + q.height));
              state.crossY = Math.max(t, Math.min(b, ny));
            } else state.crossY = ny;
          }
        }
      }
      // 这里刻意不 return：越界这一 tick 的新点、图例读数、十字线同样要更新。
      // 轴没变时下面的 setOption 会自然跳过纵轴（只写 series），代价可忽略；
      // 但一旦提前 return，就会出现「越界判定命中但本轮数据/图例全部停在旧值」的静默丢帧。
    } catch { /* getOption 失败就跳过这次检查，不影响正常增量更新 */ }
    const f = timelineFormulas(s.price);
    try {
      slot.chart.setOption({
        series: [
          { name: 'PRICE', data: s.price },
          { name: 'AVG', data: s.avg },
          { name: '中', data: f.mid },
          { name: 'PP', data: f.pp },
          { name: 'HH', data: f.hh },
          { name: 'M20', data: f.ma20 },
          { name: 'VOL', data: s.vols },
          { name: 'RATIO', data: s.ratio },
        ],
      });
    } catch { /* 图表未就绪时忽略，下一轮会再试 */ }
    renderTimelineLegend(slot);
    renderTimelineQuote();
    // 十字线打开时，3 秒一次的新点要让横线/标签跟着走，否则读数是旧的
    if (state.locked && state.crosshairIdx >= 0) renderCrosshair(state.crosshairIdx);
  }

  // 量比副图纵轴：下限恒为 0，一格 1 个单位，上限至少到 4。
  // 为什么至少 4：开盘量比常冲到 3 以上，轴必须给 3 留出空间，
  // 用户最关心的「十点量比有没有上 3、有没有守住 1」才看得到两条参照线。
  // 当天冲得更高（新股、异动股）按实际峰值向上扩，超过 6 后改两格一档免得刻度挤成一片。
  // 抽成独立函数：3 秒 tick 里量比继续冲高越界时，要用完全相同的算法重算，两处不能各写一套。
  // 量比副图纵轴：对齐通达信 —— 不写死 0 起点和整数刻度，按当日实际最大/最小自适应。
  // 之前的「min:0 + 至少到 4 + 一格 1 单位」是把轴钉死的做法：量比全天都在 0.8~1.4 之间时，
  // 曲线被压在副图最底下薄薄一条，几乎看不出起伏；而开盘冲到 3 的票，0~4 又让中段全空。
  // 现在按数据极值算，只在两侧加少量留白，再把上下界扩到整齐刻度，保证刻度数字好读。
  function timelineRatioAxis(s) {
    let lo = null, hi = null;
    for (const r of s.ratio) {
      if (r == null || !isFinite(r)) continue;
      if (lo == null || r < lo) lo = r;
      if (hi == null || r > hi) hi = r;
    }
    // 当日还没有量比数据（开盘第一分钟前的空图）：给个 0~1 的兜底区间，
    // 不能让 min/max 为 null 交给 ECharts 自适应，否则后面每次 tick 轴都在自己跳。
    if (lo == null || hi == null) return { min: 0, max: 1, interval: 0.5 };
    // 全天量比恒定（极端但会发生：一路无量到收盘）时区间塌成一条线，撑开一点
    if (!(hi > lo)) { hi = lo + 0.2; lo = Math.max(0, lo - 0.2); }
    // 量比不会为负，下界锁在 0
    if (lo < 0) lo = 0;
    // 上下界优先贴着当日真实极值：左侧只显示两个数字，即「当日最高量比」和「当日最低量比」。
    // 但 1.0 / 3.0 两条参照线是看盘的基准（今日量与平时持平 / 明显放量），
    // 所以在代价不大的前提下把轴往外兜到 1.0 或 3.0，让这两条线留在画面里。
    // 「代价不大」= 为它多让出的高度不超过当日真实波动幅度的 35%；
    // 超过就别兜了（ECharts 不画区间外的线，属预期），
    // 否则量比全天在 0.9~1.2 的票为了露出 3.0 线会被压成副图底下一细条。
    const r2 = (v) => Number(v.toFixed(2));
    const span = hi - lo;
    const slack = span * 0.35;
    let min = Math.max(0, lo - 1 <= slack ? Math.min(lo, 1) : lo);
    let max = 3 - hi <= slack ? Math.max(hi, 3) : hi;
    min = r2(min); max = r2(max);
    // 极值完全重合或跨度小到看不出起伏时撑开一点，避免轴塌成一条线
    if (!(max - min > 0.2)) max = r2(min + 0.4);
    // interval 取整个跨度：ECharts 只会在两端各出一个刻度，中间不再有等距刻度
    // （配合 splitLine 关闭，副图里只剩 1.0 / 3.0 两条参照线）。
    // 同时把当日真实极值一并带出去：轴为了兜住 1.0/3.0 参照线会被往外扩，
    // 轴端不等于当日最高量比，覆盖层标数字要用这两个真实值，否则会把「扩轴后的边界」当成峰值。
    return { min, max, interval: r2(max - min), hi: r2(hi), lo: r2(lo) };
  }

  // 量比的两个极值数字改成 DOM 覆盖层自绘（见 layoutRatioLabels），
  // 轴本身一个刻度都不标：ECharts 的刻度文字是按刻度值在轴上「上下居中」摆的，
  // 首尾两个刻度各有一半伸出面板框外，往上撞图例行、往下压时间标签，怎么调都压不住。
  // 覆盖层可以贴着面板内侧边缘摆，位置完全可控。
  function fmtRatioText(v) {
    const t = Number(v).toFixed(2);
    return t.endsWith('0') ? t.slice(0, -1) : t;
  }

  // 成交量子图的纵轴：早先不设 min/max，交给 ECharts 自适应。问题在于自适应轴会随
  // 每个 tick 的新数据自己重算 extent —— 盘中量柱一路走高时，同一像素对应的数值一直在变，
  // 而增量刷新只写 series 不写轴，横线锚点又只在「价格轴/量比轴」变化时换算，
  // 于是成交量副图上的十字线读数会自己漂（线没动，数字变了）。
  // 现在跟量比副图用同一套办法：算出固定的整齐上限写进轴里，只有真正越界才在 tick 中扩。
  function timelineVolAxis(s) {
    let peak = 0;
    for (const r of s.vols) {
      const v = r && typeof r === 'object' ? r.value : r;
      if (v == null || !isFinite(v)) continue;
      if (v > peak) peak = v;
    }
    if (!(peak > 0)) peak = 1;
    // 上限取「1/1.5/2/2.5/3/4/5/6/8/10 × 量级」这类好读的档位，并留 2% 余量，
    // 免得最高那根量柱正好顶到上边框显得图被切了一刀。
    // 档位不能太少：只有 1/2/5/10 时，峰值 5100 会被撑到 10000，副图上半屏全是空档。
    const want = peak * 1.02;
    const mag = Math.pow(10, Math.floor(Math.log10(want)));
    let top = null;
    for (const st of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
      if (want <= st * mag) { top = st * mag; break; }
    }
    if (top == null) top = 10 * mag;
    // 两格刻度（0 / 中 / 顶），与 splitNumber: 2 对应
    return { min: 0, max: top, interval: top / 2 };
  }

  // 分时价格纵轴：通达信口径 —— 昨收永远落在纵轴正中，上下严格对称。
  // 前两版都错在这件事上：第一版把昨收当区间的一个边界，第二版干脆满占当日高低。
  // 只要当天高开或单边下走（价格全在昨收一侧），曲线就被挤进半屏的一条窄带，
  // 这就是用户说的「分时图太扁」。
  // 算法（对齐 HQChart DefaultSplit 的口径，也是通达信实际的画法）：
  //   ① d = max(|当日最高-昨收|, |昨收-当日最低|)，含均价线，由真实走势决定；
  //   ② 纵轴严格写成 昨收 ± d，不向上取整到「整齐档位」——
  //      取整会把区间凭空撑大 20%~50%，曲线就被压到中间一小条，这正是「图太扁」的根。
  //      刻度标签数字不整齐没关系，分时图看的是相对昨收的位置，不是刻度本身。
  //   ③ 刻度格数固定 4 格（上下各 2 格），interval 从 d 直接除出来。
  //
  // 抽成独立函数是因为 3 秒 tick 越界时要单独重算这套轴（见 updateTimelineTail），
  // 两处必须用完全相同的算法，否则整图重绘与增量重绘的轴会互相打架。
  function timelinePriceAxis(s, prevClose) {
    let yMin, yMax, yInterval;
    const pc = prevClose != null ? Number(prevClose) : null;
    let lo = s.lo, hi = s.hi;
    for (const v of s.avg) { if (v != null) { if (lo == null || v < lo) lo = v; if (hi == null || v > hi) hi = v; } }

    // base 兜底链：优先昨收（对称轴的锚点），没有昨收时退到当日极值，
    // 再没有就用第一个有效价。三者全空说明这只票当日没有任何数据，
    // 此时不写 min/max，交给 ECharts 自适应（此时本来也没有涨跌参照可言）。
    let base = (pc != null && pc > 0) ? pc : null;
    if (base == null) base = hi != null ? hi : lo;
    if (base == null) {
      for (const v of s.price) { if (v != null) { base = v; break; } }
    }
    if (base != null && base > 0) {
      let d = 0;
      if (hi != null) d = Math.max(d, Math.abs(hi - base));
      if (lo != null) d = Math.max(d, Math.abs(base - lo));
      // 兜底：数据缺失或全天趴着不动（d≈0）时给一个最小视觉跨度，
      // 否则区间塌成一条线，ECharts 会把纵轴算成 0~0 然后报错。
      // 0.01 元是 A 股最小报价单位，够画出一条有意义的平线。
      const floorD = Math.max(base * 0.005, 0.01);
      if (!(d > 0)) d = floorD;
      else if (d < floorD) d = floorD;
      yInterval = Number(((2 * d) / 4).toFixed(6));
      // 浮点累加会留 25.200000000000003 这种尾巴，统一收到 6 位
      yMin = Number((base - d).toFixed(6));
      yMax = Number((base + d).toFixed(6));
      if (!(yMax > yMin)) {
        yMin = Number((base * 0.99).toFixed(6));
        yMax = Number((base * 1.01).toFixed(6));
        yInterval = Number(((yMax - yMin) / 4).toFixed(6));
      }
    }
    return { yMin, yMax, yInterval };
  }

  function buildTimelineOption(tl, quote) {
    const grids = buildGrids();
    const s = timelineSeries(tl, quote);
    const f = timelineFormulas(s.price);
    const cats = TIMELINE_SLOTS.map((t) => `${t.slice(0, 2)}:${t.slice(2)}`);
    const prevClose = tl.prevClose;

    // 分时纵轴：昨收中轴对称（通达信口径），算法统一在 timelinePriceAxis 里
    const axis0 = timelinePriceAxis(s, prevClose);
    const yMin = axis0.yMin, yMax = axis0.yMax, yInterval = axis0.yInterval;

    // 量比副图纵轴：算法统一在 timelineRatioAxis 里，3 秒 tick 越界时复用同一套
    const ratioAxis = timelineRatioAxis(s);
    const ratioMin = ratioAxis.min, ratioTop = ratioAxis.max, ratioInterval = ratioAxis.interval;

    // 成交量副图纵轴：同样固定下来，别让 ECharts 每 tick 自适应（否则横线读数自己漂）
    const volAxis = timelineVolAxis(s);
    const volTop = volAxis.max, volInterval = volAxis.interval;

    // 纵向参考线，口径对齐通达信：以开盘时刻为锚点每小时一条，不是自然整点。
    // 上午 09:30 起 → 10:30、11:30；下午 13:00 起 → 14:00（15:00 是右边界，不用画）。
    // 10:00 是额外加的那条，颜色极轻微地亮一点：十点是量比最关键的观察时点，
    // 要能一眼找到它落在横轴的哪里。
    // 为什么不用 xAxis.splitLine：category 轴会按每个类目画线，242 个槽就是 242 条竖线，
    // 满屏格纹。markLine 只画指定的几个位置，正合适。
    // 颜色必须压到几乎看不见：它是「辅助对齐」的，不能和曲线抢注意力。
    const HOUR_LINES = ['1030', '1130', '1400', '1000']
      .map((t) => ({ t, i: TIMELINE_SLOT_IDX.get(t) }))
      .filter((o) => o.i != null)
      .map((o) => ({
        xAxis: o.i,
        lineStyle: {
          type: 'solid',
          color: o.t === '1000' ? 'rgba(255,255,255,.13)' : 'rgba(255,255,255,.07)',
        },
      }));

    const priceSeries = {
      name: 'PRICE', type: 'line', data: s.price,
      xAxisIndex: 0, yAxisIndex: 0, symbol: 'none', smooth: false,
      lineStyle: { width: 1, color: '#d8e0dd' }, z: 3, connectNulls: false,
      // 昨收基准线：分时图的核心参照，跌到线下就是绿区；整点竖线与它共用同一个 markLine（一个 series 只能有一个）
      markLine: {
        silent: true, symbol: 'none', animation: false,
        label: { show: false },
        lineStyle: { color: '#4a5b56', type: 'dashed', width: 1 },
        data: [
          ...(prevClose != null ? [{ yAxis: prevClose }] : []),
          ...HOUR_LINES,
        ],
      },
    };
    const avgSeries = {
      name: 'AVG', type: 'line', data: s.avg,
      xAxisIndex: 0, yAxisIndex: 0, symbol: 'none', smooth: false,
      lineStyle: { width: 1, color: '#e8a33d' }, z: 2, connectNulls: false,
    };
    // 公式曲线：只有「中」和 M20 用实线（最常用），PP/HH 虚线细一档，避免 242 个点糊成一团。
    // 只画公式里 `:` 输出的四条；Z/M（`:=` 赋值）与 ZG/ZD（NODRAW）按通达信规则不上图。
    const formulaLine = (name, data, color, dashed) => ({
      name, type: 'line', data,
      xAxisIndex: 0, yAxisIndex: 0, symbol: 'none', smooth: false,
      lineStyle: { width: 1, color, type: dashed ? 'dashed' : 'solid', opacity: 0.85 },
      z: 1, connectNulls: false,
    });
    const formulaSeries = [
      formulaLine('中', f.mid, FORMULA_COLORS['中'], false),
      formulaLine('PP', f.pp, FORMULA_COLORS.PP, false),
      formulaLine('HH', f.hh, FORMULA_COLORS.HH, true),
      formulaLine('M20', f.ma20, FORMULA_COLORS.M20, false),
    ];
    const volSeries = {
      name: 'VOL', type: 'bar', barWidth: '60%', z: 2,
      xAxisIndex: 1, yAxisIndex: 1, data: s.vols,
      // 整点竖线贯穿到成交量副图，否则主图有竖线、副图断开，看着像画歪了
      markLine: { silent: true, symbol: 'none', animation: false, label: { show: false },
        lineStyle: { color: 'rgba(255,255,255,.07)' }, data: HOUR_LINES },
    };
    const ratioSeries = {
      name: 'RATIO', type: 'line', data: s.ratio,
      xAxisIndex: 2, yAxisIndex: 2, symbol: 'none', smooth: false,
      lineStyle: { width: 1, color: '#5ad2c8' }, z: 2, connectNulls: false,
      areaStyle: { color: 'rgba(90,210,200,.10)' },
      // 两条量比参照线：1.0 是「今日量与平时持平」，3 是「明显放量」。
      // 盘中看十点前后量比有没有上 3、有没有守住 1，都靠这两条线定位。
      markLine: {
        silent: true, symbol: 'none', animation: false,
        // 参照线只留线，不标数字：右侧明确不要任何刻度值，
        // 左侧只有轴端两个极值数字，1.0 / 3.0 的位置靠线的相对高低就能判断。
        label: { show: false },
        lineStyle: { color: '#3d4a46', type: 'dashed', width: 1 },
        data: [
          { yAxis: 1 },
          { yAxis: 3, lineStyle: { color: '#8a7a44' }, label: { color: '#8a7a44' } },
          ...HOUR_LINES,
        ],
      },
    };

    return {
      animation: false,
      backgroundColor: '#0d0f0e',
      grid: grids,
      xAxis: TIMELINE_PANELS.map((p, gi) => ({
        type: 'category', data: cats, gridIndex: gi, boundaryGap: true,
        axisLine: { lineStyle: { color: '#2a312f' } },
        axisTick: { show: false },
        splitLine: { show: false },
        // 底部时间标签交给 DOM 覆盖层（09:30 / 15:00 两端对齐，窄屏也不会被画布裁掉半个字）。
        // 轴内再画 13:00/14:00 会和右下角的 15:00 挤成一串，所以这里一律不画。
        axisLabel: { show: false },
        min: 'dataMin', max: 'dataMax',
      })),
      yAxis: TIMELINE_PANELS.map((p, gi) => ({
        // 量比副图刻度也挪到左边（右侧原来是刻度值所在的位置）。
        gridIndex: gi, scale: gi !== 0, position: gi === 1 ? 'right' : 'left',
        splitNumber: gi === 0 ? 4 : 2,
        // 量比副图：区间完全由 timelineRatioAxis 按当日实际极值算出（对齐通达信），
        // 这里只把算好的 min/max/interval 写进轴，不再钉死「0 起点、一格 1 单位、上限至少 4」。
        // 注意：轴跟着数据走，当全天量比明显高于 3（或整体低于 1）时，
        // 1.0 / 3.0 两条参照线会落到轴区间之外，ECharts 自然不画，这是预期行为。
        ...(gi === 2 ? { min: ratioMin, max: ratioTop, interval: ratioInterval } : {}),
        // 成交量副图：固定 0 起点 + 好读档位上限，理由见 timelineVolAxis。
        ...(gi === 1 ? { min: 0, max: volTop, interval: volInterval } : {}),
        // 价格轴用取整后的固定区间：min/max/interval 都给了就不再自适应，
        // interval 必须与 min/max 同一套档位，否则会标出 25.2125 这种刻度。
        ...(gi === 0 && yMin != null ? { min: yMin, max: yMax, interval: yInterval || (yMax - yMin) / 4 } : {}),
        // 量比副图不画等距网格线：只靠 1.0 / 3.0 两条参照线看水位，刻度数字也只在两端出现，
        // 满屏细线加一串数字会把副图本就窄的地方占满。
        splitLine: gi === 2 ? { show: false } : { lineStyle: { color: '#1b201f' } },
        axisLine: { show: false }, axisTick: { show: false },
        // 量比副图刻度值全部由 DOM 覆盖层自绘（见 layoutRatioLabels），轴上不再标任何数字。
        axisLabel: gi === 0
          ? { color: '#6f7b77', fontSize: 9, inside: true, formatter: (v) => fmtNum(v) }
          : { show: false },
      })),
      // 分时不需要缩放：把可视跨度锁死成全部 242 个槽，缩放/平移自然失效，
      // 这样手势层里那些读 dataZoom 的代码不用为分时再写一套分支。
      dataZoom: [{
        type: 'inside', xAxisIndex: TIMELINE_PANELS.map((_, i) => i), zoomLock: true,
        startValue: 0, endValue: TIMELINE_SLOTS.length - 1,
        minValueSpan: TIMELINE_SLOTS.length, maxValueSpan: TIMELINE_SLOTS.length,
        zoomOnMouseWheel: false, moveOnMouseMove: false, moveOnMouseWheel: false,
        preventDefaultMouseMove: true,
      }],
      series: [priceSeries, avgSeries, ...formulaSeries, volSeries, ratioSeries],
    };
  }

  function paintTimeline(slot, tl, quote) {
    const data = tl || state.timeline;
    if (!data || !data.points.length) {
      slot.chart.clear();
      slot.rows = [];
      // 清干净：留着上一只票的 dz/rects，手势层会拿旧区间算缩放/换股，容易直接崩
      slot.dz = { sv: 0, ev: 0 };
      slot.rects = null;
      slot.ratioAxis = null;
      if (slot.ratioLabels) { slot.ratioLabels.hi.textContent = ''; slot.ratioLabels.lo.textContent = ''; }
      return;
    }
    const opt = buildTimelineOption(data, quote);
    slot.rows = [];
    slot.chart.setOption(opt, { notMerge: true });
    slot.rects = readRects(slot.chart);
    // 量比副图的轴区间记在 slot 上，供覆盖层自绘两端极值数字用
    slot.ratioAxis = timelineRatioAxis(timelineSeries(data, quote));
    slot.dz = { sv: 0, ev: TIMELINE_SLOTS.length - 1 };
    layoutLegend(slot);
    // 底部分钟标签：左 09:30 / 右 15:00
    if (slot.dateLabels) {
      slot.dateLabels.left.textContent = '09:30';
      slot.dateLabels.right.textContent = '15:00';
    }
    layoutDateLabels(slot);
    layoutRatioLabels(slot);
    renderTimelineLegend(slot, data, quote);
  }

  // 十点量比：取 10:00 那一槽的量比值。
  // 十点那根的累计量还没从后端进来时该位算不出量比（null），显示 '-'；
  // 一过十点这个值就落定，之后再怎么刷新都读同一个位置，数值自然固定不变。
  function ratioAtTen(s) {
    if (!s || !s.ratio) return '-';
    const i = TIMELINE_SLOT_IDX.get('1000');
    if (i == null) return '-';
    const v = s.ratio[i];
    return (v != null && isFinite(v)) ? v.toFixed(2) : '-';
  }

  function renderTimelineLegend(slot, tlData, quoteData) {
    if (!slot || !slot.legendRows) return;
    const tl = tlData || state.timeline;
    const s = tl ? timelineSeries(tl, quoteData) : null;
    const q = quoteData !== undefined ? quoteData : state.quote;
    const lastPrice = s && s.live >= 0 ? s.price[s.live] : (s ? s.price[s.lastFilled] : null);
    const cur = q && Number(q.price) > 0 ? Number(q.price) : lastPrice;
    const avgVal = s && s.lastFilled >= 0 ? (s.live >= 0 ? s.avg[s.live] : s.avg[s.lastFilled]) : null;

    // 价格图那行：价格/均价 + 四条公式线（同一张图里的线，图例必须放在同一行，
    // 否则「中」「M20」跑到量比副图那行，看图的人会以为它们是量比的两个分量）。
    // 颜色必须与 buildTimelineOption 里 formulaLine 的 lineStyle.color 逐条一致。
    // 不再放「涨跌」：顶部行情条已经有 +0.41 / +1.63%，图例里再摆一遍纯占宽度，
    // 而宽度是这一行最紧的资源——多一项就会把 M20 挤到第二行。
    const f = s ? timelineFormulas(s.price) : null;
    const k = s && (s.live >= 0 ? s.live : s.lastFilled);
    const pick = (arr) => (f && k >= 0 && arr[k] != null ? fmtNum(arr[k]) : '-');
    slot.legendRows[0].innerHTML =
      legendItem('价格', '#d8e0dd', cur != null ? fmtNum(cur) : '-') +
      legendItem('均价', '#e8a33d', avgVal != null ? fmtNum(avgVal) : '-') +
      (f ? legendItem('中', FORMULA_COLORS['中'], pick(f.mid)) : '') +
      (f ? legendItem('PP', FORMULA_COLORS.PP, pick(f.pp)) : '') +
      (f ? legendItem('HH', FORMULA_COLORS.HH, pick(f.hh)) : '') +
      (f ? legendItem('M20', FORMULA_COLORS.M20, pick(f.ma20)) : '');

    // VOL 取「最新那一分钟」的成交量柱，不是全天累计量。
    // 这一行其余几格（价格、均价、量比）都是最新一刻的瞬时读数，量也要同口径；
    // 而且十字线点到某一分钟时显示的正是那根柱子的量，取消十字线回到最新值，
    // 读数才前后一致。全天累计量在上方行情条里已有，这里不再重复。
    const volBar = s && k >= 0 && s.vols[k] ? s.vols[k].value : null;
    slot.legendRows[1].innerHTML =
      legendItem('VOL', '#8a978f', volBar != null ? fmtVol(volBar) : '-');

    // 量比副图那行只放量比本身，和上面曲线行彻底分开。
    // 另外追加「十点量比」：十点是全天量能最关键的观察时点，盘中要盯这一格数字
    // 判断今天是不是放量。取的是 10:00 那一槽的量比值，不是当前值。
    const r = s && s.ratio;
    const rv = r ? r[(s.live >= 0 ? s.live : s.lastFilled)] : null;
    slot.legendRows[2].innerHTML =
      legendItem('量比', '#5ad2c8', rv != null && isFinite(rv) ? rv.toFixed(2) : '-') +
      legendItem('10点', '#8a7a44', ratioAtTen(s));
  }

  // 顶部行情条的固定字段。换股那一瞬间数据还没到手，也必须先把这些格子按同一套结构摆好：
  // 以前是整块清空、等数据回来再重建，行情条高度先塌后撑，下面的图跟着上下抖一下。
  // 现在无数据时也渲染同样的字段（数值统一显示 -），行数在第一次排版时就定下来。
  const TL_QUOTE_FIELDS = ['今开', '最高', '最低', '昨收', '成交量', '成交额'];
  const K_QUOTE_FIELDS = ['最高', '最低', '开盘', '量比', '振幅', '成交量', '成交额'];

  // 断网时看到的是本地留存的旧数据，必须在顶部说明两件事，避免被当成实时价：
  // 一是这份数据本身的行情日期，二是它是什么时候被存到本机的（留存时间）。
  // 只写行情日期不够——三天前存的和十分钟前存的，行情日期可能一样，用户没法判断新旧。
  // 联网时（payload 没有 cached 标记）默认隐藏，不留残留提示。
  function fmtMonthDay(v) {
    const s = String(v == null ? '' : v).replace(/\D/g, '').slice(0, 8);
    return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : '';
  }
  function fmtCacheStamp(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  function syncOfflineNotice(payload, dateText, stampTs) {
    const el = document.getElementById('chart-offline');
    if (!el) return;
    if (!payload || !payload.cached) { el.hidden = true; el.textContent = ''; return; }
    const parts = [];
    if (dateText) parts.push(`行情日期 ${dateText}`);
    const st = fmtCacheStamp(stampTs);
    if (st) parts.push(`留存于 ${st}`);
    const head = parts.length ? `离线数据（${parts.join('，')}）` : '离线数据';
    el.textContent = `${head}：当前无网络，显示的是本地留存的最近一次记录`;
    el.hidden = false;
  }

  // 顶部行情条（分时版）：通达信分时页顶部那组数值
  function renderTimelineQuote() {
    if (!els.quote) return;
    const tl = state.timeline;
    if (!tl || !tl.points.length) {
      syncOfflineNotice(null);   // 换股空档先收起提示，避免留着上一只票的"离线数据"
      els.quote.innerHTML =
        `<div class="q-main">` +
        `<span class="q-price">-</span>` +
        `<span class="q-chg">-</span>` +
        `<span class="q-date">&nbsp;</span>` +
        `</div>` +
        `<div class="q-grid"></div>`;
      fillQuoteGrid(els.quote.querySelector('.q-grid'), TL_QUOTE_FIELDS.map((k) => `${k} <b>-</b>`));
      return;
    }
    const q = state.quote;
    const s = timelineSeries(tl);
    const cur = q && Number(q.price) > 0 ? Number(q.price) : (s.lastFilled >= 0 ? s.price[s.lastFilled] : null);
    const prevClose = tl.prevClose;
    const diff = (prevClose && cur != null) ? cur - prevClose : null;
    const chg = (prevClose && cur != null) ? (cur - prevClose) / prevClose * 100 : null;
    const cls = (chg == null || chg >= 0) ? 'up' : 'down';
    const sign = (chg != null && chg >= 0) ? '+' : '';
    const open = q && Number(q.open) > 0 ? Number(q.open) : (s.price.find((v) => v != null) || null);
    const amount = q && Number(q.amount) > 0 ? Number(q.amount) : null;
    const dateText = tl.date ? `${tl.date.slice(0, 4)}-${tl.date.slice(4, 6)}-${tl.date.slice(6, 8)}` : '';
    syncOfflineNotice(state.srcTlCached ? { cached: true } : null, dateText, state.tlCacheTs);
    els.quote.innerHTML =
      `<div class="q-main">` +
      `<span class="q-price ${cls}">${cur != null ? fmtNum(cur) : '-'}</span>` +
      `<span class="q-chg ${cls}">${diff != null ? (diff >= 0 ? '+' : '') + diff.toFixed(2) : '-'} ` +
        `${chg != null ? sign + chg.toFixed(2) + '%' : ''}</span>` +
      `<span class="q-date">${dateText}</span>` +
      `</div>` +
      `<div class="q-grid"></div>`;
    fillQuoteGrid(els.quote.querySelector('.q-grid'), [
      `今开 <b>${open != null ? fmtNum(open) : '-'}</b>`,
      `最高 <b class="up">${s.hi != null ? fmtNum(s.hi) : '-'}</b>`,
      `最低 <b class="down">${s.lo != null ? fmtNum(s.lo) : '-'}</b>`,
      `昨收 <b>${prevClose != null ? fmtNum(prevClose) : '-'}</b>`,
      `成交量 <b>${q && Number(q.vol) > 0 ? fmtVol(Number(q.vol)) : (s.cum[s.lastFilled] != null ? fmtVol(s.cum[s.lastFilled]) : '-')}</b>`,
      // 成交额缺失时也保留格子（显示 -）：换股时先用邻票预取数据顶上，那份数据不含成交额，
      // 若整格省掉会少一行导致行情条高度跳变，等网络回来又长回来，视觉上仍是抖动。
      `成交额 <b>${amount != null ? fmtVol(amount) : '-'}</b>`,
    ]);
  }

  function renderTimeline() {
    const tl = state.timeline;
    if (!tl || !tl.points.length) {
      if (state.chart) state.chart.clear();
      // 换股瞬间没有数据时不能把行情条整块清掉：调占位渲染，字段名与行数先摆好，
      // 数据回来只换数字，高度不再变。
      renderTimelineQuote();
      // 空数据时把可视区间也归零，避免手势层拿着上一只票的区间算换股
      state.dz = { sv: 0, ev: 0 };
      state.gridRects = null;
      return;
    }
    paintTimeline(state.mainSlot);
    state.gridRects = state.mainSlot.rects;
    state.dz = state.mainSlot.dz;
    renderTimelineQuote();
  }

  // 把一组 K 线画进某个 slot（主图或预览图）
  function paint(slot, rows, cache, opts) {
    // 分时周期走独立绘制流程，与 K 线不是同一套 option
    if (state.period === 'min') return paintTimeline(slot);
    const { opt, startValue } = buildOption(rows, cache);
    slot.rows = rows; slot.cache = cache;
    slot.chart.setOption(opt, { notMerge: true });
    // 记录整图重绘时刻：3 秒 tick 的实时叠价据此节流，避免每 3 秒重建一次 option
    if (slot === state.mainSlot) state.lastPaintAt = Date.now();
    slot.rects = readRects(slot.chart);
    slot.dz = { sv: startValue, ev: Math.max(0, rows.length - 1) };
    const idx = rows.length - 1;
    layoutLegend(slot);
    layoutDateLabels(slot);
    renderLegend(slot, idx);
    updateDateLabels(slot, rows, slot.dz);
    return idx;
  }

  // 3 秒一次的实时刷新走这里：只把 series 的数据换掉，不重建整张 option。
  // 原先日线是「每 tick 只刷顶部数字，整图最多 8 秒重绘一次」，结果就是价格在跳、
  // 最后一根柱子却半分钟才动一次，看着像卡住。改成 merge 写入后柱子每 tick 跟着走，
  // 且因为没有 notMerge 重建，坐标轴/网格/图例都不会被拆掉，不会闪。
  function updateKlineTail(rows, cache, appended) {
    const slot = state.mainSlot;
    if (!slot || !slot.chart) return false;
    let series;
    try { series = buildSeries(rows, cache); } catch { return false; }
    const patch = { series };
    // 主图纵轴是 scale:true 且没写死 min/max，ECharts 在 merge 后自己按新数据重算范围，
    // 所以盘中创新高/新低不会被裁掉（这点和分时显式写死 min/max 的情况不同）。
    // 但类目轴不是这样：追加新的一根（跨日）时 x 轴的类目与 dataZoom 末端必须一起推，
    // 否则新柱会因为没有对应刻度而画不出来，或者被挤在可视窗口外面。
    if (appended) {
      patch.xAxis = PANELS.map(() => ({ data: rows.map(r => r.date) }));
      const prevEv = state.dz ? state.dz.ev : rows.length - 2;
      // 只有用户本来就停在尾巴上才跟着推；他正在翻历史就不该被拽走
      if (prevEv >= rows.length - 2) {
        patch.dataZoom = [{ endValue: rows.length - 1 }];
        state.dz = { sv: state.dz ? state.dz.sv : Math.max(0, rows.length - state.visibleBars), ev: rows.length - 1 };
        updateDateLabels(slot, rows, state.dz);
      }
    }
    try { slot.chart.setOption(patch); } catch { return false; }
    slot.rows = rows; slot.cache = cache;
    const idx = state.currentIdx >= 0 ? state.currentIdx : rows.length - 1;
    renderLegend(slot, idx);
    // 十字线打开时读数必须跟着最新价走，否则停在上一 tick 的价位上
    if (state.locked && state.currentIdx >= 0) renderCrosshair(state.currentIdx);
    return true;
  }

  // ---------- 主图渲染 ----------
  function render() {
    if (state.period === 'min') {
      renderTimeline();
      return;
    }
    if (!state.chart || !state.klines.length) {
      if (state.chart && !state.klines.length) state.chart.clear();
      // 同上：没有 K 线时也要把行情条摆成固定结构，不能留着上一只票的数字或整块空白
      renderQuote(-1);
      return;
    }
    renderQuote(state.klines.length - 1);
    paint(state.mainSlot, state.klines, state);
    state.gridRects = state.mainSlot.rects;
    state.dz = state.mainSlot.dz;
    renderLegend(state.mainSlot, state.currentIdx >= 0 ? state.currentIdx : state.klines.length - 1);
  }

  function legendItem(label, color, value) {
    return `<span class="cl-item"><i style="background:${color}"></i>${label} <b>${value}</b></span>`;
  }

  // 渲染某 slot 各 panel 的指标数值；idx 为十字线所在 K 线（未锁定时取最后一根）
  function renderLegend(slot, idx) {
    if (!slot) return;
    const rows = slot.rows, cache = slot.cache;
    if (!rows.length || !cache) return;
    const i = Math.max(0, Math.min(idx == null ? rows.length - 1 : idx, rows.length - 1));
    const ma = cache.maCache || {}, macd = cache.macd || {};
    const num = (v, d = 2) => (v == null || !isFinite(v)) ? '-' : Number(v).toFixed(d);

    // panel 0：K 线 + 均线
    slot.legendRows[0].innerHTML =
      legendItem('MA5', MA_COLORS.ma5, num(ma.ma5 && ma.ma5[i])) +
      legendItem('MA10', MA_COLORS.ma10, num(ma.ma10 && ma.ma10[i])) +
      legendItem('MA20', MA_COLORS.ma20, num(ma.ma20 && ma.ma20[i])) +
      legendItem('MA60', MA_COLORS.ma60, num(ma.ma60 && ma.ma60[i]));

    // panel 1：成交量 + 5 日均量（与直方图同量纲，按手/万格式化）
    const volMa5 = cache.volMa5;
    slot.legendRows[1].innerHTML =
      legendItem('VOL', '#8a978f', fmtVol(rows[i].vol)) +
      legendItem('MA5', '#e8a33d', volMa5 && volMa5[i] != null ? fmtVol(volMa5[i]) : '-');

    // panel 2：MACD
    slot.legendRows[2].innerHTML =
      legendItem('DIF', '#e8a33d', num(macd.dif && macd.dif[i], 3)) +
      legendItem('DEA', '#3d7ee8', num(macd.dea && macd.dea[i], 3)) +
      legendItem('MACD', (macd.hist && macd.hist[i] >= 0) ? UP : DOWN, num(macd.hist && macd.hist[i], 3));

    // panel 3：振幅（%）+ 100 日振幅均线
    const amp = cache.amp || {};
    slot.legendRows[3].innerHTML =
      legendItem('振幅', '#5ad2c8', amp.amp && amp.amp[i] != null ? num(amp.amp[i]) + '%' : '-') +
      legendItem('PJ', '#e8d33d', amp.pj && amp.pj[i] != null ? num(amp.pj[i]) + '%' : '-');
  }

  function layoutLegend(slot) {
    if (!slot || !slot.legendRows) return;
    const panels = activePanels();
    slot.legendRows.forEach((row, gi) => {
      const r = slot.rects[gi];
      if (!r || !row) { if (row) row.style.display = 'none'; return; }
      row.style.display = '';
      // 同一 panel 有多行图例时，第一行贴着网格顶边，后续行依次往上叠；
      // 网格顶部预留的高度就是 legendReserve(panel)，正好覆盖这几行。
      // 这里从上往下数：最后一行的底边贴网格顶，第一行在最上面。
      const n = panels[gi] && panels[gi].legendRows ? panels[gi].legendRows : 1;
      row.style.top = (r.y - LEGEND_ROW_H * n - LEGEND_GAP) + 'px';
      // 行内 flex-wrap，高度由内容决定；只有一行时不需要撑高
      row.style.minHeight = LEGEND_ROW_H + 'px';
      row.style.left = r.x + 'px';
      row.style.width = r.width + 'px';
    });
  }

  // ---------- 底部日期（DOM 覆盖层，两端对齐，窄屏也能完整显示） ----------
  // 首个日期左对齐、末个日期右对齐贴在最下方 panel 底边；不像轴内刻度那样居中挂在首尾 K 线上，
  // 因此不会被画布边缘裁掉半个字。
  function layoutDateLabels(slot) {
    if (!slot || !slot.dateLabels) return;
    const rect = slot.rects.slice().reverse().find(Boolean);
    if (!rect) return;
    // 分时：标签放到网格下沿之外，避免和量比轴首尾两个刻度数字叠在一起；
    // 日线/周线维持原来的「贴在网格内侧底边」。
    const y = state.period === 'min' ? rect.y + rect.height + 3 : rect.y + rect.height - 13;
    const l = slot.dateLabels.left, r = slot.dateLabels.right;
    l.style.left = rect.x + 'px'; l.style.top = y + 'px'; l.style.transform = 'none';
    r.style.left = (rect.x + rect.width) + 'px'; r.style.top = y + 'px'; r.style.transform = 'translateX(-100%)';
  }
  // 量比副图的两个极值数字：贴在面板内侧，上沿标当日最高、下沿标当日最低。
  // 之所以不用 ECharts 自己的轴刻度文字：它按刻度值在轴上「上下居中」摆，
  // 首尾两个刻度各有一半伸出面板框外，往上顶到「量比」图例行、往下压住时间标签。
  // 覆盖层可以上沿顶齐、下沿贴齐，文字整个落在面板里面。
  function layoutRatioLabels(slot) {
    if (!slot || !slot.ratioLabels) return;
    const els2 = slot.ratioLabels;
    // 非分时周期没有量比副图，别留两个孤零零的数字在 K 线图上
    if (state.period !== 'min') {
      els2.hi.textContent = ''; els2.lo.textContent = '';
      return;
    }
    const ax = slot.ratioAxis;
    const rect = slot.rects && slot.rects[2];
    if (!ax || !rect) {
      els2.hi.textContent = ''; els2.lo.textContent = '';
      return;
    }
    // 数字用「当日真实最高/最低量比」，不是轴端边界 —— 轴为了兜住 1.0/3.0 参照线会往外扩，
    // 把扩出来的边界当成峰值会读高/读低（例如全天最高 1.2，轴兜到 3，标 3 就是假数字）。
    const hiV = ax.hi != null ? ax.hi : ax.max;
    const loV = ax.lo != null ? ax.lo : ax.min;
    els2.hi.textContent = fmtRatioText(hiV);
    els2.lo.textContent = fmtRatioText(loV);
    // 位置按该数值在轴上对应的像素走（刻度语义，读数与高度一致），
    // 再夹进面板内侧，保证文字整个落在框里，不伸出压到图例或时间标签。
    const clampY = (y, text) => {
      if (y == null || !isFinite(y)) return rect.y + 1;
      const limitTop = rect.y + 1;
      const limitBottom = rect.y + rect.height - 12;
      return Math.max(limitTop, Math.min(limitBottom, y - 5));
    };
    const chart = slot.chart;
    let hiY = null, loY = null;
    try {
      const a = chart.convertToPixel({ yAxisIndex: 2 }, hiV);
      const b = chart.convertToPixel({ yAxisIndex: 2 }, loV);
      hiY = Array.isArray(a) ? a[0] : a;
      loY = Array.isArray(b) ? b[0] : b;
    } catch { /* 拿不到像素就退回贴边 */ }
    let hiTop = clampY(hiY, 'hi');
    let loTop = clampY(loY, 'lo');
    // 量比全天几乎横着走（0.98~1.02 这种）时，两个数字会叠在一起变成一团糊字。
    // 重叠就按固定行高把下面那个推开，保证两个读数都看得清。
    if (loTop < hiTop + 12) loTop = Math.min(rect.y + rect.height - 12, hiTop + 12);
    if (hiTop > loTop - 12) hiTop = Math.max(rect.y + 1, loTop - 12);
    // 注意：这里必须写已经做过重叠避让的 hiTop/loTop。早先写回的是 clampY 原值，
    // 避让算完就丢了 —— 量比全天横着走（两个数字几乎同高）时两个字会叠成一团。
    els2.hi.style.left = (rect.x + 2) + 'px';
    els2.hi.style.top = hiTop + 'px';
    els2.lo.style.left = (rect.x + 2) + 'px';
    els2.lo.style.top = loTop + 'px';
  }

  function updateDateLabels(slot, rows, dz) {
    if (!slot || !slot.dateLabels) return;
    const labels = slot.dateLabels;
    if (!rows || !rows.length) { labels.left.textContent = ''; labels.right.textContent = ''; return; }
    const d = dz || { sv: 0, ev: rows.length - 1 };
    const sv = Math.max(0, Math.min(rows.length - 1, d.sv));
    const ev = Math.max(0, Math.min(rows.length - 1, d.ev));
    const fmt = (x) => String(x).slice(5);
    labels.left.textContent = fmt(rows[sv].date);
    labels.right.textContent = fmt(rows[ev].date);
  }

  // 顶部指标区按“行”摆：先按实际可用宽度算出每行放几项，再把这些项在行内均分铺开。
  // 这样既不会出现“右侧还剩一截、最后一项却被挤到下一行”，也不会出现第二行孤零零只剩一项。
  function fillQuoteGrid(grid, items) {
    if (!grid) return;
    const list = (items || []).filter(Boolean);
    if (!list.length) { grid.innerHTML = ''; return; }
    const avail = grid.clientWidth;
    const gap = 12;

    // 抽屉刚展开那一帧容器可能还没拿到宽度，此时量不出真实宽度、分不出行，
    // 直接下一帧再排一次，避免把七项硬塞成一行后右侧被裁掉。
    if (!avail) {
      if (!grid.__retry) {
        grid.__retry = true;
        requestAnimationFrame(() => {
          grid.__retry = false;
          fillQuoteGrid(grid, items);
        });
      }
      return;
    }
    grid.__retry = false;

    // 离屏量一遍各项的真实宽度（同字号同字体，量出来才准）
    const widths = [];
    if (avail) {
      const probe = document.createElement('div');
      probe.style.cssText = 'position:fixed;left:-9999px;top:0;visibility:hidden;white-space:nowrap;font-size:12px;';
      list.forEach((html) => {
        const sp = document.createElement('span');
        sp.style.cssText = 'display:inline-block;white-space:nowrap;';
        // 量宽时把数值统一替换成同一宽度的假数值再量：
        // 否则换股瞬间占位的“-”比真实数值窄，按占位量出来的行数可能与数据回来后的行数不一致，
        // 高度照样会跳一下。统一宽度后，行数只跟字段名有关、与具体数值无关，一次定死。
        // 取偏宽的值（含成交量“万/亿”单位共 7~8 字符），宁可略微保守也不能量窄，量窄会溢出。
        sp.innerHTML = String(html).replace(/<b(\s[^>]*)?>[\s\S]*?<\/b>/g, '<b$1>8888.88</b>');
        probe.appendChild(sp);
      });
      document.body.appendChild(probe);
      Array.from(probe.children).forEach((sp) => widths.push(sp.getBoundingClientRect().width));
      probe.remove();
    }

    const fits = (perRow) => {
      for (let s = 0; s < widths.length; s += perRow) {
        const seg = widths.slice(s, s + perRow);
        if (seg.reduce((a, b) => a + b, 0) + gap * (seg.length - 1) > avail + 0.5) return false;
      }
      return true;
    };

    // avail 为 0（抽屉未展开、容器被隐藏）时拿不到宽度，量宽也一并跳过，
    // 此时必须退化成“每行放全部”，否则 perRow 会算成 0，下面的分行循环 i += 0 会直接卡死页面。
    let perRow = list.length;
    if (avail && widths.length === list.length) {
      perRow = widths.length;
      while (perRow > 1 && !fits(perRow)) perRow -= 1;
      // 行数定了以后尽量把项数摊匀（7 项两行 → 4+3，而不是 5+2），摊匀后放不下再退回最紧的排法
      const rowCount = Math.ceil(widths.length / perRow);
      if (rowCount > 1) {
        const balanced = Math.ceil(widths.length / rowCount);
        if (fits(balanced)) perRow = balanced;
      }
    }

    const rows = [];
    for (let i = 0; i < list.length; i += perRow) rows.push(list.slice(i, i + perRow));
    grid.innerHTML = rows
      .map((r) => `<div class="q-row" style="grid-template-columns:repeat(${r.length},max-content)">` +
        r.map((html) => `<span>${html}</span>`).join('') + '</div>')
      .join('');
  }

  function fmtNum(v) { return Math.abs(v) >= 1000 ? v.toFixed(0) : v.toFixed(2); }
  function fmtVol(v) {
    // 万/亿一律保留两位小数：原先取整会把 1.8 万显示成 1 万，量级差太远看不出放量缩量
    if (v >= 1e8) return (v / 1e8).toFixed(2) + '亿';
    if (v >= 1e4) return (v / 1e4).toFixed(2) + '万';
    return String(Math.round(v));
  }

  // 只滚动不重设 yAxis，避免每次移动都触发 y 轴重算导致“对角线漂移”
  function applyZoomDelta(factor) {
    // 分时图固定展示全天 242 个槽，不允许缩放（缩放会把分时的时间轴压成畸形）
    if (state.period === 'min') return;
    const dz = state.chart.getOption().dataZoom[0];
    const span = dz.endValue - dz.startValue + 1;
    let newSpan = Math.round(span * factor);
    newSpan = Math.max(20, Math.min(newSpan, Math.min(260, state.klines.length)));
    if (newSpan === span) return;
    // 锚定右端（最新一根）：放大时保持最新 K 线可见，避免“放大后最新 K 线消失”
    const last = state.klines.length - 1;
    let ev = Math.min(Math.floor(dz.endValue), last);
    let sv = ev - newSpan + 1;
    if (sv < 0) { sv = 0; ev = newSpan - 1; }
    if (ev > last) { ev = last; sv = ev - newSpan + 1; }
    state.chart.dispatchAction({ type: 'dataZoom', startValue: sv, endValue: ev });
    state.visibleBars = newSpan;
  }

  function resetZoom() {
    const n = state.klines.length;
    const vis = Math.min(120, n);
    state.chart.dispatchAction({ type: 'dataZoom', startValue: Math.max(0, n - vis), endValue: n - 1 });
    state.visibleBars = vis;
  }

  // ---------- 十字线（自绘，遍历所有 panel 网格） ----------
  function ensureCrosshair() {
    if (state.crosshair) return state.crosshair;
    const zr = state.chart.getZr();
    const g = new echarts.graphic.Group({ zlevel: 100, z: 10000 });
    const mk = (Ctor) => { const o = new Ctor({ zlevel: 100, z: 10000, silent: true }); return o; };
    const vLine = mk(echarts.graphic.Line), hLine = mk(echarts.graphic.Line);
    const priceRect = mk(echarts.graphic.Rect), priceText = mk(echarts.graphic.Text);
    const dateRect = mk(echarts.graphic.Rect), dateText = mk(echarts.graphic.Text);
    [vLine, hLine, priceRect, priceText, dateRect, dateText].forEach(el => g.add(el));
    zr.add(g);
    state.crosshair = { g, vLine, hLine, priceRect, priceText, dateRect, dateText };
    return state.crosshair;
  }

  const measureCanvas = document.createElement('canvas');
  const measureCtx = measureCanvas.getContext('2d');
  function measureText(text, font) {
    measureCtx.font = font || '10px Inter, sans-serif';
    return measureCtx.measureText(text).width;
  }

  function hideCrosshair() {
    state.locked = false;                       // 解锁：恢复拖动平移
    state.crossY = null;
    state.crossYPanel = null;
    state.crosshairIdx = -1;
    // 关键：十字线一关，图例读数必须立刻回到「最新」那一条。
    // 十字线打开时图例被改写成「所指时刻」的值，关掉时如果只是把线藏起来、
    // 不重画图例，价格/成交量/量比就会一直停在十字线消失前那一刻的数字上，
    // 看着像行情不动了。这里按周期重画一次默认图例（分时取最后一槽，K 线取最后一根）。
    restoreLegendLatest();
    if (!state.crosshair) return;
    state.crosshair.g.hide();
    state.chart.getZr().refresh();
  }

  // 把图例恢复成「最新一笔」的读数（十字线关闭、换股、周期切换后的默认状态）
  function restoreLegendLatest() {
    const slot = state.mainSlot;
    if (!slot) return;
    if (state.period === 'min') {
      if (slot.legendRows && state.timeline) renderTimelineLegend(slot);
      renderTimelineQuote();
      return;
    }
    if (slot.legendRows && slot.rows && slot.rows.length) {
      const last = slot.rows.length - 1;
      renderLegend(slot, last);
      // 顶部行情条也是「当前这根 K 线」的读数：十字线期间被改成了所指那天的数字，
      // 关掉十字线必须一起回到最后一根，否则价格/涨跌/最高最低/成交额会停在历史某天。
      renderQuote(last);
    }
  }

  function renderCrosshair(index) {
    if (state.period === 'min') return renderCrosshairMin(index);
    const rows = state.klines;
    if (index < 0 || index >= rows.length) { hideCrosshair(); return; }
    const c = ensureCrosshair();
    const row = rows[index];
    const cx = state.chart.convertToPixel({ xAxisIndex: 0 }, row.date);
    if (cx == null || !isFinite(cx)) { hideCrosshair(); return; }
    const rect0 = state.gridRects[0] || state.gridRects.find(Boolean);
    if (!rect0) { hideCrosshair(); return; }
    const topY = Math.min(...state.gridRects.filter(Boolean).map(r => r.y));
    const botY = Math.max(...state.gridRects.filter(Boolean).map(r => r.y + r.height));
    const vx = Math.round(cx) + 0.5;

    c.vLine.show();
    c.vLine.setShape({ x1: vx, y1: topY, x2: vx, y2: botY });
    c.vLine.setStyle({ stroke: '#8a978f', lineWidth: 1, lineDash: [3, 3] });

    // 价格横线：主图（gridIndex 0）
    const cy = state.chart.convertToPixel({ yAxisIndex: 0 }, row.c);
    if (cy != null && isFinite(cy)) {
      const hy = Math.round(cy) + 0.5;
      const left = rect0.x, right = rect0.x + rect0.width;
      c.hLine.show();
      c.hLine.setShape({ x1: left, y1: hy, x2: right, y2: hy });
      c.hLine.setStyle({ stroke: '#8a978f', lineWidth: 1, lineDash: [3, 3] });

      const txt = fmtNum(row.c);
      const fs = 11, fh = 16;
      const fonts = `${fs}px Inter, "PingFang SC", "Microsoft YaHei", sans-serif`;
      const w = measureText(txt, fonts) + 12;
      c.priceRect.show(); c.priceText.show();
      c.priceRect.setShape({ x: left, y: hy - fh / 2, width: w, height: fh, r: 2 });
      c.priceRect.setStyle({ fill: '#17231f' });
      // zrender 文本对齐用 align / verticalAlign（非 textAlign），并留足宽度避免文字被裁
      c.priceText.setStyle({ text: txt, fill: '#fff', font: fonts, align: 'center', verticalAlign: 'middle' });
      c.priceText.setPosition([left + w / 2, hy]);
    } else { c.hLine.hide(); c.priceRect.hide(); c.priceText.hide(); }

    // 日期标签：贴主图底部
    const label = String(row.date);
    const dfs = 11, dfh = 16;
    const dfonts = `${dfs}px Inter, "PingFang SC", "Microsoft YaHei", sans-serif`;
    const dw = measureText(label, dfonts) + 12;
    let dx = cx - dw / 2;
    dx = Math.max(rect0.x, Math.min(dx, rect0.x + rect0.width - dw));
    c.dateRect.show(); c.dateText.show();
    c.dateRect.setShape({ x: dx, y: rect0.y + rect0.height - dfh / 2, width: dw, height: dfh, r: 2 });
    c.dateRect.setStyle({ fill: '#17231f' });
    c.dateText.setStyle({ text: label, fill: '#fff', font: dfonts, align: 'center', verticalAlign: 'middle' });
    c.dateText.setPosition([dx + dw / 2, rect0.y + rect0.height]);
    state.locked = true;                        // 锁定：左右拖动改为移动十字线
    c.g.show();
    state.chart.getZr().refresh();
    renderQuote(index);
    renderLegend(state.mainSlot, index);
  }

  // ---------- 分时十字线 ----------
  // 与 K 线十字线的差别：横线不是「某根 K 线的收盘价」，而是一条可以上下拖着走的读数线，
  // 用来量某个价位对应的涨幅。竖线仍锚在分钟槽位上（跟随槽位列，不随像素漂移）。
  function minSlotX(idx) {
    const r = state.gridRects[0];
    if (!r) return null;
    const n = TIMELINE_SLOTS.length;
    return r.x + ((idx + 0.5) / n) * r.width;
  }

  // 像素 ↔ 数值互转：axisIndex 即面板序号（0 价格 / 1 成交量 / 2 量比），
  // 三个副图各有自己的 yAxis，读数必须用所在面板那一条轴换算。
  function valueAtY(y, axisIndex) {
    const v = state.chart.convertFromPixel({ yAxisIndex: axisIndex }, y);
    return Array.isArray(v) ? v[0] : v;
  }

  function valueToY(val, axisIndex) {
    const v = state.chart.convertToPixel({ yAxisIndex: axisIndex }, val);
    return Array.isArray(v) ? v[0] : v;
  }

  function minValueAtY(y) {
    const r = state.gridRects[0];
    if (!r) return null;
    return valueAtY(y, 0);
  }

  function minYAtValue(val) {
    return valueToY(val, 0);
  }

  // 横线落在哪个面板：面板之间有空隙，落在空隙里归到下面那一层，
  // 免得横线经过分界处时读数突然变成「无」。
  function crossPanelAtY(y) {
    const rects = state.gridRects;
    if (!rects || !rects.length) return 0;
    let lastIdx = 0;
    for (let i = 0; i < rects.length; i++) {
      const r = rects[i];
      // 空位必须跳过，但下标 i 恰好就是该面板的 gridIndex，所以返回值仍用 i 而不是计数序号。
      if (!r) continue;
      lastIdx = i;
      if (y <= r.y + r.height) return i;
    }
    // 落在最后一个面板下沿之外时归到「最后一个存在」的面板，不能直接拿 length-1，
    // 末位为空槽时那是个不存在的轴号，换算读数会抛错或得出无意义数字。
    return lastIdx;
  }

  function renderCrosshairMin(index) {
    const tl = state.timeline;
    if (!tl || !tl.points.length) { hideCrosshair(); return; }
    // 索引无效（-1 = 无当前位置）时直接收起，不能钳到 0：
    // 钳到 0 会在开盘第一分钟画线，并把状态锁上，之后拖动就变成移动十字线而不是换股。
    if (!(index >= 0)) { hideCrosshair(); return; }
    const n = TIMELINE_SLOTS.length;
    const idx = Math.min(n - 1, index);
    const cx = minSlotX(idx);
    if (cx == null || !isFinite(cx)) { hideCrosshair(); return; }
    const rects = state.gridRects.filter(Boolean);
    if (!rects.length) { hideCrosshair(); return; }
    const topY = Math.min(...rects.map((r) => r.y));
    const botY = Math.max(...rects.map((r) => r.y + r.height));
    const rect0 = state.gridRects[0];

    const c = ensureCrosshair();
    const vx = Math.round(cx) + 0.5;
    c.vLine.show();
    c.vLine.setShape({ x1: vx, y1: topY, x2: vx, y2: botY });
    c.vLine.setStyle({ stroke: '#8a978f', lineWidth: 1, lineDash: [3, 3] });

    // 横线：位置由 state.crossY 决定（像素），可贯穿整个图面（主图 + 各副图），
    // 和通达信一样，一路往下拖能走进成交量、量比副图，不会被卡在价格面板底边。
    let y = state.crossY;
    if (y == null || !isFinite(y)) y = minYAtValue(state.timeline.prevClose);
    if (y == null || !isFinite(y)) y = rect0.y + rect0.height / 2;
    y = Math.max(topY, Math.min(botY, y));
    state.crossY = y;
    // 横线落在哪个面板，读数就用那条轴换算（1=成交量 2=量比）
    const hp = crossPanelAtY(y);
    state.crossYPanel = hp;
    const hy = Math.round(y) + 0.5;
    c.hLine.show();
    c.hLine.setShape({ x1: rect0.x, y1: hy, x2: rect0.x + rect0.width, y2: hy });
    c.hLine.setStyle({ stroke: '#8a978f', lineWidth: 1, lineDash: [3, 3] });

    // 横线读数：价格面板显示「价格 + 相对昨收涨跌幅」（分时看的是涨跌幅，光有价格不够直观）；
    // 落到成交量子图显示成交量，落到量比子图显示量比，否则拿价格轴去换算副图像素会得出荒唐数值。
    const pc = tl.prevClose != null ? Number(tl.prevClose) : null;
    let txt = '-';
    let fill = '#17231f';
    if (hp === 0) {
      const val = minValueAtY(y);
      if (val != null && isFinite(val)) {
        txt = fmtNum(val);
        if (pc) {
          const pct = (val - pc) / pc * 100;
          txt = `${fmtNum(val)} ${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
          fill = pct >= 0 ? '#8c2f2f' : '#1f6b45';
        }
      }
    } else if (hp === 1) {
      const vol = valueAtY(y, 1);
      // 成交量子图是自适应轴，拖到面板最下沿时 convertFromPixel 可能返回略小于 0 的值；
      // 量不可能为负，钳到 0 免得出现「量 -2.3万」这种荒唐读数。
      if (vol != null && isFinite(vol)) txt = `量 ${fmtVol(Math.max(0, vol))}`;
      fill = '#1c2a33';
    } else {
      const rr = valueAtY(y, 2);
      // 同理，量比下限是 0，一旦越界拖到轴外就夹回 0。
      if (rr != null && isFinite(rr)) txt = `量比 ${Number(Math.max(0, rr)).toFixed(2)}`;
      fill = '#2b2a1c';
    }
    const fs = 11, fh = 16;
    const fonts = `${fs}px Inter, "PingFang SC", "Microsoft YaHei", sans-serif`;
    const w = measureText(txt, fonts) + 12;
    // 标签贴右边（分时价格刻度在左侧 inside，右边空着，不打架）
    const rx = Math.max(rect0.x, rect0.x + rect0.width - w);
    // 纵向夹在图面内：横线拖到量比副图最下沿时，标签框下半截会掉出画布被裁掉，
    // 「量比 0.00」只剩上面半行，看着像坏了。
    const ry = Math.max(topY, Math.min(botY - fh, hy - fh / 2));
    c.priceRect.show(); c.priceText.show();
    c.priceRect.setShape({ x: rx, y: ry, width: w, height: fh, r: 2 });
    c.priceRect.setStyle({ fill });
    c.priceText.setStyle({ text: txt, fill: '#fff', font: fonts, align: 'center', verticalAlign: 'middle' });
    c.priceText.setPosition([rx + w / 2, ry + fh / 2]);

    // 时间标签：贴最下方 panel 底边
    const slotT = TIMELINE_SLOTS[idx];
    const label = `${slotT.slice(0, 2)}:${slotT.slice(2)}`;
    const dfs = 11, dfh = 16;
    const dfonts = `${dfs}px Inter, "PingFang SC", "Microsoft YaHei", sans-serif`;
    const dw = measureText(label, dfonts) + 12;
    let dx = cx - dw / 2;
    dx = Math.max(rect0.x, Math.min(dx, rect0.x + rect0.width - dw));
    const bottomRect = rects[rects.length - 1];
    c.dateRect.show(); c.dateText.show();
    c.dateRect.setShape({ x: dx, y: bottomRect.y + bottomRect.height - dfh / 2, width: dw, height: dfh, r: 2 });
    c.dateRect.setStyle({ fill: '#17231f' });
    c.dateText.setStyle({ text: label, fill: '#fff', font: dfonts, align: 'center', verticalAlign: 'middle' });
    c.dateText.setPosition([dx + dw / 2, bottomRect.y + bottomRect.height]);

    state.locked = true;
    state.crosshairIdx = idx;
    c.g.show();
    state.chart.getZr().refresh();
    renderTimelineLegendAt(idx);
  }

  // 分时十字线所在槽位的读数：价格/均价/公式曲线 + 量 + 量比
  // 结构必须与 renderTimelineLegend 完全一致（公式线归价格行、量比单独一行），
  // 否则锁定十字线时「中」「M20」会跳到量比副图那行，解锁后又跳回来。
  function renderTimelineLegendAt(idx) {
    const slot = state.mainSlot;
    const tl = state.timeline;
    if (!slot || !slot.legendRows || !tl) return;
    const s = timelineSeries(tl);
    const f = timelineFormulas(s.price);
    const k = Math.max(0, Math.min(s.price.length - 1, idx));
    const num = (v) => (v == null || !isFinite(v)) ? '-' : fmtNum(v);
    const p = s.price[k];
    slot.legendRows[0].innerHTML =
      legendItem('价格', '#d8e0dd', num(p)) +
      legendItem('均价', '#e8a33d', num(s.avg[k])) +
      legendItem('中', FORMULA_COLORS['中'], num(f.mid[k])) +
      legendItem('PP', FORMULA_COLORS.PP, num(f.pp[k])) +
      legendItem('HH', FORMULA_COLORS.HH, num(f.hh[k])) +
      legendItem('M20', FORMULA_COLORS.M20, num(f.ma20[k]));
    const vol = s.vols[k] && s.vols[k].value;
    slot.legendRows[1].innerHTML =
      legendItem('VOL', '#8a978f', vol != null ? fmtVol(vol) : '-');
    const rv = s.ratio[k];
    slot.legendRows[2].innerHTML =
      legendItem('量比', '#5ad2c8', rv != null && isFinite(rv) ? rv.toFixed(2) : '-') +
      legendItem('10点', '#8a7a44', ratioAtTen(s));
  }

  function indexAtPoint(pt) {
    const rect0 = state.gridRects[0];
    if (!rect0) return -1;
    if (pt[1] < Math.min(...state.gridRects.filter(Boolean).map(r => r.y)) ||
        pt[1] > Math.max(...state.gridRects.filter(Boolean).map(r => r.y + r.height))) return -1;
    if (state.period === 'min') {
      // 分时：没有 K 线行，索引就是槽位号；上下拖动只移动横线，不改槽位。
      const n = TIMELINE_SLOTS.length;
      let x = state.chart.convertFromPixel({ xAxisIndex: 0 }, pt[0]);
      if (Array.isArray(x)) x = x[0];
      const idx = Math.round(x);
      if (!isFinite(idx) || idx < 0 || idx >= n) return -1;
      return idx;
    }
    let x = state.chart.convertFromPixel({ xAxisIndex: 0 }, pt[0]);
    if (Array.isArray(x)) x = x[0];
    let idx = Math.round(x);
    const dz = state.chart.getOption().dataZoom[0];
    idx = Math.max(Math.ceil(dz.startValue), Math.min(Math.floor(dz.endValue), idx));
    if (idx < 0 || idx >= state.klines.length) return -1;
    return idx;
  }

  // 顶部行情条：价、涨跌幅、最高、最低、量比、成交量等（参考通达信）
  function renderQuote(index) {
    if (!els.quote) return;
    const rows = state.klines;
    if (!rows.length) {
      // 换股瞬间新票的 K 线还没到手：先把固定字段按同一套结构摆好（数值显示 -），
      // 行数在这一刻就定下来，数据回来只换数字，行情条高度不再塌一下再撑开。
      syncOfflineNotice(null);
      els.quote.innerHTML =
        `<div class="q-main">` +
        `<span class="q-price">-</span>` +
        `<span class="q-chg">-</span>` +
        `<span class="q-date">&nbsp;</span>` +
        `</div>` +
        `<div class="q-grid"></div>`;
      fillQuoteGrid(els.quote.querySelector('.q-grid'), K_QUOTE_FIELDS.map((k) => `${k} <b>-</b>`));
      return;
    }
    const i = Math.max(0, Math.min(index == null ? rows.length - 1 : index, rows.length - 1));
    const row = rows[i];
    // 断网时这份 K 线来自本地留存，明确标出数据日期与留存时刻
    syncOfflineNotice(state.srcCached ? { cached: true } : null,
      row.date ? fmtMonthDay(row.date) : '', state.cacheTs);
    const prev = rows[i - 1] || row;
    const chg = prev.c ? (row.c - prev.c) / prev.c * 100 : 0;
    const diff = prev.c ? row.c - prev.c : 0;
    const cls = chg >= 0 ? 'up' : 'down';
    const sign = chg >= 0 ? '+' : '';
    const amp = prev.c ? (row.h - row.l) / prev.c * 100 : 0;
    // 量比：当日量 / 前 5 日均量（不含当日）
    let vr = null;
    if (i >= 5) {
      let s = 0;
      for (let k = i - 5; k < i; k++) s += rows[k].vol;
      const avg = s / 5;
      if (avg > 0) vr = row.vol / avg;
    }
    els.quote.innerHTML =
      `<div class="q-main">` +
      `<span class="q-price ${cls}">${fmtNum(row.c)}</span>` +
      `<span class="q-chg ${cls}">${sign}${diff.toFixed(2)} ${sign}${chg.toFixed(2)}%</span>` +
      `<span class="q-date">${row.date}</span>` +
      `</div>` +
      `<div class="q-grid"></div>`;
    fillQuoteGrid(els.quote.querySelector('.q-grid'), [
      `最高 <b class="up">${fmtNum(row.h)}</b>`,
      `最低 <b class="down">${fmtNum(row.l)}</b>`,
      `开盘 <b>${fmtNum(row.o)}</b>`,
      `量比 <b>${vr != null ? vr.toFixed(2) : '-'}</b>`,
      `振幅 <b>${amp.toFixed(2)}%</b>`,
      `成交量 <b>${fmtVol(row.vol)}</b>`,
      // 成交额恒定占一格：数据里没有就显示 -，避免这一格时有时无导致指标区行数变化
      `成交额 <b>${row.amount != null ? fmtVol(row.amount) : '-'}</b>`,
    ]);
  }

  // ---------- 交互 ----------
  let pointerDownAt = null;
  let gesture = null;                 // { axis, mode, x0, y0, acc, panel, panBase, panSpan, panPx0, swDir }
  const ZOOM_STEP_PX = 26;            // 主图上下滑：每 26px 变一档
  const SWITCH_COMMIT_PX = 44;        // 副图横滑：松手时超过该位移才提交换股（越小越灵敏）
  const SWITCH_MAX_PX = 96;           // 跟手位移上限，超过后橡皮筋阻尼
  const LOCK_PX = 6;                  // 起步判定阈值（越小越灵敏）
  const AXIS_RATIO = 1.15;            // 主轴判定比例（越小越灵敏，兼顾斜向防误触）
  const PANE_SLIDE_MS = 200;          // 换股时新图滑入时长
  let activePointers = 0;             // 多指（双指缩放）时不接管手势，交回 ECharts

  // ---------- 邻票预览 ----------
  function resetPreviewPane() {
    previewToken++;                    // 作废在途预览，防止旧票邻票图画进新票的预览层
    state.previewReady = false;
    state.previewTl = null;
    state.previewDir = 0;
    if (!els.previewPane) return;
    els.previewPane.style.transition = 'none';
    els.previewPane.style.transform = `translateX(${paneWidth()}px)`;
  }

  // 把相邻股票预渲染到 previewPane（命中缓存时几乎瞬时），停在屏外准备滑入。
  let previewToken = 0;
  async function preparePreview(dir) {
    const nb = state.neighbors[String(dir)];
    if (!nb || !nb.code) { state.previewReady = false; return false; }
    if (state.previewReady && state.previewDir === dir) return true;
    const token = ++previewToken;
    if (els.previewPane) {
      els.previewPane.style.transition = 'none';
      els.previewPane.style.transform = `translateX(${dir * paneWidth()}px)`;
    }
    try {
      // 分时周期：邻票要的是它自己的当日分时，不能复用主图的 state.timeline，
      // 也不能走 kline 接口（那边没有分时数据，会把日线画进分时预览层）。
      if (state.period === 'min') {
        const tlPayload = await fetchTimelineData(nb.code);
        if (token !== previewToken) return false;
        const pts = (tlPayload && tlPayload.points) || [];
        const byT = new Map();
        for (const p of pts) byT.set(p.t, p);
        paintTimeline(state.previewSlot,
          { date: tlPayload.date || '', prevClose: tlPayload.prevClose, points: pts, byT },
          null);   // 邻票没有实时行情，只用已落地的分时点
        // 留一份给换股提交时立即填顶部数据区（见 onPointerUp 的 switch commit 分支），
        // 免得分时换股要等 api.load() 的网络返回才显示出新票行情。
        state.previewTl = {
          code: nb.code,
          tl: {
            date: normDate(tlPayload && tlPayload.date),
            prevClose: tlPayload && tlPayload.prevClose != null ? tlPayload.prevClose : null,
            vol5: tlPayload && tlPayload.vol5 != null ? tlPayload.vol5 : null,
            points: pts,
            byT,
          },
        };
      } else {
        const bars = state.period === 'week' ? 200 : 320;
        const payload = await fetchKlines(nb.code, state.period, state.adjust, bars);
        if (token !== previewToken) return false;
        paint(state.previewSlot, payload.klines || [], { maCache: {}, macd: null, volMa5: null });
      }
      state.previewDir = dir;
      state.previewReady = true;
      return true;
    } catch { state.previewReady = false; return false; }
  }

  // 拖动时两幅画布一起位移：主图跟随手指，预览图从另一侧滑入。
  function setSwitchOffset(dir, dx) {
    const W = paneWidth();
    const abs = Math.abs(dx);
    const shown = abs > SWITCH_MAX_PX ? Math.sign(dx) * (SWITCH_MAX_PX + (abs - SWITCH_MAX_PX) * 0.35) : dx;
    if (els.mainPane) {
      els.mainPane.style.transition = 'none';
      els.mainPane.style.transform = `translateX(${shown.toFixed(1)}px)`;
    }
    if (els.previewPane) {
      els.previewPane.style.transition = 'none';
      els.previewPane.style.transform = `translateX(${(dir * W + shown).toFixed(1)}px)`;
    }
  }
  // 松手后归位动画：commit=true 预览层（新票）滑到正中、主层（旧票）滑出屏外；
  // commit=false 主层回正、预览层退回屏外（橡皮筋回弹）。
  // commit 后的「复位」不在这里做，而是等 api.load() 把新票画进主层后再瞬时复位，
  // 否则预览层先退场会露出尚未重绘的主层，出现旧图闪现。
  function settleSwitch(dir, commit) {
    const W = paneWidth();
    const main = els.mainPane, prev = els.previewPane;
    const trans = `transform ${PANE_SLIDE_MS}ms cubic-bezier(.22,.61,.36,1)`;
    if (main) { main.style.transition = trans; main.style.transform = commit ? `translateX(${-dir * W}px)` : 'translateX(0)'; }
    if (prev) { prev.style.transition = trans; prev.style.transform = commit ? 'translateX(0)' : `translateX(${dir * W}px)`; }
    clearTimeout(state._switchTimer);
    if (!commit) {
      state._switchTimer = setTimeout(() => {
        if (main) { main.style.transition = 'none'; main.style.transform = 'translateX(0)'; }
        if (prev) { prev.style.transition = 'none'; prev.style.transform = `translateX(${dir * W}px)`; }
        state.switching = false;
      }, PANE_SLIDE_MS + 20);
    }
  }

  // 把两层画布瞬时针归位到静止态（不做动画），用于手势被打断等异常场景。
  function snapPanesHome() {
    clearTimeout(state._switchTimer);
    previewToken++;              // 使在途的 preparePreview 失效，避免它的回调把过期邻票标成 ready
    const W = paneWidth();
    if (els.mainPane) {
      els.mainPane.style.transition = 'none';
      els.mainPane.style.transform = 'translateX(0)';
      els.mainPane.style.opacity = '';
    }
    if (els.previewPane) {
      els.previewPane.style.transition = 'none';
      els.previewPane.style.transform = `translateX(${W}px)`;
    }
    state.switching = false;
    state.previewReady = false;
    state.previewDir = 0;
  }

  // 从后台切回 / 页面恢复（bfcache）/ 窗口重新获得焦点时调用。
  // 后台期间容器尺寸可能已变（分屏、旋转、地址栏收起），而 resize 事件不一定补发；
  // 同时手势也可能被系统打断。这里统一：清手势 → 画布归位 → 强制重算布局。
  function resyncViewport() {
    if (!state.chart || !els.canvas) return;
    const W = paneWidth(), H = els.canvas.clientHeight;
    gesture = null;
    pointerDownAt = null;
    activePointers = 0;
    // 换股已 commit、正在异步加载新票：主层由 settleSwitch 占着动画/归位，
    // 这里绝不能 snap（会把新图瞬时拉回旧位置，出现旧图闪现），只补一次布局即可。
    if (state.switching) {
      onResize();
      return;
    }
    // 换股滑动中被系统打断：两层都要归位
    if (state.previewReady) {
      snapPanesHome();
    } else if (els.previewPane) {
      // 静止态：预览层停在屏外，但位移量按旧宽度算的像素值已过期，
      // 容器变窄时会露出一条预览旧图，这里按新宽度重新推到屏外。
      els.previewPane.style.transition = 'none';
      els.previewPane.style.transform = `translateX(${W}px)`;
    }
    // 尺寸完全没变（桌面端 alt-tab 回来是常态）就不必全量重排，省一次双图重绘
    if (W === state._resyncW && H === state._resyncH) return;
    state._resyncW = W; state._resyncH = H;
    onResize();
    syncDzWindow();
  }

  // 新票已画进主层后调用：瞬时把两层复位（主层回正、预览层退回屏外）。
  function finalizeSwitch(dir) {
    clearTimeout(state._switchTimer);
    const W = paneWidth();
    const main = els.mainPane, prev = els.previewPane;
    if (main) { main.style.transition = 'none'; main.style.transform = 'translateX(0)'; }
    if (prev) { prev.style.transition = 'none'; prev.style.transform = `translateX(${dir * W}px)`; }
    state.switching = false;
    state.previewReady = false;
    state.previewDir = 0;
  }

  // 换股入场（点击/键盘）：主画布从侧边滑入
  function clearCanvasTransform(cv) {
    if (!cv) return;
    clearTimeout(cv._enterTimer);
    cv.style.transition = ''; cv.style.transform = ''; cv.style.opacity = '';
  }
  function settleEnter(cv) {
    if (!cv) return;
    void cv.offsetWidth;                         // 强制 reflow，让屏外初始位置先生效
    cv.style.transition = 'transform .26s cubic-bezier(.22,.61,.36,1), opacity .26s ease';
    cv.style.transform = 'translateX(0)';
    cv.style.opacity = '1';
    const done = () => clearCanvasTransform(cv);
    cv.addEventListener('transitionend', done, { once: true });
    cv._enterTimer = setTimeout(done, 400);      // 兜底：transitionend 丢失时也能清掉内联样式
  }

  function panelIndexAtY(y) {
    for (let i = 0; i < state.gridRects.length; i++) {
      const r = state.gridRects[i];
      if (r && y >= r.y && y <= r.y + r.height) return i;
    }
    return -1;
  }

  function emitSwitch(delta, neighbor) {
    window.dispatchEvent(new CustomEvent('tdx:switch', {
      detail: { delta, code: neighbor && neighbor.code, name: neighbor && neighbor.name, match: neighbor && neighbor.match },
    }));
  }

  // 主图横向平移：拖动像素换算成 bar 数，整体平移 dataZoom 窗口（span 不变）。
  // 拖动方向与图形方向一致：右拖 → 看到更早的 K 线。
  function panToClientX(x) {
    const g = gesture;
    if (!g || g.mode !== 'pan') return;
    // 分时固定展示全天，横向拖动不移动图形（否则会把 242 个槽整体平移出视窗）
    if (state.period === 'min') return;
    const r = state.gridRects[0];
    if (!r || !r.width) return;
    const pxPerBar = r.width / g.panSpan;
    const dBars = Math.round((x - g.panPx0) / pxPerBar);
    const last = state.klines.length - 1;
    let sv = Math.round(g.panBase - dBars);
    let ev = sv + g.panSpan - 1;
    if (sv < 0) { sv = 0; ev = g.panSpan - 1; }
    if (ev > last) { ev = last; sv = ev - g.panSpan + 1; }
    const dz = state.chart.getOption().dataZoom[0];
    if (sv === Math.round(dz.startValue) && ev === Math.round(dz.endValue)) return;
    state.chart.dispatchAction({ type: 'dataZoom', startValue: sv, endValue: ev });
    state.visibleBars = g.panSpan;
  }

  // 锁定态：左右拖动 → 在可见 K 线上移动十字线
  function moveCrosshairByPx(x) {
    const g = gesture;
    if (!g || g.mode !== 'cross') return;
    const r = state.gridRects[0];
    if (!r || !r.width) return;
    const dz = state.chart.getOption().dataZoom[0];
    const span = Math.round(dz.endValue) - Math.round(dz.startValue) + 1;
    const pxPerBar = r.width / Math.max(1, span);
    const dBars = Math.round((x - g.crossPx0) / pxPerBar);
    const sv = Math.round(dz.startValue), ev = Math.round(dz.endValue);
    let idx = g.crossBase + dBars;
    idx = Math.max(sv, Math.min(ev, idx));
    if (idx === state.currentIdx) return;
    state.currentIdx = idx;
    renderCrosshair(idx);
  }

  // 分时锁定态：手指怎么动，两条线就跟着怎么动——横向改分钟槽位、纵向改读数线。
  // 之前按首次移动方向锁死单轴，斜着划一下就只认水平，纵向再也拖不动横线，
  // 用户看到的就是「要么只能左右、要么只能上下」。这里两个方向一起算，一次重绘。
  function moveCrosshairBoth(x, y) {
    const g = gesture;
    if (!g || g.mode !== 'cross') return;
    const r = state.gridRects[0];
    if (!r || !r.width) return;
    const n = TIMELINE_SLOTS.length;
    const pxPerSlot = r.width / n;
    const dSlots = Math.round((x - g.crossPx0) / pxPerSlot);
    const base = g.crossBase >= 0 ? g.crossBase : 0;
    const idx = Math.max(0, Math.min(n - 1, base + dSlots));
    // y 传进来是 clientY（视口坐标），rect / state.crossY 都是画布内坐标，必须减掉画布偏移
    const box = els.canvas.getBoundingClientRect();
    let ny = y - box.top;
    // 纵向范围放开到整个图面（主图 + 成交量 + 量比），横线可以一路拖进副图；
    // 之前钳在价格面板内，手指往下拖到一半就顶住，副图永远进不去。
    const rs = state.gridRects.filter(Boolean);
    const topY = rs.length ? Math.min(...rs.map((q) => q.y)) : r.y;
    const botY = rs.length ? Math.max(...rs.map((q) => q.y + q.height)) : r.y + r.height;
    ny = Math.max(topY, Math.min(botY, ny));
    const sameX = idx === state.currentIdx;
    const sameY = state.crossY != null && Math.abs(ny - state.crossY) < 0.5;
    if (sameX && sameY) return;
    state.currentIdx = idx;
    state.crossY = ny;
    renderCrosshairMin(idx);
  }

  function bindInteractions() {
    const dom = els.canvas;
    // 兜底阻止 iOS 双击放大（部分 Safari 忽略 user-scalable=no）
    let lastTap = 0;
    dom.addEventListener('touchend', (e) => {
      const now = Date.now();
      if (now - lastTap < 300) e.preventDefault();
      lastTap = now;
    }, { capture: true, passive: false });

    dom.addEventListener('pointerdown', (e) => {
      activePointers++;
      pointerDownAt = { x: e.clientX, y: e.clientY };
      const rect = dom.getBoundingClientRect();
      const dz = state.chart.getOption().dataZoom[0];
      const span = Math.round(dz.endValue) - Math.round(dz.startValue) + 1;
      gesture = { axis: null, mode: 'idle', x0: e.clientX, y0: e.clientY, acc: 0,
        panel: panelIndexAtY(e.clientY - rect.top),
        locked: !!state.locked, crossPx0: e.clientX, crossBase: state.currentIdx,
        crossY0: state.crossY,
        panBase: dz.startValue, panSpan: span, panPx0: e.clientX, swDir: 0 };
    }, true);
    dom.addEventListener('pointermove', onPointerMove, { capture: true, passive: false });
    dom.addEventListener('pointerup', onPointerUp, true);
    dom.addEventListener('pointercancel', () => {
      activePointers = Math.max(0, activePointers - 1);
      const g = gesture;
      gesture = null; pointerDownAt = null;
      // 系统手势/来电/切后台会打断换股滑动：此刻两层画布停在半路，
      // 必须瞬时针归位，否则切回来就是「整体右移、最右 K 线被切、左边露出预览图」。
      if (g && g.mode === 'switch') snapPanesHome();
    }, true);
    // pointerup 后浏览器还会补发一次 click；在捕获阶段吞掉，避免十字线二次切换
    dom.addEventListener('click', (e) => {
      if (Date.now() < state.ignoreClickUntil) { e.stopPropagation(); e.preventDefault(); }
    }, true);
  }

  function onPointerMove(e) {
    if (activePointers > 1) { gesture = null; return; }   // 双指缩放交给 ECharts
    // 分时周期 state.klines 是空的（数据在 state.timeline 里），不能拿 klines.length 判断，
    // 否则分时下图上一滑动就被 return，横滑换股和十字线在分时页会整个失效。
    const hasData = state.period === 'min'
      ? !!(state.timeline && state.timeline.points.length)
      : !!state.klines.length;
    if (!gesture || !hasData) return;
    const dx = e.clientX - gesture.x0, dy = e.clientY - gesture.y0;
    if (!gesture.axis) {                          // 首次移动锁定方向，避免斜向抖动
      if (Math.abs(dx) < LOCK_PX && Math.abs(dy) < LOCK_PX) return;
      // 分时十字线已打开：横向拖 = 换分钟，纵向拖 = 上下挪横线读数线。
      // 两个方向都是「动十字线」，所以不分轴、直接进 cross 模式（否则纵向会误判成缩放）。
      if (state.period === 'min' && gesture.locked) {
        gesture.axis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
        gesture.mode = 'cross';
        gesture.x0 = e.clientX; gesture.y0 = e.clientY;
        gesture.crossPx0 = e.clientX; gesture.crossBase = state.currentIdx;
        gesture.crossY0 = state.crossY;
        return;
      }
      // 主次轴比例判定：明显偏向某轴即锁定，越小越灵敏
      if (Math.abs(dx) > Math.abs(dy) * AXIS_RATIO) {
        gesture.axis = 'x';
        // 副图横向滑 = 换股（不动图形）
        // 主图横向滑：已锁定十字线 → 移动十字线；未锁定 → 平移图形
        gesture.mode = gesture.panel > 0 ? 'switch' : (gesture.locked ? 'cross' : 'pan');
      } else if (Math.abs(dy) > Math.abs(dx) * AXIS_RATIO) {
        gesture.axis = 'y';
        gesture.mode = gesture.panel === 0 ? 'zoom' : 'idle';  // 主图上下滑=缩放；副图纵向不动
      } else {
        return;                                   // 方向尚不明确，继续等待
      }
      gesture.x0 = e.clientX; gesture.y0 = e.clientY; gesture.acc = 0;
      if (gesture.mode === 'pan') {
        const dz = state.chart.getOption().dataZoom[0];
        gesture.panBase = dz.startValue; gesture.panPx0 = e.clientX;
      } else if (gesture.mode === 'cross') {
        gesture.crossPx0 = e.clientX; gesture.crossBase = state.currentIdx;
      } else if (gesture.mode === 'switch') {
        // 方向锁定即开始预渲染邻票：命中缓存后新票图形随手指滑入
        gesture.swDir = dx <= 0 ? 1 : -1;
        preparePreview(gesture.swDir);
      }
      return;
    }
    if (gesture.mode === 'zoom') {
      e.preventDefault();
      gesture.acc += (e.clientY - gesture.y0);
      while (gesture.acc <= -ZOOM_STEP_PX) { applyZoomDelta(0.8); gesture.acc += ZOOM_STEP_PX; }
      while (gesture.acc >= ZOOM_STEP_PX) { applyZoomDelta(1.25); gesture.acc -= ZOOM_STEP_PX; }
      gesture.y0 = e.clientY;
    } else if (gesture.mode === 'switch') {
      e.preventDefault();
      const dir = e.clientX <= gesture.x0 ? 1 : -1;
      if (dir !== gesture.swDir) { gesture.swDir = dir; preparePreview(dir); }
      gesture.acc = e.clientX - gesture.x0;
      setSwitchOffset(gesture.swDir, gesture.acc);
    } else if (gesture.mode === 'cross') {
      e.preventDefault();
      if (state.period === 'min') {
        // 分时不锁轴：横向、纵向在同一次拖动里一起生效
        moveCrosshairBoth(e.clientX, e.clientY);
      } else {
        moveCrosshairByPx(e.clientX);
      }
    } else if (gesture.mode === 'pan') {
      e.preventDefault();
      panToClientX(e.clientX);
    } else if (gesture.mode === 'idle') {
      e.preventDefault();                         // 副图纵向滑：不换股、不动图形，仅阻止页面滚动
    }
  }

  function onPointerUp(e) {
    activePointers = Math.max(0, activePointers - 1);
    const down = pointerDownAt, g = gesture;
    pointerDownAt = null; gesture = null;
    if (!down) return;

    // 副图横滑换股：松手时按位移方向与幅度决定换股，然后归位
    if (g && g.mode === 'switch') {
      const dx = e.clientX - g.x0;
      const dir = g.swDir || (dx <= 0 ? 1 : -1);
      const nb = state.neighbors[String(dir)];
      const commit = Math.abs(dx) >= SWITCH_COMMIT_PX && nb && nb.code;
      state.ignoreClickUntil = Date.now() + 300;
      if (commit) {
        state.switching = true;
        // 新票已在 previewPane 里预渲染好：松手后旧图滑出、新图滑到正中（纯 CSS 动画，无白屏）；
        // 动画期间后台把新票画进主层，等动画结束再瞬时复位（两层内容一致，看不到跳变）。
        const prevCode = state.code, prevName = state.name;
        state.code = nb.code;
        state.name = nb.name || '';
        // 与 api.open() 保持一致：换股必须清掉上一只的行情与分时。
        // 否则分时下 api.load → timelineSeries 会回落到 state.quote，
        // 把旧股的价格/累计量按槽位写进新股曲线，顶部行情条也显示旧股价。
        state.quote = null;
        state.timeline = null;
        state.srcCached = false;    // 新票数据还没到，先别沿用上一只的离线标记
        state.srcTlCached = false;
        state.currentIdx = -1;
        if (els.nameEl) els.nameEl.textContent = state.name || '';
        // 换股瞬间先把邻票已预取的分时数据填进顶部数据区：
        // 否则这里清空 timeline 后要等 api.load() 的网络返回才重新渲染，
        // 分时没有本地缓存可秒开，顶部数据区会先塌成一条空行再长回来（日K有缓存故不明显）。
        // 数据来自 preparePreview 已经画进预览层的同一份 payload，格式与 applyTimelinePayload 一致。
        if (state.period === 'min' && state.previewTl && state.previewTl.code === nb.code) {
          const pv = state.previewTl.tl;
          state.timeline = {
            date: pv.date,
            prevClose: pv.prevClose,
            vol5: pv.vol5,
            points: pv.points,
            byT: pv.byT,
          };
          renderTimelineQuote();
        }
        settleSwitch(dir, true);
        (async () => {
          let ok = true;
          try {
            // 等渲染完成 + 滑入动画走完再复位，避免动画中途复位造成跳动
            await Promise.all([
              api.load(),
              new Promise((r) => setTimeout(r, PANE_SLIDE_MS)),
            ]);
          } catch {
            ok = false;
            // 兜底：加载失败时回退到原股票，保持界面与数据一致
            state.code = prevCode; state.name = prevName;
            try { await api.load(); } catch { /* ignore */ }
          }
          finalizeSwitch(dir);
          if (ok) emitSwitch(dir, nb);
        })();
      } else {
        settleSwitch(dir, false);
      }
      return;
    }
    if (g && g.axis) { state.ignoreClickUntil = Date.now() + 300; return; } // 手势已消费
    const dist = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    if (dist > 12) return;               // 判定为拖拽平移，不锁定十字线
    state.ignoreClickUntil = Date.now() + 400;
    if (Date.now() - state.lastToggleAt < 350) return; // 350ms 抖动锁
    state.lastToggleAt = Date.now();
    const rect = els.canvas.getBoundingClientRect();
    toggleCrosshair([e.clientX - rect.left, e.clientY - rect.top]);
  }

  function toggleCrosshair(pt) {
    // 已锁定十字线：单击任意位置即取消并解锁；左右拖动移动十字线由手势层“cross”分支处理，
    // 该分支 pointerup 时因 gesture.axis 已设置会提前 return，不会走到这里，因此不会冲突。
    if (state.locked) {
      hideCrosshair();
      state.currentIdx = -1;
      return;
    }
    const idx = indexAtPoint(pt);
    if (idx < 0) { hideCrosshair(); return; }
    state.currentIdx = idx;
    // 分时：横线初始落在点击位置（像素），之后可上下拖着走；K 线则由数据决定横线高度
    if (state.period === 'min') state.crossY = pt[1];
    renderCrosshair(idx);
  }

  // ---------- 对外 API ----------
  const api = {
    // 实时行情刷新：把最新一笔行情并入最后一根 K 线后重绘。
    // 同名同日的收盘价取行情现价，最高/最低取两者较大/较小；行情日期更新时补一根新 K 线。
    applyQuote(q) {
      if (!q) return;
      // 换股窗口期防护：横滑换股的瞬间，图表这边 state.code 已经切到新股，
      // 而 app 侧的「当前股」标记要等换股动画走完（emitSwitch）才更新。
      // 这几百毫秒里在途的 3 秒行情轮询带回来的是上一只票的报价，此前会被
      // 当成新股的行情画到顶部——价格取旧票、昨收取新票，算出 -98% 这种离谱涨跌幅。
      // 行情自带股票代码，对不上就直接丢弃，等下一次 tick 用新票的行情补上。
      if (q.code && state.code && q.code !== state.code) return;
      state.quote = q;                       // 记住最新行情，回源重画后要重新叠回去
      if (state.period === 'min') {
        // 分时：3 秒一次只更新最后一个点与图例，不重建整个 option（重建会让曲线抖动）
        if (state.timeline) updateTimelineTail();
        return;
      }
      const merged = mergeQuoteIntoSeries(q);
      if (merged) {
        // 顶部报价数字每次刷新；K 线本体改成只重写 series（merge 方式），
        // 不再走「8 秒才整图重绘一次」的老路——那条路会让最后一根柱子在盘中
        // 半分钟才动一次，价格在跳而柱子不动，看着像卡死。
        renderQuote(state.klines.length - 1);
        updateKlineTail(state.klines, state, merged === 'append');
      }
    },
    init,
    // 设置当前股票在结果列表中的相邻股票，供副图横滑预渲染使用
    setNeighbors(prev, next) { state.neighbors = { '-1': prev || null, '1': next || null }; },
    async open(code, name, direction) {
      state.code = code; state.name = name || '';
      state.maCache = {}; state.macd = null; state.volMa5 = null; state.amp = null; state.currentIdx = -1;
      state.quote = null;                    // 换股：上一只的行情不能叠到新图上
      state.timeline = null;                 // 分时同理，上一只的曲线不能残留到新票
      state.srcCached = false;               // 离线标记同理，不能带到新票上
      state.srcTlCached = false;
      state.switching = false;
      resetPreviewPane();                    // 复位预览层，避免上一只票的残留
      hideCrosshair();
      // 行情条立刻按固定字段占位（数值显示 -）：换股后新数据还要等一个来回，
      // 这段空窗如果沿用上一只票的内容或整块空白，行数会先塌再撑，下方图表跟着跳一下。
      // 先按字段名把行数定死，数据回来只替换数字，高度全程不变。
      state.klines = [];                     // 上一只票的 K 线不能再参与渲染
      if (state.period === 'min') renderTimelineQuote(); else renderQuote();
      // 换股过渡：先把主画布移到屏外并隐形，等新图渲染完成后再滑回原位，
      // 这样新图是「从隐藏到展开」滑出来的，而不是渲染好之后瞬间闪现。
      const animate = direction !== undefined;
      if (animate && els.mainPane) {
        clearTimeout(els.mainPane._enterTimer);
        els.mainPane.style.transition = 'none';
        els.mainPane.style.transform = `translateX(${direction >= 0 ? 100 : -100}%)`;
        els.mainPane.style.opacity = '0';
      }
      try {
        await api.load();
        if (animate) settleEnter(els.mainPane);
      } catch (err) {
        clearCanvasTransform(els.mainPane);
        throw err;
      }
    },
    // 批量预取：选股结果出来后调用，把命中股票一次性写入本地缓存。
    async prefetch(codes, opts) {
      const list = (codes || []).filter(Boolean);
      if (!list.length) return 0;
      const period = opts && opts.period ? opts.period : 'day';
      const adjust = opts && opts.adjust ? opts.adjust : state.adjust;
      const bars = period === 'week' ? 200 : 320;
      // 已有有效缓存的先跳过，避免重复搬数据。
      const missing = [];
      for (const code of list) {
        const hit = await readCache(cacheKey(code, period, adjust));
        if (!hit) missing.push(code);
      }
      if (!missing.length) return 0;
      let saved = 0;
      const CHUNK = 60;
      for (let i = 0; i < missing.length; i += CHUNK) {
        const codes60 = missing.slice(i, i + CHUNK);
        try {
          const res = await fetch(KL_BATCH_BASE, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ codes: codes60, period, adjust, bars }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) continue;
          for (const item of data.items || []) {
            writeCache(cacheKey(item.code, item.period, item.adjust),
              { name: item.name || '', klines: item.klines || [] });
            saved++;
          }
        } catch { /* 预取失败不阻塞，点击时仍可回退实时加载 */ }
      }
      return saved;
    },
    async load() {
      const code = state.code;
      // 任何一次整条加载都作废在途的分时校准：否则 refreshTimeline 的旧 fetch 后到，
      // 会把刚换上新日的曲线用旧数据盖回去（token 校验只认 tlToken，认不出 load 已经换过数据）。
      ++tlToken;
      // 周期切换/换股后旧十字线必须清掉：自绘十字线挂在 zr 上，setOption(notMerge) 拆不掉它，
      // 残留的线和价签会叠在新图上；locked 还会让分时下第一次拖动走十字线而不是换股手势。
      hideCrosshair();
      // 分时周期：走 /api/timeline，不碰 kline 缓存，也不写缓存（分时每次都要最新）。
      if (state.period === 'min') {
        const token = ++loadToken;
        const payload = await fetchTimelineData(code);
        if (token !== loadToken) return;
        applyTimelinePayload(payload);
        return;
      }
      const bars = state.period === 'week' ? 200 : 320;
      const period = state.period, adjust = state.adjust;
      const token = ++loadToken;
      const cached = await readCache(cacheKey(code, period, adjust));
      if (token !== loadToken) return;         // 期间又换了股/周期，丢弃本次结果
      if (cached) applyPayload(cached);        // 先画缓存，秒开
      // 再强制回源核对一次：确保 eltdx 当日落库后立即用上最新日 K，而不是停在缓存里。
      let payload;
      try {
        payload = await fetchKlines(code, period, adjust, bars, { fresh: !!cached });
      } catch (err) {
        if (token !== loadToken) return;
        // 后端明确报错（500/404 之类）不是断网，必须把错误抛出去让用户看到，
        // 不能拿一份旧缓存把服务故障盖住。
        if (err && err.httpStatus) throw err;
        // 断网且本地没有缓存（或缓存已过期到被清掉）时，退回过期缓存让用户还能翻历史；
        // 已经有图在屏上的话就直接留着，不要因为回源失败把图清空。
        const stale = cached || await readCache(cacheKey(code, period, adjust), { stale: true });
        if (stale && stale.klines && stale.klines.length) {
          // 留存时间必须一起带下去：内存层过了有效期会被清掉，只能回持久层问写入时刻，
          // 否则离线提示里的「留存于几点」会变成空白，用户分不清是刚取的还是几小时前的。
          const rec = await idb.get(cacheKey(code, period, adjust));
          applyPayload(Object.assign({}, stale, { cached: true, staleTs: (rec && rec.ts) || 0 }));
          return;
        }
        throw err;
      }
      if (token !== loadToken) return;
      applyPayload(payload);
    },
    setPeriod(p) { state.period = p; return api.load(); },
    setAdjust(a) { state.adjust = a; return api.load(); },
    // 供 app 侧查询当前周期（3 秒轮询据此决定是否校准分时曲线）
    // 网络恢复：把「来自本地留存」的标记清掉，顶部那条离线说明也要收起来，
    // 否则联网后图上还挂着"离线数据"，看着像还在断网。
    markOnline() {
      state.srcCached = false;
      state.srcTlCached = false;
      syncOfflineNotice(null);
      if (state.period === 'min') renderTimelineQuote(); else if (state.klines && state.klines.length) renderQuote(state.klines.length - 1);
    },
    period: () => state.period,
    // 分时校准：重新拉整条曲线并重画，不重置 dataZoom（分时本来就固定跨度）。
    // 换股/切周期时会由 api.load() 自己处理，这里只用于盘中定时对齐。
    async refreshTimeline() {
      if (state.period !== 'min' || !state.code) return;
      const code = state.code;
      // 用独立 token，不能和主图 loadToken 共用：
      // 否则校准和在途的换股加载会互相作废，白跑一趟上游。
      const token = ++tlToken;
      const payload = await fetchTimelineData(code);
      if (token !== tlToken || state.code !== code || state.period !== 'min') return;
      applyTimelinePayload(payload);
    },
    zoom: applyZoomDelta,
    reset: resetZoom,
    current: () => state.code,
  };

  window.TdxChart = api;
})();

/* 移动端主应用：自选 / 选股两个页签，点击股票进入看盘。
 * 数据能力复用 kline 侧：/api/quotes 实时行情（每分钟一次）、/api/klines 批量 K 线、/api/screenings 选股。
 */
(function () {
  'use strict';
  const API_BASE = location.pathname.startsWith('/stock-picker') ? '/stock-picker' : '';
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  // 行情轮询间隔：盘中 3 秒，与看盘那只同一节奏。
  // 全站最新价只有这一个来源（同一批行情快照），列表 / 缩略图 / 日K / 分时报价都读它，
  // 所以任何一处看到的数字都是同一时刻的，不会出现「分时 32.15、日K 32.10」。
  const QUOTE_MS = 3000;
  const QUOTE_IDLE_MS = 5 * 60000;  // 休市/非交易时段的巡视频率（只看表，不拉行情）
  // 缩略图重画的独立节奏：数字 3 秒跳，但几十上百个小 K 线没必要跟着重画。
  // 重画缩略图是列表这边真正吃 CPU 的部分（每行一块 canvas），降频它、保留数字实时。
  const SPARK_MS = 25000;
  let lastSparkAt = 0;
  const SPARK_BARS = 60;       // 迷你 K 线取多少根
  const WATCH_KEY = 'sp:watchlist:v1';
  const QUOTE_SNAP_KEY = 'sp:quotes-snap:v1';   // 行情快照，断网时列表靠它才有数
  const SPARK_SNAP_KEY = 'sp:spark-snap:v1';    // 迷你 K 线快照，断网时列表小图靠它才有形状
  const HISTORY_KEY = 'sp:history:v1';
  const STRAT_KEY = 'sp:strategy:v1';
  const HISTORY_TTL = 3 * 24 * 60 * 60 * 1000;
  const HISTORY_CAP = 20;

  // ---------- 全局缓存 ----------
  const quoteMap = new Map();   // code -> 行情
  const klineMap = new Map();   // code -> 迷你 K 线数组
  // 启动时先用本地留存垫上的那批代码：联网后必须重新请求覆盖，
  // 否则联网了小图还停在旧数据上（用户会以为行情不动了）。
  const sparkPrimed = new Set();
  let watchList = [];           // [{ code, name }]
  let screenRows = [];          // 最近一次选股结果
  // ---------- 结果列表的可视区渲染（虚拟滚动）----------
  // 日内选股一次能出三千多只，全画出来手机直接卡死，所以只画看得见的那几十行，
  // 剩下的用一块空白高度占位，滚动条看着还是三千多只那么长，滚到哪画到哪。
  let vItems = [];              // 当前排好序、正在被虚拟渲染的列表
  let vStart = -1, vEnd = -1;   // 当前已经画出来的是哪一段（下标）
  let vRowH = 59;               // 单行高度，必须与样式里写死的一致，否则滚动位置会错乱
  let vRaf = 0;
  let vLoadedAt = 0;            // 上次为可视行补拉行情的时刻（限流用）
  let intradayMode = false;     // 最近一次结果是否来自日内策略（决定列表是否显示触发说明）
  let runBaseDate = '';         // 最近一次结果对应的交易日（买点标记要核对日期，隔夜不画）
  let activeTab = 'watchlist';
  let openCode = null;          // 看盘抽屉当前股票
  // 买票清单：早盘每 5 分钟自动盯盘记下来的出手票。和选股结果是两套数据，
  // 单独存，切到清单页时才去服务端取，不占选股页的结果位。
  let pickRows = [];
  let pickDates = [];
  let pickSelDate = '';
  let pickDoc = null;

  // 日内触发时刻后端给的是四位数（如 0954），直接显示会让人看不出是几点，
  // 这里补成 09:54。没有值就返回空串，调用方自行判断要不要显示。
  function fmtTriggerTime(t) {
    const s = String(t || '').replace(/\D/g, '');
    if (s.length < 4) return '';
    return `${s.slice(0, 2)}:${s.slice(2, 4)}`;
  }

  // 请求失败要能分清两种：一种是"根本没连上"（断网、飞行模式、WiFi 没有外网），
  // 另一种是"连上了但服务器回错了"（500/404）。前者允许拿本地留存顶上并标注日期，
  // 后者必须如实报错，绝不能拿旧数据把故障盖住。
  // httpStatus 就是这条分界线：带它的错误 = 服务器回的；没有的 = 网络没通。
  // timeoutMs 按请求类型可调：看行情这类轻请求 8 秒足够，选股是全站最重的一份活，
  // 冷启动时要重读上万只股票的历史资料，实测十几秒才出结果，必须给更宽的上限，
  // 否则前端先放弃、后端其实还在算，用户看到的就是莫名其妙的失败。
  async function request(url, options, timeoutMs) {
    // 手机上"没有外网"和"没连上"的表现是请求一直挂着不回，必须自己设个上限，
    // 否则用户会盯着空白列表干等半分钟才知道没网。
    const limit = timeoutMs || 8000;
    const ctl = ('AbortController' in window) ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), limit) : null;
    let res;
    try {
      res = await fetch(url, ctl ? Object.assign({}, options, { signal: ctl.signal }) : options);
    } catch (err) {
      // 被自己的超时掐断时，浏览器只给一句 "aborted"，对用户毫无意义；
      // 换成"等了多久还没回来"，能一眼看出是慢还是断网。
      if (err && err.name === 'AbortError') {
        const e = new Error(`等待 ${Math.round(limit / 1000)} 秒仍无响应，请稍后重试`);
        e.timeout = true;
        throw e;
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); }
    catch {
      const e = new Error(res.status >= 500 ? `服务器暂时无法完成请求（HTTP ${res.status}）` : '接口返回了非 JSON 内容');
      e.httpStatus = res.status || -1;
      throw e;
    }
    if (!res.ok) {
      const e = new Error(body.error || '请求失败');
      e.httpStatus = res.status;
      throw e;
    }
    return body;
  }

  // ---------- 自选股存取 ----------
  function loadWatch() {
    try {
      const raw = JSON.parse(localStorage.getItem(WATCH_KEY)) || [];
      watchList = raw.filter((x) => x && x.code).map((x) => ({ code: x.code, name: x.name || '' }));
    } catch { watchList = []; }
  }
  function saveWatch() {
    try { localStorage.setItem(WATCH_KEY, JSON.stringify(watchList)); } catch { /* 忽略 */ }
  }
  const inWatch = (code) => watchList.some((x) => x.code === code);

  // ---------- 行情快照（断网用） ----------
  // 每次成功拉到行情就把当天快照落一份到本地，断网冷启动时用它把列表填起来。
  // 只留最近一次，不带历史；超过一天的数据在界面上会标注日期。
  function saveQuoteSnap(items) {
    if (!items || !items.length) return;
    try {
      const prev = loadQuoteSnapRaw();
      const merged = Object.assign({}, prev.items || {});
      for (const q of items) if (q && q.code) merged[q.code] = q;
      localStorage.setItem(QUOTE_SNAP_KEY, JSON.stringify({
        ts: Date.now(), items: merged,
      }));
    } catch { /* 存不下就放弃，不影响在线使用 */ }
  }
  function loadQuoteSnapRaw() {
    try { return JSON.parse(localStorage.getItem(QUOTE_SNAP_KEY)) || {}; }
    catch { return {}; }
  }
  // 被本地留存"垫"过的股票。服务端一旦如实报错，必须把这些垫上去的数据撤掉，
  // 否则服务器故障会被旧价格盖住，用户完全看不出来。
  const snapPrimed = new Set();
  // 断网时把本地快照灌进 quoteMap 并重绘；返回快照时间戳（0 表示没有可用快照）。
  function applyQuoteSnap() {
    const snap = loadQuoteSnapRaw();
    if (!snap || !snap.items) return 0;
    let n = 0;
    for (const code of Object.keys(snap.items)) {
      if (!quoteMap.has(code)) { quoteMap.set(code, snap.items[code]); snapPrimed.add(code); n++; }
    }
    if (n) { paintQuotes(); drawSparks(); }
    return snap.ts || 0;
  }
  // 服务端明确报错（不是断网）时，把垫上去的留存数据撤掉：
  // 让用户看到"服务未连接"，而不是被旧价格蒙住。
  function withdrawSnapPrimed() {
    if (!snapPrimed.size && !sparkPrimed.size) return;
    for (const code of snapPrimed) quoteMap.delete(code);
    snapPrimed.clear();
    // 迷你 K 线陪同一并撤掉：只撤数字、留着小图，等于用一条旧走势继续暗示"行情还在"。
    for (const code of sparkPrimed) klineMap.delete(code);
    sparkPrimed.clear();
    paintQuotes();
    drawSparks();
  }
  // 启动时无条件先用本地留存垫一遍（不等任何网络结果）。
  // 原因：手机上"没网"的判定极不可靠——连着 WiFi 但没外网、飞行模式刚切、PWA 冷启动时
  // 系统网络状态获取慢，都会让"在线"判断出错；一旦判错，用户看到的就只剩满屏短横线。
  // 所以改成：先把留存数据画出来，再去请求网络；请求成功就覆盖并更新留存，失败就保留留存并标注日期。
  function primeFromSnap() {
    const ts = applyQuoteSnap();
    // 迷你 K 线同样先垫上，否则列表有数字但小图是空框。
    const snap = loadSparkSnapRaw();
    if (snap && snap.items) {
      for (const c of Object.keys(snap.items)) {
        const bars = snap.items[c];
        if (bars && bars.length && !klineMap.has(c)) {
          klineMap.set(c, bars);
          sparkPrimed.add(c);
        }
      }
    }
    drawSparks(true);
    return ts;
  }
  // 展示/复制用：去掉 sh/sz/bj 市场前缀，只留 6 位数字。
  const plainCode = (code) => String(code || '').replace(/^[a-z]{2}/i, '');
  function addWatch(code, name) {
    if (inWatch(code)) return;
    watchList.push({ code, name: name || '' });
    saveWatch();
  }
  function removeWatch(code) {
    watchList = watchList.filter((x) => x.code !== code);
    saveWatch();
  }

  // ---------- 行情 / K 线批量拉取 ----------
  function allCodes() {
    const set = new Set();
    // 看盘中的股票优先进入拉取名单：列表超过 100 只时若被截断，
    // 看盘页就拿不到实时行情，只能看到上一交易日收盘价（表现为"显示昨天数据"）。
    if (openCode) set.add(openCode);
    for (const w of watchList) set.add(w.code);
    if (vItems.length) {
      // 结果有几千只时列表只画看得见的那些行，行情也只该拉这些行。
      // 若照旧把整个结果表塞进请求，上游一次最多只认前 100 只，等于永远在拉排在
      // 最前面那一百只，用户滚到哪里都是"--"，价格压根没请求过。
      for (let i = Math.max(0, vStart); i < vEnd && i < vItems.length; i++) set.add(vItems[i].code);
    } else {
      for (const r of screenRows) set.add(r.code);
    }
    return Array.from(set).slice(0, 100);
  }

  // ---------- 交易时段判断（A 股，北京时间）----------
  // 只按北京时间算：工作日 09:15-11:30、13:00-15:05 视为盘中，其余时间不轮询行情。
  // 节假日只能靠行情自证：拉到全市场快照日期都停在往日，说明当天休市，同样转入低频。
  const CST_OFFSET = 8 * 3600 * 1000;
  function cstDate(ts) {
    const t = new Date((ts || Date.now()) + CST_OFFSET);
    const p = (n) => String(n).padStart(2, '0');
    return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}`;
  }
  function cstMinutes(ts) {
    const t = new Date((ts || Date.now()) + CST_OFFSET);
    return { day: t.getUTCDay(), min: t.getUTCHours() * 60 + t.getUTCMinutes() };
  }
  function inTradingWindow(ts) {
    const { day, min } = cstMinutes(ts);
    if (day === 0 || day === 6) return false;                  // 周末
    return (min >= 555 && min <= 690) || (min >= 780 && min <= 905);  // 9:15-11:30 / 13:00-15:05
  }
  // ---------- 收盘收尾期 ----------
  // 上游快照里的「最后一笔」不是收盘那一秒就落库的：11:30 整的收盘价往往要几秒到
  // 一两分钟才出现在快照里。而交易窗口上限正好卡在 11:30（min<=690），11:31:00 一到
  // 就判定为「已收盘」，直接睡到下午 13:00，一分钟都不补拉。结果就是 11:30:5x 最后一次
  // 轮询停在 11:29 的价格，尾盘最后那一冲（拉抬或砸盘）永远补不进来，界面一直挂着旧价
  // 直到下午开盘。下午收盘时窗口本来就留到 15:05，天然有 5 分钟缓冲；上午没有，这就是
  // 上午收盘后价格不更新的根因。
  // 对策：收盘后再留 3 分钟收尾期，期间按 10 秒节奏继续补拉，把最后一笔捞回来再停。
  const SETTLE_MS = 10000;              // 收尾期内的补拉节奏
  const SETTLE_SEC = 180;               // 每次收盘后收尾多少秒
  const SETTLE_CLOSES = [690, 900];     // 11:30 / 15:00（按当天秒数算）
  function inSettleWindow(ts) {
    const now = ts || Date.now();
    const { day, min } = cstMinutes(now);
    if (day === 0 || day === 6) return false;
    const t = new Date(now + CST_OFFSET);
    const sec = t.getUTCHours() * 3600 + t.getUTCMinutes() * 60 + t.getUTCSeconds();
    return SETTLE_CLOSES.some((c) => sec >= c * 60 && sec < c * 60 + SETTLE_SEC);
  }

  // 只有开盘 20 分钟后才认定「全市场都停在往日」是休市，否则 9:15-9:35 的集合竞价
  // 阶段快照日期还没翻篇，会被误判成节假日、把一整天的轮询都停掉。
  function holidayCheckable(ts) {
    const { day, min } = cstMinutes(ts);
    return day !== 0 && day !== 6 && ((min >= 575 && min <= 690) || (min >= 780 && min <= 905));
  }

  // ---------- 实时 K 线合成 ----------
  // 把一笔行情并成「当日 bar」，供迷你 K 线与看盘主图共用。
  // 只返回新数组，绝不写回 klineMap 缓存，否则收盘后缓存里会留下一根盘中残价。
  function withRealtimeBar(bars, q) {
    if (!bars || !bars.length || !q || q.suspended || !(Number(q.price) > 0)) return bars;
    const price = Number(q.price);
    const date = q.date || '';
    if (!date) return bars;
    const last = bars[bars.length - 1];
    if (date < last.date) return bars;       // 行情比库内还旧（停牌/取数异常），不动
    const pos = (v) => (v != null && Number(v) > 0 ? Number(v) : null);
    const same = date === last.date;
    const open = pos(q.open), high = pos(q.high), low = pos(q.low);
    const bar = {
      date,
      o: open != null ? open : (same ? last.o : price),
      h: high != null ? Math.max(high, price) : price,
      l: low != null ? Math.min(low, price) : price,
      c: price,
      vol: Number(q.vol) > 0 ? Number(q.vol) : (same ? last.vol : 0),
      amount: Number(q.amount) > 0 ? Number(q.amount) : (same ? last.amount : 0),
    };
    return same ? bars.slice(0, -1).concat([bar]) : bars.concat([bar]);
  }

  async function refreshQuotes(only, opts) {
    // 可选传 codes 数组，只拉这几只（打开看盘时立即拉该股用）；不传则按 allCodes() 全量拉。
    const codes = Array.isArray(only) && only.length ? only : allCodes();
    if (!codes.length) return null;
    try {
      const data = await request(`${API_BASE}/api/quotes?codes=${encodeURIComponent(codes.join(','))}`);
      lastQuotePullAt = Date.now();
      for (const q of data.items || []) if (q && q.code) { quoteMap.set(q.code, q); snapPrimed.delete(q.code); }
      saveQuoteSnap(data.items || []);
      // silent：看盘 3 秒轮询专用。列表此时被抽屉盖着，没必要每 3 秒重建几百行 DOM
      // 并重画全部迷你 K 线，只把行情塞进 quoteMap 给图表用即可。
      if (!(opts && opts.silent)) {
        paintQuotes();
        drawSparks();   // 行情变了，迷你 K 线的当日 bar 也要跟着变
      }
      return data.items || [];
    } catch (err) {
      // 只有"网络没通"才拿本地留存顶上，并且把界面切到离线状态、标出留存时间；
      // 服务器回错（带 httpStatus）就如实失败，让状态栏去报错，不能拿旧价格遮住故障。
      if (err && !err.httpStatus) {
        handleOffline(err && err.name === 'AbortError' ? '超时' : '');
      } else if (err && err.httpStatus) {
        // 服务器自己回错（500/404 之类）：不能拿留存旧价遮住故障，撤掉垫的数据让问题暴露出来。
        withdrawSnapPrimed();
      }
      return null;
    }  // 行情失败不阻塞界面
  }

  async function loadKlines(codes) {
    // 启动时先用本地留存垫过的那批（sparkPrimed）仍要重新请求一次，
    // 否则联网后小图会一直停在旧数据上，只有断网失败时才继续用垫的那份。
    const missing = codes.filter((c) => c && (!klineMap.has(c) || sparkPrimed.has(c)));
    // 注意：不能命中缓存就直接 return。列表每次刷新都会整段重建 DOM，
    // 新 canvas 是空白画布，必须重画一遍迷你 K 线（这就是刷新后预览消失的原因）。
    if (!missing.length) { drawSparks(true); return; }
    // 本批请求是「服务器自己回错」还是「网络不通」，处理方式必须分开：
    // 服务器回错时若还拿本地留存把小图画出来，就变成「服务已经挂了、小图还装作正常」，没人能发现。
    let serverFault = false;
    for (let i = 0; i < missing.length; i += 60) {
      const chunk = missing.slice(i, i + 60);
      try {
        const data = await request(`${API_BASE}/api/klines`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ codes: chunk, period: 'day', adjust: 'qfq', bars: SPARK_BARS }),
        });
        const got = {};
        for (const item of data.items || []) {
          if (item && item.code) {
            klineMap.set(item.code, item.klines || []);
            got[item.code] = item.klines || [];
            sparkPrimed.delete(item.code);   // 网络拿到了真数据，就别再拿留存垫着了
          }
        }
        saveSparkSnap(got);
      } catch (err) {
        if (err && err.httpStatus) {
          // 服务端故障：这一批的留存小图也要撤掉，保持空白把问题暴露出来。
          serverFault = true;
          for (const c of chunk) { if (sparkPrimed.has(c)) { klineMap.delete(c); sparkPrimed.delete(c); } }
        }
      }
    }
    // 还没拿到迷你 K 线的（断网/请求失败），退回本地留存的最近一份，列表不至于一片空白。
    // 这里不再看手机自报的"有没有网"：那个状态在实际使用中经常是错的
    // （连着 WiFi 但没有外网时它照样说在线），结果就是一进页面满屏短横线。
    const still = codes.filter((c) => c && !klineMap.has(c));
    if (still.length && !serverFault) {
      const snap = loadSparkSnapRaw();
      let hit = 0;
      for (const c of still) {
        if (snap.items && snap.items[c] && snap.items[c].length) { klineMap.set(c, snap.items[c]); hit++; }
      }
      if (hit) drawSparks(true);
      return;
    }
    drawSparks(true);
  }

  // ---------- 迷你 K 线快照（断网用） ----------
  // 成功拿到就覆盖留存；只留最近一次，一只票一份。
  function saveSparkSnap(got) {
    const keys = Object.keys(got || {});
    if (!keys.length) return;
    try {
      const prev = loadSparkSnapRaw();
      const merged = Object.assign({}, prev.items || {});
      for (const k of keys) merged[k] = got[k];
      localStorage.setItem(SPARK_SNAP_KEY, JSON.stringify({ ts: Date.now(), items: merged }));
    } catch { /* 存不下就算了 */ }
  }
  function loadSparkSnapRaw() {
    try { return JSON.parse(localStorage.getItem(SPARK_SNAP_KEY)) || {}; }
    catch { return {}; }
  }
  // 排序只改变「展示顺序」，不写回 localStorage 的自选顺序；
  // 横滑换股取邻票也用同一套排序结果，否则滑动顺序和眼睛看到的列表对不上。
  const sortMode = { watch: '', screen: '', picks: '' };   // '' | 'desc' | 'asc'
  let reordering = false;                       // 防 paintQuotes → 重排 → paintQuotes 递归
  function quotePct(code) {
    const q = quoteMap.get(code);
    if (!q) return null;
    const p = Number(q.pct);
    return Number.isFinite(p) ? p : null;
  }
  // 排序用的涨跌幅：优先用结果里随行带来的「选股那一刻的涨跌幅」。
  // 为什么要用这个而不是实时行情：日内结果动辄三千多只，实时行情只按可视窗口拉，
  // 绝大多数行手上没有实时价，若拿实时价排序，没行情的全被甩到最后，排出来的顺序是假的。
  // 用选股时算好的涨跌幅，三千多只都有值，升序降序都是真的。
  function statPct(item) {
    if (item && Number.isFinite(item.screenPct)) return item.screenPct;
    return quotePct(item && item.code);
  }
  function orderedList(list, mode) {
    if (!mode) return list;
    const dir = mode === 'asc' ? 1 : -1;
    return list.slice().sort((a, b) => {
      const pa = statPct(a), pb = statPct(b);
      if (pa == null && pb == null) return 0;
      if (pa == null) return 1;      // 还没拿到行情的排最后，避免首帧乱跳
      if (pb == null) return -1;
      if (pa === pb) return 0;
      return (pa - pb) * dir;
    });
  }
  function renderSortBtn(btn, mode) {
    if (!btn) return;
    btn.textContent = mode === 'desc' ? '涨幅↓' : mode === 'asc' ? '涨幅↑' : '涨幅';
    btn.classList.toggle('on', !!mode);
    btn.setAttribute('aria-label',
      mode === 'desc' ? '当前按涨幅降序，点击改为升序'
        : mode === 'asc' ? '当前按涨幅升序，点击取消排序' : '按涨幅排序');
  }
  function cycleSort(key, btn) {
    sortMode[key] = sortMode[key] === '' ? 'desc' : sortMode[key] === 'desc' ? 'asc' : '';
    renderSortBtn(btn, sortMode[key]);
    if (key === 'watch') renderWatch();
    else if (key === 'picks') renderPicks();
    else renderScreen();
    // 排序会改变列表顺序，看盘抽屉里正在看的股票前后邻票也要跟着重算，否则横滑会滑到旧顺序的票
    if (openCode) syncNeighbors(openCode);
  }
  // 行情刷新后顺序可能变化：只在「实际顺序不一致」时才重建 DOM，否则每分钟白重排会顶掉滚动位置。
  function syncSortOrder() {
    let rerendered = false;
    const check = (sel, list, mode, render) => {
      if (!mode) return;
      const want = orderedList(list, mode).map((x) => x.code);
      const cur = $$(`${sel} .stock-row`).map((r) => r.dataset.code);
      if (want.length !== cur.length || want.some((c, i) => c !== cur[i])) { render(); rerendered = true; }
    };
    check('#watch-list', watchList, sortMode.watch, renderWatch);
    // 选股页是虚拟渲染的，DOM 里只有看得见的那几十行，拿它和整张表比必然不等、会一直重画。
    // 改成比「排好序的序列」本身：顺序真的变了才重排。
    if (sortMode.screen && screenRows.length) {
      const want = orderedList(screenRows, sortMode.screen);
      const changed = want.length !== vItems.length || want.some((x, i) => x.code !== (vItems[i] && vItems[i].code));
      if (changed) { renderScreen(true); rerendered = true; }
    }
    if (!rerendered) return;
    // 重排后当前看盘股票的前后邻票也变了，同步给横滑，避免滑到旧顺序的下一只
    if (openCode) syncNeighbors(openCode);
  }

  // ---------- 行渲染 ----------
  const pctClass = (pct) => (pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat');
  const sign = (v) => (v > 0 ? '+' : '');

  function rowHTML(item, opts) {
    const rank = opts && opts.rank != null ? `<span class="sr-rank">${opts.rank}</span>` : '';
    // 日内策略额外挂一个触发说明（时刻 + 形态）：日线结果不会传 opts.tag，这里就只留空标签，
    // 内层 data-code 单独包一层，是为了让 paintQuotes 只改代码文本时不会把这个标签冲掉。
    const tag = opts && opts.tag ? `<span class="tag" data-tag>${escapeAttr(opts.tag)}</span>` : '';
    // 有些行在拿到实时行情之前先显示选股那一刻的涨跌幅，免得用户看到满屏"--"以为没数据。
    // 实时行情一到就会被 paintQuotes 覆盖成最新价。
    const pct = opts && Number.isFinite(opts.pct) ? opts.pct : null;
    const pctHTML = pct == null ? '--' : `${sign(pct)}${pct.toFixed(2)}%`;
    return `${rank}<div class="sr-id"><span class="sr-name" data-name></span><span class="sr-code"><span data-code></span>${tag}</span></div>` +
      `<div class="sr-spark"><canvas data-spark></canvas></div>` +
      `<div class="sr-quote"><span class="sr-pct ${pct == null ? 'flat' : pctClass(pct)}" data-pct>${pctHTML}</span><span class="sr-price" data-price>--</span></div>`;
  }

  function rowLi(it, idx, opts) {
    const withWatch = !!(opts && opts.watch);
    const add = withWatch
      ? `<button class="sr-add ${inWatch(it.code) ? 'on' : ''}" type="button" data-toggle="${it.code}" data-name="${escapeAttr(it.name || '')}" aria-label="自选">${inWatch(it.code) ? '✓' : '+'}</button>`
      : '';
    return `<li class="stock-row${it.code === openCode ? ' active' : ''}" data-code="${it.code}" data-name="${escapeAttr(it.name || '')}">${rowHTML(it, { rank: opts && opts.rank ? idx + 1 : null, tag: it.tag, pct: it.screenPct })}${add}</li>`;
  }

  function buildList(container, items, opts) {
    if (!container) return;
    if (!items.length) { container.innerHTML = ''; return; }
    container.innerHTML = items.map((it, i) => rowLi(it, i, opts)).join('');
  }
  // 同步所有行上的自选按钮状态（自选列表增删后调用）
  function syncWatchButtons() {
    for (const btn of $$('.sr-add[data-toggle]')) {
      const on = inWatch(btn.dataset.toggle);
      btn.classList.toggle('on', on);
      btn.textContent = on ? '✓' : '+';
    }
  }
  function escapeAttr(s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }

  // 把行情填进列表行（原地更新，避免重排导致滚动跳动）
  function paintQuotes() {
    for (const row of $$('.stock-row')) {
      const code = row.dataset.code;
      const q = quoteMap.get(code);
      const nameEl = row.querySelector('[data-name]');
      const codeEl = row.querySelector('[data-code]');
      const pctEl = row.querySelector('[data-pct]');
      const priceEl = row.querySelector('[data-price]');
      const storedName = row.dataset.name || '';
      if (nameEl && !nameEl.textContent) nameEl.textContent = q && q.name ? q.name : storedName;
      if (codeEl && !codeEl.textContent) codeEl.textContent = plainCode(code);
      if (!q) {
        // 行里若已经带着「选股那一刻的涨跌幅」，就别拿"--"盖掉：滚动时那一瞬间行情还没回来，
        // 显示成空会让用户以为这票没数据。价格确实是空的，保留短横线。
        if (pctEl && pctEl.textContent === '--') { pctEl.className = 'sr-pct flat'; }
        if (priceEl) { priceEl.textContent = '--'; priceEl.className = 'sr-price'; }
        continue;
      }
      const pct = Number(q.pct);
      const cls = pctClass(pct);
      if (pctEl) { pctEl.textContent = `${sign(pct)}${(isFinite(pct) ? pct : 0).toFixed(2)}%`; pctEl.className = `sr-pct ${cls}`; }
      if (priceEl) { priceEl.textContent = Number(q.price).toFixed(2); priceEl.className = `sr-price ${cls}`; }
      if (nameEl) nameEl.className = `sr-name name-${cls === 'flat' ? '' : cls}`.trim();
    }
    // 行情到位后顺序才会变（首帧没行情时排序无意义），所以重排放在这里而不是 buildList 之后。
    if (!reordering) { reordering = true; try { syncSortOrder(); } finally { reordering = false; } }
  }

  // 画缩略图。数字行情 3 秒一刷，但缩略图重画是列表最吃 CPU 的部分，
  // 默认按 SPARK_MS 节流；DOM 重建后（画布被换新、是空白）必须 force 补画。
  function drawSparks(force) {
    const now = Date.now();
    if (!force && now - lastSparkAt < SPARK_MS) return;
    lastSparkAt = now;
    for (const canvas of $$('.stock-row canvas[data-spark]')) {
      const code = canvas.closest('.stock-row').dataset.code;
      const bars = klineMap.get(code);
      // K 线接口只给到已落库的交易日（盘中是昨天收盘那根），这里把当天的实时价并上去，
      // 否则价格在跳、图却停在昨天，看图的形状和涨跌对不上。
      if (bars && bars.length) window.Spark.render(canvas, withRealtimeBar(bars, quoteMap.get(code)), { bars: 40 });
    }
  }

  // ---------- 自选页 ----------
  function renderWatch() {
    const list = $('#watch-list');
    const empty = $('#watch-empty');
    const meta = $('#watch-meta');
    if (!list) return;
    if (!watchList.length) {
      list.innerHTML = '';
      if (empty) empty.classList.remove('hidden');
    } else {
      if (empty) empty.classList.add('hidden');
      buildList(list, orderedList(watchList, sortMode.watch), {});
      paintQuotes();
      syncWatchButtons();
      drawSparks();   // buildList 重建了 <li>，迷你 K 线画布被换新，必须补画
    }
    if (meta) meta.textContent = watchList.length ? `${watchList.length} 只` : '';
  }

  function refreshWatch() {
    renderWatch();
    if (!watchList.length) return;
    loadKlines(watchList.map((x) => x.code));
    refreshQuotes();
  }

  // ---------- 选股页 ----------
  // 结果少于这个数量就整段画出来，多了才走「只画看得见的那几十行」。
  // 门槛定在 150：手机一屏大约十几行，一百多行全画也不算慢，省得为了小列表引入额外复杂度。
  const V_LIST_MIN = 150;

  function screenScroller() { return document.querySelector('#tab-screener .scroll-area'); }

  // 只为「当前看得见的行」补行情和迷你 K 线。三千多只如果全量拉，
  // 上游一次只认前一百只，等于永远在拉列表最顶上那一百只，用户滚到哪都是"--"。
  let vDataTimer = 0;
  function ensureVisibleData(first, last) {
    if (vDataTimer) return;    // 快速滚动时别每帧都发请求，等手停下来再补
    vDataTimer = setTimeout(() => {
      vDataTimer = 0;
      const lo = Math.max(0, first - 10), hi = Math.min(vItems.length, last + 10);
      const need = [];
      for (let i = lo; i < hi; i++) {
        const c = vItems[i] && vItems[i].code;
        if (c && (!quoteMap.has(c) || !klineMap.has(c))) need.push(c);
      }
      if (!need.length) return;
      const batch = need.slice(0, 100);
      loadKlines(batch);
      refreshQuotes(batch).catch(() => {});
    }, 350);
  }

  function vRender(force) {
    const list = $('#results-body');
    if (!list) return;
    const n = vItems.length;
    if (!n) { list.innerHTML = ''; vStart = vEnd = -1; return; }
    if (n < V_LIST_MIN) {
      // 小列表：照旧一次画完，不搞占位那套
      if (force || vStart !== 0 || vEnd !== n) {
        vStart = 0; vEnd = n;
        list.innerHTML = vItems.map((it, i) => rowLi(it, i, { rank: true, watch: true })).join('');
        paintQuotes();
        drawSparks(true);
        ensureVisibleData(0, n);
      }
      return;
    }
    const sc = screenScroller();
    const scTop = sc ? sc.scrollTop : 0;
    const viewH = sc ? (sc.clientHeight || 800) : 800;
    // 上下各多画 6 行：手指快速滑动时不会露出空白，等滚到了再补画
    const first = Math.max(0, Math.floor(scTop / vRowH) - 6);
    const last = Math.min(n, Math.ceil((scTop + viewH) / vRowH) + 6);
    if (!force && first === vStart && last === vEnd) return;
    vStart = first; vEnd = last;
    const pad = (h) => `<li class="v-pad" aria-hidden="true" style="height:${Math.max(0, Math.round(h))}px"></li>`;
    let html = pad(first * vRowH);
    for (let i = first; i < last; i++) html += rowLi(vItems[i], i, { rank: true, watch: true });
    html += pad((n - last) * vRowH);
    list.innerHTML = html;
    // 行高按真实渲染出来的那只量一次，写死的数字一旦和样式对不上，滚动位置就会一直偏。
    // 量到不一样就地改上下两块占位的高度，不整段重画，避免抖动。
    const firstRow = list.querySelector('.stock-row');
    if (firstRow) {
      const h = Math.round(firstRow.getBoundingClientRect().height);
      if (h > 20 && Math.abs(h - vRowH) > 1) {
        vRowH = h;
        const kids = list.children;
        if (kids.length) {
          kids[0].style.height = `${Math.round(first * vRowH)}px`;
          kids[kids.length - 1].style.height = `${Math.round((n - last) * vRowH)}px`;
        }
      }
    }
    paintQuotes();
    drawSparks(true);
    ensureVisibleData(first, last);
  }

  function renderScreen(keepScroll) {
    const list = $('#results-body');
    const empty = $('#empty-state');
    if (!list) return;
    if (!screenRows.length) {
      vItems = []; vStart = vEnd = -1;
      list.innerHTML = '';
      if (empty) empty.classList.remove('hidden');
      return;
    }
    if (empty) empty.classList.add('hidden');
    vItems = orderedList(screenRows, sortMode.screen);
    // 换排序或换了一批结果，位置必须回到顶部，否则会停在新列表的中间，看着像"没反应"
    if (!keepScroll) {
      const sc = screenScroller();
      if (sc) sc.scrollTop = 0;
    }
    vStart = vEnd = -1;
    vRender(true);
  }

  // 滚动时按可视窗口重画那一段行；用 requestAnimationFrame 合并高频事件，
  // 手指快速滑动也只画最后落定的那一屏。
  const vScroller = screenScroller();
  if (vScroller) {
    vScroller.addEventListener('scroll', () => {
      if (vItems.length < V_LIST_MIN) return;
      if (vRaf) return;
      vRaf = requestAnimationFrame(() => { vRaf = 0; vRender(false); });
    }, { passive: true });
  }

  // ---------- 历史 ----------
  let historyItems = [];
  try { historyItems = JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; } catch { historyItems = []; }
  function pruneHistory() {
    const now = Date.now();
    historyItems = historyItems.filter((x) => x && (now - (x.at || 0)) < HISTORY_TTL).slice(0, HISTORY_CAP);
  }
  pruneHistory();
  // 历史存在浏览器本地，容量很小（一般 5MB 上下）。日内一次能出三千多只结果，
  // 原样存两份就把空间吃光了，后面的记录会存不进去、甚至整段丢掉。
  // 所以：最新一条尽量存全，老记录只留前面一部分（够回看用），还超就继续往下砍。
  function persistHistory() {
    const shrink = (it, n) => (it && Array.isArray(it.results) && it.results.length > n
      ? { ...it, results: it.results.slice(0, n), truncated: it.results.length }
      : it);
    // 逐级往下砍：新的一条尽量完整，更早的记录只留个开头，够回看列表用。
    for (const keep of [4000, 1200, 400, 120, 40, 10]) {
      const trimmed = historyItems.slice(0, HISTORY_CAP)
        .map((it, i) => shrink(it, i === 0 ? keep : Math.min(keep, 200)));
      try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(trimmed));
        historyItems = trimmed;
        return true;
      } catch { /* 空间还不够，继续往下砍 */ }
    }
    return false;
  }
  function saveHistory(run) {
    const item = {
      id: run.id || `run-${Date.now()}`, at: Date.now(), baseDate: run.baseDate || '', adjust: run.adjust,
      count: run.count, scanned: run.scanned, passed: run.passed, elapsedMs: run.elapsedMs,
      source: run.source, results: run.results, strategyName: run.strategyName || '',
      mode: run.mode || '',   // 日内策略的结果要能认出身份，历史回看才画得出触发标签和买点
    };
    historyItems = [item, ...historyItems.filter((x) => x.id !== item.id)];
    pruneHistory();
    // 新跑完这一条就是当前正在看的列表，标签高亮必须跟着移到它身上，
    // 否则高亮还停在上一次选股上，看起来像「标签没更新」。
    activeHistoryId = item.id;
    // 过滤条件也要跟着这条走：策略名为空时会话里的过滤词可能还停在上一个策略上，
    // 那样新条目会被 visibleHistory 过滤掉，chip 根本不显示，高亮也就无从谈起。
    filterStrategyName = item.strategyName || '';
    persistHistory();
    renderHistory();
  }
  function fmtTime(ts) { const d = new Date(ts); const p = (n) => String(n).padStart(2, '0'); return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; }
  let activeHistoryId = null;
  // 当前选股页策略栏选中的策略名，用于把历史 chip 与列表过滤到「该策略自己的最近几次选股」。
  let filterStrategyName = '';
  // 当前正在编辑的策略 id（策略库下拉里的真实 id）；保存时据此就地更新，而不是新建策略。
  let currentStrategyId = '';
  function visibleHistory() {
    const label = (filterStrategyName || '').trim();
    if (!label) return historyItems;
    return historyItems.filter((x) => ((x && x.strategyName) || '').trim() === label);
  }
  function renderHistory() {
    const bar = $('#history-bar');
    if (!bar) return;
    if (!historyItems.length) { bar.classList.add('hidden'); bar.innerHTML = ''; return; }
    bar.classList.remove('hidden');
    const list = visibleHistory();
    if (!list.length) { bar.classList.add('hidden'); bar.innerHTML = ''; return; }
    bar.innerHTML = list.map((it) =>
      `<button type="button" class="history-chip${it.id === activeHistoryId ? ' active' : ''}" data-history-index="${historyItems.indexOf(it)}"><span>${fmtTime(it.at)}</span><small>${it.count}只</small></button>`).join('');
  }

  // ---------- 选股执行 ----------
  // 说明文案顺序（用户要求）：命中/扫描 → 耗时 → 基准日 → 复权/来源。
  // 例：「100/5373 · 5.6s · 基准日 2026-10-23 · qfq · 预计算」
  // 预筛启用时在最前面加一段「预筛 X → Y」，说明先淘汰到多少票再走完整扫描；
  // 分母用 universeSize（全市场参与范围）而非 scanned（预筛后的数量），保持口径一致。
  function runMetaText(run) {
    const hit = `${run.count}/${(run.universeSize || run.scanned || 0).toLocaleString()}`;
    const cost = `${((run.elapsedMs || 0) / 1000).toFixed(2)}s`;
    const prefilter = (run.prefilter && run.prefilter.enabled)
      ? `预筛 ${run.prefilter.universe.toLocaleString()} → ${run.prefilter.survived.toLocaleString()} · `
      : '';
    return `${prefilter}${hit} · ${cost} · 基准日 ${run.baseDate || '最新'} · ${run.adjust} · ${run.source === 'precompute' ? '预计算' : '演示'}`;
  }
  function runMetaDetail(run) {
    const rows = [
      ['命中/扫描', `${run.count} / ${(run.scanned || 0).toLocaleString()}`],
      ['耗时', `${((run.elapsedMs || 0) / 1000).toFixed(2)}s`],
      ['基准日', run.baseDate || '最新交易日'],
      ['复权', run.adjust || '—'],
      ['来源', run.source === 'precompute' ? '预计算' : '演示数据'],
      ['通过条件', `${run.passed} 只`],
    ];
    if (run.prefilter && run.prefilter.enabled) {
      rows.unshift(['预筛', `${run.prefilter.universe.toLocaleString()} → ${run.prefilter.survived.toLocaleString()}（${run.prefilter.conditionCount} 条件 · ${run.prefilter.bars} 根）`]);
    }
    return rows;
  }
  function fillMetaPop(run) {
    const pop = $('#meta-pop');
    if (!pop) return;
    pop.innerHTML = runMetaDetail(run)
      .map(([k, v]) => `<div class="mp-row"><span class="mp-k">${k}</span><span class="mp-v">${v}</span></div>`)
      .join('');
  }
  // 把后端结果行转成列表要用的形状。日线结果没有触发字段，映射出来就是 undefined，
  // 列表和分时图那边看到 undefined 会自动不显示，不需要另外分两套逻辑。
  function mapResults(results, isIntraday) {
    return (results || []).map((r) => ({
      code: r.code, name: r.name || '', close: r.close,
      triggerTime: r.triggerTime, triggerPrice: r.triggerPrice,
      triggerPct: r.triggerPct, form: r.form, gap: r.gap, midPct: r.midPct,
      // 选股那一刻算出来的涨跌幅。它跟着结果一起过来，几千只全都有值，
      // 排序、以及行情还没到时的占位显示都靠它，不用等实时行情。
      screenPct: Number.isFinite(Number(r.nowPct)) ? Number(r.nowPct) : null,
      tag: isIntraday && r.triggerTime
        ? `${fmtTriggerTime(r.triggerTime)} ${r.form || ''} ${Number(r.triggerPct) >= 0 ? '+' : ''}${Number(r.triggerPct || 0).toFixed(2)}%`
        : undefined,
    }));
  }

  function applyRun(run) {
    const isIntraday = run.mode === 'intraday';
    screenRows = mapResults(run.results, isIntraday);
    intradayMode = isIntraday;
    runBaseDate = run.baseDate || '';
    renderScreen();
    const meta = $('#run-meta');
    if (meta) meta.textContent = runMetaText(run);
    fillMetaPop(run);
    if (run.strategyName) syncStrategyBar(run.strategyName);
    // 不再一次性给全部结果预取迷你 K 线：几千只既拉不动也画不完，
    // 交给虚拟滚动按「看得见的行」去补（见 ensureVisibleData）。行情先拉一屏，别让用户等。
    refreshQuotes();
  }

  const butRun = $('#run');
  if (butRun) butRun.addEventListener('click', async () => {
    const strategy = readStrategy();
    const strategyName = ($('#strategy-name')?.value || '').trim();
    butRun.disabled = true;
    const prev = butRun.textContent;
    butRun.textContent = '…';
    const meta = $('#run-meta');
    if (meta) meta.textContent = '正在读取数据并执行选股…';
    try {
      // 服务端这一次就已经把完整结果（含命中明细与统计）返回了，不用再取一遍。
      // 选股冷启动实测十几秒，单独给 60 秒上限，避免刚开工就被判超时。
      const run = await request(`${API_BASE}/api/screenings`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ strategy, baseDate: $('#base-date').value || undefined, board: $('#board').value, adjust: $('#adjust').value }),
      }, 60000);
      run.strategyName = strategyName;
      applyRun(run);
      saveHistory(run);
      if (window.TdxChart && window.TdxChart.prefetch) window.TdxChart.prefetch(screenRows.map((r) => r.code), { period: 'day', adjust: run.adjust });
    } catch (error) {
      if (meta) meta.textContent = error.message;
    } finally {
      butRun.disabled = false;
      butRun.textContent = prev;
    }
  });

  // ---------- 策略（下钻页）----------
  const editor = $('#dsl-editor');
  const defaultStrategy = { version: 1, universe: { excludeSt: true }, all: [{ period: 'week', indicator: 'close_above_ma', params: { length: 20 } }, { period: 'day', indicator: 'volume_ratio', params: { length: 20, min: 1.2 } }], limit: 100 };
  if (editor) editor.value = JSON.stringify(defaultStrategy, null, 2);
  function readStrategy() { try { return JSON.parse(editor.value); } catch { throw new Error('策略代码不是有效 JSON'); } }

  const PERIOD_LABEL = { day: '日', week: '周', month: '月' };
  function describeCondition(cond) {
    const p = cond.params || {};
    if (p.label) return p.label;
    const period = PERIOD_LABEL[cond.period] || cond.period || '';
    switch (cond.indicator) {
      case 'expr': return `${period}线表达式条件`;
      case 'close_above_ma': return `${period}线收盘价站上 MA${p.length ?? 20}`;
      case 'close_below_ma': return `${period}线收盘价跌破 MA${p.length ?? 20}`;
      case 'volume_ratio': return `${period}线量比 ≥ ${p.min ?? 1.2}（MA${p.length ?? 20}）`;
      case 'momentum': return `${period}线 ${p.length ?? 20} 周期涨幅 ≥ ${((Number(p.min ?? 0)) * 100).toFixed(2)}%`;
      case 'ma_cross': return `${period}线 MA${p.fast ?? 5} 上穿 MA${p.slow ?? 20}`;
      default: return `${period}线条件（${cond.indicator || '未知'}）`;
    }
  }
  function renderStrategySummary() {
    const body = $('#strategy-summary-body');
    const countEl = $('#strategy-summary-count');
    if (!body || !editor) return;
    let strategy;
    try { strategy = JSON.parse(editor.value); }
    catch { body.innerHTML = '<p class="ss-empty ss-invalid">当前内容不是有效 JSON，暂无法生成说明。</p>'; if (countEl) countEl.textContent = ''; return; }
    const conds = Array.isArray(strategy && strategy.all) ? strategy.all : [];
    if (!conds.length) { body.innerHTML = '<p class="ss-empty">该策略未定义条件（all 为空）。</p>'; if (countEl) countEl.textContent = ''; return; }
    const groups = new Map();
    for (const cond of conds) {
      const label = describeCondition(cond);
      const m = /^模块(.+?)·(.*)$/.exec(label);
      const key = m ? `模块${m[1]}` : '其它条件';
      const text = m ? m[2] : label;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ text, period: cond.period });
    }
    body.innerHTML = [...groups.entries()].map(([title, items]) =>
      `<section class="ss-group"><h4 class="ss-group-title">${title}</h4><ul class="ss-list">` +
      items.map((it) => `<li><span class="ss-text">${it.text}</span><span class="ss-period">${PERIOD_LABEL[it.period] || it.period || ''}线</span></li>`).join('') +
      `</ul></section>`).join('');
    if (countEl) countEl.textContent = `${groups.size} 组 · ${conds.length} 条`;
  }
  if (editor) {
    renderStrategySummary();
    let t = 0;
    editor.addEventListener('input', () => { clearTimeout(t); t = setTimeout(renderStrategySummary, 250); });
  }

  async function loadStrategyLibrary() {
    const select = $('#strategy-lib');
    if (!select) return;
    const keep = select.value;
    select.innerHTML = '';
    const local = loadLocalStrategy();
    if (local && local.strategy) {
      const opt = document.createElement('option');
      opt.value = 'local:current';
      opt.dataset.name = local.name || '';
      opt.textContent = `${local.name}（已保存）`;
      select.appendChild(opt);
    }
    try {
      const list = await request(`${API_BASE}/api/strategies`);
      for (const item of list) {
        const opt = document.createElement('option');
        opt.value = item.id;
        opt.dataset.name = item.name || '';
        opt.textContent = `${item.name}（${item.conditions} 条）`;
        select.appendChild(opt);
      }
    } catch { /* 忽略 */ }
    if (keep && [...select.options].some((o) => o.value === keep)) select.value = keep;
    else if (select.options.length) select.selectedIndex = 0;
    // 选中项变化后同步设置页编辑器（否则策略栏显示 A、设置页却是默认 DSL）。
    if (select.value) select.dispatchEvent(new Event('change'));
  }
  $('#strategy-lib')?.addEventListener('change', async (e) => {
    const id = e.target.value;
    if (!id) return;
    // run:current 是策略栏临时插入的「当前列表来源」占位项，库里并不存在，
    // 不能拿它去请求 /api/strategies/:id（必然 404），也不要覆盖设置页编辑器。
    if (id === 'run:current') return;
    // 程序内部（loadStrategyLibrary 收尾）派发的 change 只为同步设置页编辑器，
    // 不应顺带切换下方选股列表；只有用户手动改下拉才回放该策略的历史结果。
    const byUser = e.isTrusted === true;
    if (id === 'local:current') {
      currentStrategyId = id;
      const local = loadLocalStrategy();
      if (local && local.strategy) {
        if (editor) editor.value = JSON.stringify(local.strategy, null, 2);
        const nameInput = $('#strategy-name');
        if (nameInput) nameInput.value = local.name || '';
        if (local.board && $('#board')) $('#board').value = local.board;
        if (local.adjust && $('#adjust')) $('#adjust').value = local.adjust;
        renderStrategySummary();
      }
      if (byUser) showLatestRunFor(local && local.name);
      return;
    }
    try {
      const result = await request(`${API_BASE}/api/strategies/${encodeURIComponent(id)}`);
      const strategy = result.strategy || result;
      currentStrategyId = id;
      if (editor) editor.value = JSON.stringify(strategy, null, 2);
      const nameInput = $('#strategy-name');
      if (nameInput && strategy.name) nameInput.value = strategy.name;
      renderStrategySummary();
      if (byUser) showLatestRunFor(strategy.name);
    } catch { /* 忽略 */ }
  });
  // 策略说明 / 策略代码 页签切换
  const stTabs = $('#strategy-tabs');
  stTabs?.addEventListener('click', (e) => {
    const btn = e.target.closest('.st-tab');
    if (!btn) return;
    const key = btn.dataset.stab;
    stTabs.querySelectorAll('.st-tab').forEach((b) => b.classList.toggle('active', b === btn));
    document.querySelectorAll('#settings-page .st-pane').forEach((p) => p.classList.toggle('active', p.dataset.spane === key));
  });

  function loadLocalStrategy() {
    try { return JSON.parse(localStorage.getItem(STRAT_KEY) || 'null'); } catch { return null; }
  }
  function saveLocalStrategy(obj) {
    try { localStorage.setItem(STRAT_KEY, JSON.stringify(obj)); } catch { /* 忽略 */ }
  }
  // 策略栏跟随"当前股票列表对应的策略"：能在库里找到同名策略就选中它，
  // 找不到（例如手改过名字的运行）就临时插一个选项并选中，保证显示的永远是真实来源。
  function syncStrategyBar(name) {
    const select = $('#strategy-lib');
    const label = (name || '').trim();
    if (!select || !label) return;
    // 日期标签（chips）只展示"该策略自己的最近几次选股"，因此这里记录过滤用的策略名。
    filterStrategyName = label;
    const hit = [...select.options].find((o) => o.value !== 'run:current' && o.dataset.name === label);
    if (hit) {
      select.value = hit.value;
      // 列表来源已对齐到库里某条真实策略，保存时应就地更新它（而不是退化成本地草稿）。
      if (currentStrategyId !== 'local:current') currentStrategyId = hit.value;
      // 策略栏改值后必须同步设置页编辑器；程序派发（isTrusted=false）只回填编辑器、不切列表。
      select.dispatchEvent(new Event('change'));
      renderHistory();
      return;
    }
    let cur = select.querySelector('option[value="run:current"]');
    if (!cur) {
      cur = document.createElement('option');
      cur.value = 'run:current';
      select.insertBefore(cur, select.firstChild);
    }
    cur.textContent = label;
    cur.dataset.name = label;
    select.value = 'run:current';
    // 列表来源是运行时策略（库里暂无同名项），保存时按本地草稿处理。
    currentStrategyId = 'run:current';
    renderHistory();
  }

  $('#strategy-save')?.addEventListener('click', async () => {
    const fb = $('#validation');
    let strategy;
    try { strategy = readStrategy(); } catch (error) { if (fb) { fb.textContent = error.message; fb.className = 'feedback error'; } return; }
    const nameEl = $('#strategy-name');
    const name = ((nameEl && nameEl.value) || '').trim() || '自定义策略';
    // 名称随策略对象一起提交：服务端就地更新「同一条」策略（改名不新增下拉项）。
    strategy.name = name;
    const board = ($('#board') && $('#board').value) || 'main';
    const adjust = ($('#adjust') && $('#adjust').value) || 'qfq';
    try {
      const result = await request(`${API_BASE}/api/strategies/validate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ strategy }) });
      if (result && result.ok === false) throw new Error(result.error || '策略未通过校验');
      // 绑定了服务端策略 id 时，直接就地更新该 id（写回 strategies/<id>.json 并同步内存），
      // 这样改名后仍是原来那一条，不会多出下拉项。local:current 尚无服务端对应，仍留本地草稿。
      const oldName = (($('#strategy-lib') && $('#strategy-lib').selectedOptions[0] && $('#strategy-lib').selectedOptions[0].dataset.name) || '').trim();
      const canPut = currentStrategyId && currentStrategyId !== 'local:current' && currentStrategyId !== 'run:current';
      if (canPut) {
        await request(`${API_BASE}/api/strategies/${encodeURIComponent(currentStrategyId)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ strategy }) });
        // 改名后历史记录里还留着旧名字，会让这条策略的日期标签全部消失，这里一并同步。
        if (oldName && oldName !== name) {
          let touched = false;
          historyItems.forEach((x) => { if (x && ((x.strategyName || '').trim() === oldName)) { x.strategyName = name; touched = true; } });
          if (touched) { try { localStorage.setItem(HISTORY_KEY, JSON.stringify(historyItems)); } catch { /* 忽略 */ } }
        }
        if (fb) { fb.textContent = '已保存到该策略，选股页将同步显示新名称'; fb.className = 'feedback success'; }
      } else {
        saveLocalStrategy({ id: 'local:current', name, strategy, board, adjust });
        if (fb) { fb.textContent = '已保存，选股页将显示该策略'; fb.className = 'feedback success'; }
      }
      // 保存后立刻把选股页的策略栏切到这条策略（用户要求：改名保存后选股页要联动更新）
      await loadStrategyLibrary();
      syncStrategyBar(name);
    } catch (error) { if (fb) { fb.textContent = error.message; fb.className = 'feedback error'; } }
  });

  // 基准日快捷
  let dataLatest = '';
  const shiftDays = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() - n); return x.toISOString().slice(0, 10); };
  const baseDateInput = $('#base-date');
  const dateQuick = $('#date-quick');
  function syncQuickActive() {
    if (!dateQuick) return;
    const value = (baseDateInput && baseDateInput.value) || '';
    let matched = '';
    if (!value || (dataLatest && value === dataLatest)) matched = 'clear';
    else if (dataLatest) matched = ['7', '30', '90'].find((off) => value === shiftDays(dataLatest, Number(off))) || '';
    dateQuick.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.offset === matched));
  }
  dateQuick?.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const off = btn.dataset.offset;
    if (off === 'clear') { if (baseDateInput) baseDateInput.value = ''; syncQuickActive(); return; }
    if (!dataLatest) return;
    if (baseDateInput) baseDateInput.value = shiftDays(dataLatest, Number(off));
    syncQuickActive();
  });
  baseDateInput?.addEventListener('input', syncQuickActive);

  async function loadStatus() {
    const st = $('#system-status');
    try {
      const health = await request(`${API_BASE}/api/health`);
      if (st) st.textContent = health.ok ? (health.dataSource?.mode === 'precompute' ? '数据服务在线' : '演示数据') : '数据服务异常';
      try {
        const pc = await request(`${API_BASE}/api/precompute-status`);
        dataLatest = (pc && pc.lastCompletedDate) || '';
        if (dataLatest) {
          if (baseDateInput) { baseDateInput.min = shiftDays(dataLatest, 400); baseDateInput.max = dataLatest; }
          const hint = $('#base-date-hint');
          if (hint && !(baseDateInput && baseDateInput.value)) hint.textContent = `数据最新交易日 ${dataLatest}；留空即按最新交易日运行。`;
          syncQuickActive();
        }
      } catch { /* 忽略 */ }
    } catch (err) {
      // 断网和"服务挂了"要分开说：请求根本没发出去（没有 httpStatus）才算断网，
      // 这种情况启用本地留存并标出日期；服务器回错了就如实报错，不能用旧数据掩盖。
      if (err && !err.httpStatus) handleOffline(err.name === 'AbortError' ? '连接超时' : '');
      else if (st) { st.textContent = '服务未连接'; withdrawSnapPrimed(); }
    }
  }

  // ---------- 添加自选（下钻页）----------
  const addSearch = $('#add-search');
  const addResults = $('#add-results');
  const addEmpty = $('#add-empty');
  let addTimer = 0;
  function renderAddResults(items) {
    if (!addResults) return;
    if (!items.length) { addResults.innerHTML = ''; if (addEmpty) addEmpty.classList.remove('hidden'); return; }
    if (addEmpty) addEmpty.classList.add('hidden');
    addResults.innerHTML = items.map((it) =>
      `<li class="stock-row" data-code="${it.code}" data-name="${escapeAttr(it.name || '')}">${rowHTML(it, {})}` +
      `<button class="sr-add ${inWatch(it.code) ? 'on' : ''}" type="button" data-toggle="${it.code}" data-name="${escapeAttr(it.name || '')}" aria-label="自选">${inWatch(it.code) ? '✓' : '+'}</button></li>`
    ).join('');
    paintQuotes();
    loadKlines(items.map((i) => i.code));
  }
  async function doSearch(q) {
    if (!q) { if (addEmpty) { addEmpty.textContent = '输入代码或名称开始搜索'; addEmpty.classList.remove('hidden'); } if (addResults) addResults.innerHTML = ''; return; }
    try {
      const data = await request(`${API_BASE}/api/stocks?q=${encodeURIComponent(q)}`);
      const items = data.items || [];
      if (!items.length && addEmpty) addEmpty.textContent = '没有匹配的股票';
      renderAddResults(items);
    } catch { if (addEmpty) addEmpty.textContent = '搜索失败，请重试'; }
  }
  addSearch?.addEventListener('input', () => {
    clearTimeout(addTimer);
    addTimer = setTimeout(() => doSearch(addSearch.value.trim()), 250);
  });
  addResults?.addEventListener('click', (e) => {
    const btn = e.target.closest('.sr-add');
    if (btn) {
      e.stopPropagation();
      const code = btn.dataset.toggle;
      if (inWatch(code)) removeWatch(code); else addWatch(code, btn.dataset.name);
      btn.classList.toggle('on', inWatch(code));
      btn.textContent = inWatch(code) ? '✓' : '+';
      refreshWatch();
      return;
    }
    const row = e.target.closest('.stock-row');
    if (row) openChart(row.dataset.code, row.dataset.name);
  });

  // ---------- 买票清单 ----------
  // 早盘 9:35~10:00 服务端每 5 分钟替我们跑一次日内策略，出手的票按代码去重记进当天清单。
  // 这里只做展示：拉清单 → 列出来 → 点进去看那一分钟的分时和买点标记。
  function pickTag(p) {
    const t = fmtTriggerTime(p.triggerTime);
    const pct = Number(p.triggerPct);
    const pctTxt = Number.isFinite(pct) ? `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%` : '';
    return [t, p.form || '', pctTxt].filter(Boolean).join(' ');
  }
  function mapPicks(doc) {
    return (doc && doc.picks ? doc.picks : []).map((p) => ({
      code: p.code, name: p.name || '',
      triggerTime: p.triggerTime, triggerPrice: p.triggerPrice,
      triggerPct: Number.isFinite(Number(p.triggerPct)) ? Number(p.triggerPct) : null,
      form: p.form || '', gap: p.gap, midPct: p.midPct,
      firstSeen: p.firstSeen || '', seenAt: p.seenAt || '',
      baseDate: p.baseDate || (doc && doc.date) || '',
      // 清单里的涨跌幅用「出手那一刻」的涨幅排，不受现在行情跳动影响，才不会越看越乱。
      screenPct: Number.isFinite(Number(p.triggerPct)) ? Number(p.triggerPct) : null,
      tag: pickTag(p),
    }));
  }
  function renderPickDates() {
    const bar = $('#picks-dates');
    if (!bar) return;
    if (!pickDates.length) { bar.innerHTML = ''; bar.classList.add('hidden'); return; }
    bar.classList.remove('hidden');
    bar.innerHTML = pickDates.slice(0, 10).map((d) =>
      `<button type="button" class="history-chip${d === pickSelDate ? ' active' : ''}" data-pickdate="${d}"><span>${d.slice(5)}</span></button>`
    ).join('');
  }
  function renderPicks() {
    const list = $('#picks-body');
    const empty = $('#picks-empty');
    const meta = $('#picks-meta');
    const stamp = $('#picks-stamp');
    const note = $('#picks-note');
    if (!list) return;
    renderPickDates();
    if (!pickRows.length) {
      list.innerHTML = '';
      if (empty) empty.classList.remove('hidden');
    } else {
      if (empty) empty.classList.add('hidden');
      buildList(list, orderedList(pickRows, sortMode.picks), {});
      paintQuotes();
      drawSparks(true);
      loadKlines(pickRows.map((r) => r.code));
    }
    if (meta) meta.textContent = pickRows.length ? `${pickRows.length} 只` : '';
    if (stamp) {
      const runs = (pickDoc && pickDoc.runs) || [];
      const last = runs[runs.length - 1];
      stamp.textContent = last
        ? `${pickSelDate} 最近一次盯盘 ${fmtTriggerTime(last.hhmm)} · 扫 ${last.scanned} 只 · 出手 ${last.count} 只`
        : (pickSelDate ? `${pickSelDate} 还没有盯盘记录` : '—');
    }
    if (note) {
      const auto = pickDoc && pickDoc.auto;
      note.textContent = auto && auto.enabled
        ? `早盘 9:35~10:00 每 5 分钟自动盯一次${auto.nextAt ? `，下次 ${auto.nextAt}` : ''}`
        : '自动盯盘未开启（已收盘或已关掉）';
    }
  }
  async function loadPicks(date) {
    try {
      const q = date ? `?date=${encodeURIComponent(date)}` : '';
      const doc = await request(`${API_BASE}/api/intraday-picks${q}`);
      pickDoc = doc;
      pickDates = doc.dates || [];
      pickSelDate = doc.date || (pickDates[0] || '');
      pickRows = mapPicks(doc);
      renderPicks();
      if (pickRows.length) refreshQuotes(pickRows.map((r) => r.code));
    } catch (err) {
      const empty = $('#picks-empty');
      if (empty) { empty.textContent = `清单读取失败：${err.message || '请稍后重试'}`; empty.classList.remove('hidden'); }
    }
  }
  async function runPicksNow() {
    const btn = $('#picks-run');
    if (btn) { btn.disabled = true; btn.textContent = '跑着…'; }
    const note = $('#picks-note');
    if (note) note.textContent = '正在按日内策略扫一遍全市场…';
    try {
      const data = await request(`${API_BASE}/api/intraday-picks/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }, 120000);
      if (!data.ok) {
        if (note) note.textContent = data.reason || '这一格没有可用行情，未记录';
      } else {
        pickDoc = data.doc || null;
        pickDates = (data.doc && data.doc.dates) || pickDates;
        pickSelDate = data.date || pickSelDate;
        pickRows = mapPicks(data.doc);
        renderPicks();
        if (note) note.textContent = `刚扫完：出手 ${data.total} 只，本次新增 ${data.added} 只`;
        if (pickRows.length) { refreshQuotes(pickRows.map((r) => r.code)); loadKlines(pickRows.map((r) => r.code)); }
      }
    } catch (err) {
      if (note) note.textContent = `扫描失败：${err.message || '请稍后重试'}`;
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '现在跑'; }
    }
  }
  $('#picks-refresh')?.addEventListener('click', () => loadPicks(pickSelDate));
  $('#picks-run')?.addEventListener('click', () => runPicksNow());
  $('#picks-dates')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-pickdate]');
    if (!b) return;
    loadPicks(b.dataset.pickdate);
  });
  $('#picks-body')?.addEventListener('click', (e) => {
    const row = e.target.closest('.stock-row');
    if (row) openChart(row.dataset.code, row.dataset.name);
  });

  // ---------- 页签 / 下钻页切换 ----------
  function switchTab(tab) {
    activeTab = tab;
    $$('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    $$('.tab-panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === tab));
    const t = $('.app-top-title');
    const titles = { watchlist: '自选', screener: '选股', picks: '买票清单', review: '复盘' };
    if (t) t.textContent = titles[tab] || '选股';
    if (tab === 'review') loadReview();
    if (tab === 'picks') loadPicks();
    requestAnimationFrame(() => { paintQuotes(); drawSparks(); });
  }
  // 复盘页与自选/选股同在一个文档里，切过去时只需让它校准画布尺寸
  function loadReview() {
    if (window.RVShow) RVShow();
  }
  $$('.tab-btn').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  // 支持直接带 #review 打开复盘页，便于收藏或分享链接
  if (location.hash === '#review') switchTab('review');
  else if (location.hash === '#picks') switchTab('picks');
  function openPage(id) { const el = document.getElementById(id); if (el) { el.classList.add('open'); el.setAttribute('aria-hidden', 'false'); } }
  function closePage(id) { const el = document.getElementById(id); if (el) { el.classList.remove('open'); el.setAttribute('aria-hidden', 'true'); } }
  $$('[data-close]').forEach((b) => b.addEventListener('click', () => closePage(b.dataset.close)));
  $('#watch-add')?.addEventListener('click', () => { openPage('add-page'); setTimeout(() => addSearch && addSearch.focus(), 260); });
  $('#watch-refresh')?.addEventListener('click', () => { refreshWatch(); });
  // 涨幅排序：三态循环 关 → 降序 → 升序 → 关
  const watchSortBtn = $('#watch-sort');
  const screenSortBtn = $('#screen-sort');
  const picksSortBtn = $('#picks-sort');
  watchSortBtn?.addEventListener('click', () => cycleSort('watch', watchSortBtn));
  screenSortBtn?.addEventListener('click', () => cycleSort('screen', screenSortBtn));
  picksSortBtn?.addEventListener('click', () => cycleSort('picks', picksSortBtn));
  renderSortBtn(watchSortBtn, sortMode.watch);
  renderSortBtn(screenSortBtn, sortMode.screen);
  renderSortBtn(picksSortBtn, sortMode.picks);
  $('#screen-settings')?.addEventListener('click', () => openPage('settings-page'));

  // 选股说明气泡：点文字弹全部内容，点任何其他地方（或再次点文字）收起
  const metaEl = $('#run-meta');
  const metaPop = $('#meta-pop');
  if (metaEl && metaPop) {
    metaEl.addEventListener('click', (e) => {
      e.stopPropagation();
      metaPop.hidden = !metaPop.hidden;
      metaEl.setAttribute('aria-expanded', metaPop.hidden ? 'false' : 'true');
    });
    document.addEventListener('click', () => { if (!metaPop.hidden) metaPop.hidden = true; });
  }

  function applyHistoryItem(it) {
    if (!it) return;
    activeHistoryId = it.id;
    const isIntraday = it.mode === 'intraday';
    screenRows = mapResults(it.results, isIntraday);
    intradayMode = isIntraday;
    runBaseDate = it.baseDate || '';
    renderScreen();
    const meta = $('#run-meta');
    if (meta) meta.textContent = `历史 · ${runMetaText(it)}`;
    fillMetaPop(it);
    if (it.strategyName) syncStrategyBar(it.strategyName);
    refreshQuotes();
    renderHistory();
  }
  // 切换策略时，把下方列表回放成该策略最近一次选股结果（用户需求：策略与列表联动）。
  function showLatestRunFor(name) {
    filterStrategyName = name || '';
    const items = name ? historyItems.filter((it) => it.strategyName === name) : historyItems;
    if (items.length) {
      applyHistoryItem(items[0]);
      return;
    }
    // 该策略还没有选股记录：清空列表并给出中性提示，不动策略栏选中项。
    activeHistoryId = null;
    screenRows = [];
    renderScreen();
    const meta = $('#run-meta');
    if (meta) meta.textContent = name ? `${name} · 暂无选股记录` : '暂无选股记录';
    const pop = $('#meta-pop');
    if (pop) pop.innerHTML = '';
    renderHistory();
  }
  $('#history-bar')?.addEventListener('click', (e) => {
    const chip = e.target.closest('.history-chip');
    if (!chip) return;
    const it = historyItems[Number(chip.dataset.historyIndex)];
    applyHistoryItem(it);
  });

  // ---------- 看盘 ----------
  if (window.TdxChart) {
    window.TdxChart.init({
      canvas: $('#chart-canvas'),
      quote: $('#chart-quote'),
      nameEl: $('#chart-name'),
    });
  }
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
    return new Promise((resolve, reject) => {
      try {
        const ta = document.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
        resolve();
      } catch (err) { reject(err); }
    });
  }
  $('#chart-copy')?.addEventListener('click', async (e) => {
    if (!openCode) return;
    const btn = e.currentTarget;
    const prev = btn.textContent;
    try { await copyText(plainCode(openCode)); btn.textContent = '已复制'; }
    catch { btn.textContent = '复制失败'; }
    setTimeout(() => { btn.textContent = prev; }, 1200);
  });

  // 看盘顶部「加自选」按钮：状态跟随当前股票是否已在自选。
  function syncChartAdd() {
    const btn = $('#chart-add');
    if (!btn) return;
    const on = !!openCode && inWatch(openCode);
    btn.classList.toggle('on', on);
    btn.textContent = on ? '✓' : '＋';
    btn.setAttribute('aria-label', on ? '取消自选' : '加自选');
  }
  $('#chart-add')?.addEventListener('click', () => {
    if (!openCode) return;
    const q = quoteMap.get(openCode);
    const name = (q && q.name) || $('#chart-name')?.textContent || '';
    if (inWatch(openCode)) removeWatch(openCode); else addWatch(openCode, name);
    syncChartAdd();
    syncWatchButtons();
    renderWatch();
    if (watchList.length) { loadKlines(watchList.map((x) => x.code)); refreshQuotes(); }
  });

  // 邻票：把当前所在列表里的前后一只透传给看盘模块，供副图横滑预渲染。
  // openChart 与 tdx:switch 都必须调用，否则横滑换股后 neighbors 仍指向旧位置，再滑等于原地（bug）。
  function syncNeighbors(code) {
    if (!window.TdxChart || !window.TdxChart.setNeighbors) return;
    const base = activeTab === 'watchlist' ? watchList : (activeTab === 'picks' ? pickRows : screenRows);
    const mode = activeTab === 'watchlist' ? sortMode.watch
      : activeTab === 'picks' ? sortMode.picks : sortMode.screen;
    // 必须用排序后的顺序：否则用户按涨幅排完序，横滑却按原始顺序走，滑动方向和眼睛看到的列表对不上。
    const list = orderedList(base, mode);
    const i = list.findIndex((x) => x.code === code);
    const pick = (x) => (x ? { code: x.code, name: x.name } : null);
    window.TdxChart.setNeighbors(i > 0 ? pick(list[i - 1]) : null, i >= 0 ? pick(list[i + 1]) : null);
  }

  function openChart(code, name) {
    openCode = code;
    if (!window.TdxChart) return;
    const drawer = $('#chart-drawer');
    const backdrop = $('#chart-backdrop');
    $('#chart-code').textContent = plainCode(code);
    $('#chart-name').textContent = name || '';
    drawer.classList.add('open'); backdrop.classList.add('show'); drawer.setAttribute('aria-hidden', 'false');
    syncChartAdd();
    syncNeighbors(code);
    syncAdjustMenu();              // 上次停在分时的话，复权菜单这会儿就得藏起来
    scheduleChartQuote();          // 开图即启动 3 秒轮询（收盘后也会走 30 秒低频探测）
    // 先把这一只的最新价拿到手，再画图：否则首屏那根当日 K 线要等几秒才补上，
    // 表现为「刚点进去缺最后一根，过一会儿自己长出来」。本地已有当日价就直接用，不白等。
    const cachedQ = quoteMap.get(code);
    const quoteReady = (cachedQ && cachedQ.date === cstDate())
      ? Promise.resolve()
      : refreshQuotes([code]).catch(() => {});
    quoteReady.then(() => {
      if (openCode !== code) return;
      return window.TdxChart.open(code, name || '');
    }).then(() => {
      if (openCode !== code) return; // 快速换股时丢弃已过期这轮回填，避免旧股行情串进新图
      // 日内选股结果里这只票带触发时刻，把买点交给图表：切到分时就标在那一分钟的价位上。
      // 日线结果没有这些字段，这里传 null，等于把上一只票的标记清掉。
      // 清单页是另一套数据：先找选股结果，找不到再找清单里的那只，并带上清单自己的交易日。
      let row = screenRows.find((r) => r.code === code);
      let buyDate = runBaseDate;
      if (!row || !row.triggerTime) {
        const p = pickRows.find((r) => r.code === code);
        if (p && p.triggerTime) { row = p; buyDate = p.baseDate || pickSelDate || runBaseDate; }
      }
      if (window.TdxChart.setBuyPoint) {
        window.TdxChart.setBuyPoint(row && row.triggerTime ? {
          date: buyDate, time: row.triggerTime, y: row.triggerPrice,
          text: `${fmtTriggerTime(row.triggerTime)} ${row.form || ''}`.trim(),
        } : null);
      }
      const q0 = quoteMap.get(code);
      if (q0 && window.TdxChart.applyQuote) window.TdxChart.applyQuote(q0);
      // 开图后补一次回源：缓存里的价可能是十几秒前的，进图后立刻对齐到当下。
      return refreshQuotes([code]).then(() => {
        if (openCode !== code) return;
        const q = quoteMap.get(code);
        if (q && window.TdxChart.applyQuote) window.TdxChart.applyQuote(q);
      });
    }).catch((err) => {
      const box = $('#chart-error');
      if (box) { box.textContent = err.message; box.hidden = false; clearTimeout(box._timer); box._timer = setTimeout(() => { box.hidden = true; }, 2400); }
    });
  }
  function closeChart() {
    openCode = null;
    clearTimeout(chartQuoteTimer);   // 关掉看盘就停 3 秒轮询，别让它继续打上游
    chartQuoteTimer = null;
    const drawer = $('#chart-drawer');
    const backdrop = $('#chart-backdrop');
    drawer.classList.remove('open'); backdrop.classList.remove('show'); drawer.setAttribute('aria-hidden', 'true');
    $$('.stock-row.active').forEach((r) => r.classList.remove('active'));
    syncChartAdd();
    // 关抽屉时抽屉后方露出的列表可能停在打开前的价格（看盘的 3 秒轮询是静默的，
    // 刻意不重绘列表）。这里立刻拉一次并强制重画，避免「关掉看盘后价格倒退」的观感。
    if (inTradingWindow() && !marketClosed) refreshQuotes().catch(() => {});
    requestAnimationFrame(() => { paintQuotes(); drawSparks(true); });
  }

  $('#watch-list')?.addEventListener('click', (e) => {
    const row = e.target.closest('.stock-row');
    if (!row) return;
    $$('.stock-row.active').forEach((r) => r.classList.remove('active'));
    row.classList.add('active');
    openChart(row.dataset.code, row.dataset.name);
  });
  $('#results-body')?.addEventListener('click', (e) => {
    const toggle = e.target.closest('.sr-add');
    if (toggle) {
      const code = toggle.dataset.toggle;
      const name = toggle.dataset.name || '';
      if (inWatch(code)) removeWatch(code); else addWatch(code, name);
      toggle.classList.toggle('on', inWatch(code));
      toggle.textContent = inWatch(code) ? '✓' : '+';
      renderWatch();            // 自选页列表实时跟着变
      if (watchList.length) { loadKlines(watchList.map((x) => x.code)); refreshQuotes(); }
      return;
    }
    const row = e.target.closest('.stock-row');
    if (!row) return;
    $$('.stock-row.active').forEach((r) => r.classList.remove('active'));
    row.classList.add('active');
    openChart(row.dataset.code, row.dataset.name);
  });
  $('#chart-close')?.addEventListener('click', closeChart);
  $('#chart-backdrop')?.addEventListener('click', closeChart);
  // 分时不涉及复权（分时价就是真实成交价，没有复权概念）。
  // 抽成函数是因为它得跟着「当前周期」走，而不是只在点周期按钮那一刻生效——
  // 上次停在分时再打开抽屉时，周期仍是 min，菜单也必须藏好。
  function syncAdjustMenu() {
    const wrap = document.querySelector('.adjust-menu-wrap');
    if (!wrap || !window.TdxChart) return;
    const p = window.TdxChart.period ? window.TdxChart.period() : 'day';
    wrap.style.display = p === 'min' ? 'none' : '';
  }

  $('#period-seg')?.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    // setPeriod 会立刻改写 state.period，失败时再问 period() 已经拿不到旧值，
    // 所以在切换前先把当前周期记下来，供 catch 里回退。
    const prevPeriod = window.TdxChart.period ? window.TdxChart.period() : 'day';
    $('#period-seg').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
    const wrap = document.querySelector('.adjust-menu-wrap');
    if (wrap) wrap.style.display = b.dataset.period === 'min' ? 'none' : '';
    window.TdxChart.setPeriod(b.dataset.period).then(() => {
      timelineTickCount = 0;    // 刚 load 过整条曲线，计数归零，别让下一次 tick 又白拉一遍
      scheduleChartQuote();     // 周期切换后重新对齐 3 秒轮询（切到分时要立刻开始校准）
    }).catch((err) => {
      // 分时拉不到（停牌/新股无分时/上游 502）时不能静默白屏：
      // 提示原因并把周期按钮回退到切换前的那个，避免界面停在一个空图上。
      const box = $('#chart-error');
      if (box) {
        box.textContent = (err && err.message) || '分时加载失败';
        box.hidden = false;
        clearTimeout(box._timer);
        box._timer = setTimeout(() => { box.hidden = true; }, 3000);
      }
      // 真正把周期退回去，再重新加载一次，把旧周期的图恢复出来
      window.TdxChart.setPeriod(prevPeriod).catch(() => {});
      $('#period-seg').querySelectorAll('button').forEach((x) => {
        x.classList.toggle('active', x.dataset.period === prevPeriod);
      });
      if (wrap) wrap.style.display = prevPeriod === 'min' ? 'none' : '';
    });
  });
  $('#adjust-seg')?.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    $('#adjust-seg').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
    const seg = $('#adjust-seg'); if (seg) seg.hidden = true;
    window.TdxChart.setAdjust(b.dataset.adjust).catch(() => {});
  });
  $('#adjust-toggle')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const seg = $('#adjust-seg');
    if (seg) seg.hidden = !seg.hidden;
  });
  document.addEventListener('click', (e) => {
    const seg = $('#adjust-seg');
    if (seg && !seg.hidden && !e.target.closest('.adjust-menu-wrap')) seg.hidden = true;
  });
  // 副图横滑换股后同步高亮，并重算邻票（否则只能换一只）
  window.addEventListener('tdx:switch', (e) => {
    const d = e.detail || {};
    if (!d.code) return;
    openCode = d.code;
    timelineTickCount = 0;           // 刚换股已 load 过整条分时，校准计数归零
    scheduleChartQuote();            // 换股后重新对齐 3 秒节奏
    $('#chart-code').textContent = plainCode(d.code);
    $('#chart-name').textContent = d.name || '';
    syncChartAdd();
    syncNeighbors(d.code);
    $$('.stock-row.active').forEach((r) => r.classList.remove('active'));
    const row = $(`.stock-row[data-code="${d.code}"]`);
    if (row) row.classList.add('active');
    // 横滑换股后必须补一次实时价注入：chart.js 内部只画 K 线，行情由 app 侧推送，
    // 少了这一步主图就停在上一交易日收盘（表现为“滑动后不显示最新价”）。
    if (window.TdxChart && window.TdxChart.applyQuote) {
      const q0 = quoteMap.get(d.code);
      if (q0) window.TdxChart.applyQuote(q0);
      refreshQuotes([d.code]).then(() => {
        if (openCode !== d.code) return;   // 又滑走了，丢弃这轮过期回填
        const q = quoteMap.get(d.code);
        if (q) window.TdxChart.applyQuote(q);
      }).catch(() => {});
    }
  });

  // 键盘（桌面调试用）
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closePage('add-page'); closePage('settings-page'); closeChart(); }
  });

  // ---------- 禁止双击缩放（兜底）----------
  let lastTouch = 0;
  document.addEventListener('touchend', (e) => {
    const now = Date.now();
    if (now - lastTouch <= 300) e.preventDefault();
    lastTouch = now;
  }, { passive: false });
  document.addEventListener('gesturestart', (e) => e.preventDefault());

  // ---------- 行情轮询调度 ----------
  // 两套节奏，互不干扰：
  //  1) 列表轮询（QUOTE_MS=3s）：自选/选股列表的涨幅，盘中可见时与看盘同节奏。
  //  2) 看盘轮询（CHART_QUOTE_MS=3s）：只看当前打开的那一只，模拟通达信的实时盯盘。
  // 3 秒只拉这一只（约 500 字节），服务端还有 2s 缓存兜底，上游压力可忽略。
  const CHART_QUOTE_MS = 3000;
  let chartQuoteTimer = null;
  let timelineTickCount = 0;   // 分时校准节流：每 10 个 3 秒周期（≈30 秒）拉一次整条曲线
  // 非交易时段（含周末、节假日）完全不轮询：休市期间价格不会变，继续打上游纯属浪费。
  // 节假日无法用日历判断（每年调休不同），改由行情自证：盘中拉到的快照日期若全停在往日，
  // 说明当天休市，停掉轮询；每 30 分钟放一次探测，日期翻篇了立刻恢复。
  let quoteTimer = null;
  let lastQuotePullAt = 0;    // 最近一次成功拉到行情的时刻，收盘后补拉用来防抖
  let marketClosed = false;   // 当天是否已确认休市
  let closedDate = '';        // 判定休市那天的日期，跨天要重置

  function msUntilNextWindow(ts) {
    const now = ts || Date.now();
    const { day, min } = cstMinutes(now);
    const open = [555, 780];       // 9:15 / 13:00
    if (day !== 0 && day !== 6) {
      for (const o of open) if (min < o) return (o - min) * 60000;
      if (min <= 905) return QUOTE_MS;   // 还在窗口内
    }
    // 下一个工作日 9:15（跨周末按天数推，节假日多等一天无害：到点后自证会重新确认）
    let d = 1;
    while (d < 8) {
      const p = new Date(now + CST_OFFSET + d * 86400000);
      const wd = p.getUTCDay();
      if (wd !== 0 && wd !== 6) break;
      d++;
    }
    const p = new Date(now + CST_OFFSET + d * 86400000);
    const target = Date.UTC(p.getUTCFullYear(), p.getUTCMonth(), p.getUTCDate(), 9, 15) - CST_OFFSET;
    return Math.max(60000, target - now);
  }

  async function tickQuotes() {
    // 必须 await：refreshQuotes 是异步的，不等待就立刻读 quoteMap
    // 只会拿到上一轮的旧行情（表现为"看盘页价格不更新/显示昨天数据"）。
    const items = await refreshQuotes();
    // 节假日自证：盘中拉到的一批行情日期都早于今天 → 当天休市，停掉轮询。
    if (Array.isArray(items) && items.length && holidayCheckable()) {
      const today = cstDate();
      const anyToday = items.some((q) => q && q.date === today);
      if (!anyToday) { marketClosed = true; closedDate = today; }
      // 反向自愈：之前因上游快照滞后被误判成休市，一旦拉到当日数据就立刻解除。
      // 没有这一步，一次误判会把整个下午的轮询都锁死（见 closedWaitMs 的探测分支）。
      else if (marketClosed && closedDate === today) { marketClosed = false; closedDate = ''; }
    }
    if (openCode && window.TdxChart && window.TdxChart.applyQuote) {
      const q = quoteMap.get(openCode);
      if (q) window.TdxChart.applyQuote(q);
    }
  }

  // 下一个「交易窗口开启」的时刻（不含当前正在进行的窗口）。
  // 用于休市判定成立后彻底停摆：不设探测，等下一个窗口自然醒来。
  function msUntilMarketOpen(ts) {
    const now = ts || Date.now();
    const { day, min } = cstMinutes(now);
    if (day !== 0 && day !== 6) {
      for (const o of [555, 780]) if (min < o) return (o - min) * 60000;
    }
    let d = 1;
    while (d < 8) {
      const p = new Date(now + CST_OFFSET + d * 86400000);
      const wd = p.getUTCDay();
      if (wd !== 0 && wd !== 6) break;
      d++;
    }
    const p = new Date(now + CST_OFFSET + d * 86400000);
    const target = Date.UTC(p.getUTCFullYear(), p.getUTCMonth(), p.getUTCDate(), 9, 15) - CST_OFFSET;
    return Math.max(60000, target - now);
  }

  // 休市状态下的等待时长。
  // 关键点：不能无条件睡到下一个交易窗口。`marketClosed` 是「全市场快照日期都没翻篇」
  // 推出来的结论，而上游快照滞后（不是真节假日）也会触发同一条判定。若在 10:00 被误判，
  // 直接睡到次日 9:15 就等于把当天下午 13:00-15:05 整个交易时段冻结掉。
  // 所以：当前仍处在交易窗口内时只做低频探测（拉一次快照，日期翻篇就自愈，
  // 见 tickQuotes 的反向复位分支）；真正在窗口外才睡到下一个窗口。
  const CLOSED_PROBE_MS = 8 * 60000;
  function closedWaitMs(ts) {
    const now = ts || Date.now();
    if (inTradingWindow(now)) return CLOSED_PROBE_MS;
    return Math.min(msUntilMarketOpen(now), 6 * 3600000);
  }

  function scheduleQuotes(delay) {
    clearTimeout(quoteTimer);
    let wait;
    let probe = false;   // 本轮回调醒来后是否允许「休市状态下也拉一次」
    // 收盘收尾期：仍在按快节奏补拉，目的就是把 11:30 / 15:00 那最后一笔捞回来。
    // 这里必须先于「跨出窗口」分支判断，否则 11:31 一到就直接睡到 13:00。
    const settle = inSettleWindow();
    if (typeof delay === 'number') wait = delay;
    else if (!inTradingWindow()) {
      // 跨出交易窗口且不在收尾期，才算真正离开盘面，休市判定作废。
      // 收尾期不能复位：节假日 11:30 收尾期内若把 marketClosed 清掉，10 秒后醒来
      // 就会当成正常盘面拉一次全量，拉回来发现还是往日又置回休市，如此每 10 秒翻一次，
      // 白打上游近 20 次。收尾期只是「给最后一笔留个尾巴」，不改变休市结论。
      if (!settle) { marketClosed = false; closedDate = ''; }
      // 收盘收尾期：不睡到下一个窗口，而是留几分钟按 10 秒节奏补拉，
      // 把 11:30 / 15:00 那一笔漏在窗口外的收尾价捞回来。
      wait = settle ? SETTLE_MS : Math.min(msUntilNextWindow(), 6 * 3600000);
    } else if (marketClosed) {
      // 休市：降到低频探测，而不是彻底停摆——必须留一条自愈的路径
      probe = true;
      wait = closedWaitMs();
    } else wait = QUOTE_MS;

    quoteTimer = setTimeout(async () => {
      const today = cstDate();
      if (closedDate && closedDate !== today) { marketClosed = false; closedDate = ''; }
      // 探测轮必须在 marketClosed 仍为 true 时照拉一次：
      // 只有真拉到数据，tickQuotes 里的反向复位分支才有机会执行。
      // 若这里也加 !marketClosed，一次误判就会让当天剩余时段彻底不自愈。
      // 收尾期（收盘后几分钟）必须照拉：此时已经不算「盘中」，若不额外放行，
      // 上一段排好的 10 秒节奏会白等，最后一笔照样补不进来。
      const pullOk = inTradingWindow() || inSettleWindow();
      if (pullOk && document.visibilityState === 'visible' && (!marketClosed || probe)) {
        await tickQuotes().catch(() => {});
      }
      scheduleQuotes();
    }, wait);
  }
  scheduleQuotes();

  // ---------- 看盘 3 秒轮询 ----------
  // 只针对「当前在看盘页打开的那一只」，与列表的 60 秒轮询完全分开：
  // 列表要覆盖上百只，3 秒一次会把上游打满；看盘只有一只，3 秒一次毫无压力。
  //
  // 设计要点：
  //  - 抽屉没打开（openCode 为空）就不跑，避免后台标签页空转。
  //  - 非交易时段不跑，但保留一次「开图即拉」，保证收盘后打开看到的是当天收盘价。
  //  - 用 setTimeout 自调度而不是 setInterval：上一轮没回来不会堆积请求。
  //  - 页面不可见时不跑（移动端切后台），切回来立刻补一次。
  function scheduleChartQuote() {
    clearTimeout(chartQuoteTimer);
    if (!openCode) return;
    // 非交易时段彻底不轮询：股价不会变，3 秒打一次上游纯属浪费。
    // 但页面可能一直开着跨过开盘时间，所以设一个「等开盘」的定时器，到点自动醒来。
    // marketClosed 分支同样走 closedWaitMs：休市可能是误判，必须留一条 8 分钟的自愈探测，
    // 一旦列表轮询那边确认当日数据已翻篇（marketClosed 复位），这里下一轮就恢复正常节奏。
    if (!inTradingWindow() || marketClosed) {
      // 收尾期例外：收盘后几分钟仍要按快节奏补拉，把最后一笔捞回来。
      if (inSettleWindow() && !marketClosed) {
        chartQuoteTimer = setTimeout(async () => {
          if (!openCode) return;
          if (document.visibilityState === 'visible') {
            await chartQuoteTick().catch(() => {});
          }
          scheduleChartQuote();
        }, SETTLE_MS);
        return;
      }
      chartQuoteTimer = setTimeout(() => {
        if (!openCode) return;
        // 交易窗口内一律补拉一次：marketClosed 可能是误判（上游快照滞后），
        // 本函数拉的是单只行情，不会反过来改写 marketClosed，所以这里放行是安全的；
        // 不放行的话，误判一次就要等列表侧 8 分钟探测才可能恢复，期间分时图是死的。
        if (inTradingWindow()) chartQuoteTick().catch(() => {});
        scheduleChartQuote();
      }, closedWaitMs());
      return;
    }
    chartQuoteTimer = setTimeout(async () => {
      if (!openCode) return;
      if (document.visibilityState === 'visible') {
        await chartQuoteTick().catch(() => {});
      }
      scheduleChartQuote();
    }, CHART_QUOTE_MS);
  }

  async function chartQuoteTick() {
    const code = openCode;
    if (!code) return;
    // 静默刷新：只更新 quoteMap 并回填图表，不重绘自选/选股列表。
    // 列表此时被抽屉盖住，每 3 秒重写几百行 DOM 加全部迷你 K 线纯属白烧主线程。
    const items = await refreshQuotes([code], { silent: true });
    if (openCode !== code) return;             // 期间换了股，丢弃这轮
    // 注意：这里刻意不做「节假日自证」。样本只有当前这一只，停牌股/新股返回的
    // date 会停在停牌前，单只样本必然判出「当天休市」，把全局 marketClosed 打成 true，
    // 连累 60 秒列表轮询一起降到 30 分钟。休市判定只交给列表轮询那批全量样本去做。
    const q = quoteMap.get(code);
    if (q && window.TdxChart && window.TdxChart.applyQuote) window.TdxChart.applyQuote(q);
    // 单向自愈：单只样本只能用来「解除」误判休市，绝不能用来「判定」休市。
    // 拿到当日数据说明今天确实在交易（至少这一只在动），把误判的 marketClosed 放开；
    // 反过来若这只停牌、date 停在停牌前，我们不据此判「休市」，交给全量列表样本。
    if (q && q.date === cstDate() && marketClosed) { marketClosed = false; closedDate = ''; }
    // 分时曲线校准：3 秒一次只推最后一个点（约 500 字节），
    // 每 10 轮（≈30 秒）才重新拉整条曲线对齐一次，避免每分钟漏点累积成偏差。
    if (window.TdxChart && window.TdxChart.period && window.TdxChart.period() === 'min') {
      if (++timelineTickCount >= 10) {
        timelineTickCount = 0;
        window.TdxChart.refreshTimeline().catch(() => {});
      }
    }
  }

  // 从后台切回前台：浏览器会节流定时器，回来时价格可能已过时，若在盘内立即补拉一次。
  // 收盘后第一次回到前台（或刚打开页面）时的陈价补拉。
  // 场景：上午 11:31 收盘后一直把 App 挂在后台，12 点半才点开——此时既不在盘中也不在
  // 收尾期，按原逻辑一次都不拉，屏幕上永远停着上午 11:2x 的旧价。这里只要发现手里
  // 的行情不是今天的，就在收盘后的时段里补拉一次，且同一天最多补几次，不回到 3 秒轮询。
  function staleAfterClose() {
    const { day, min } = cstMinutes();
    if (day === 0 || day === 6) return false;
    // 11:33–13:00 与 15:08 之后，属于「已收盘但当天还没翻篇」的时段
    const afterAM = min >= 693 && min < 780;
    const afterPM = min >= 908;
    return afterAM || afterPM;
  }
  // 手里是否已经有一只票的行情是今天的。
  // 不能只看 allCodes() 的第一只：第一只可能正好是停牌股（date 停在停牌前），
  // 拿它判断「陈价」会恒为陈旧，于是每次回前台、每过一分钟都白拉一次全量。
  function hasQuoteToday(codes) {
    const today = cstDate();
    for (const c of codes) {
      const q = quoteMap.get(c);
      if (q && q.date === today) return true;
    }
    return false;
  }
  let caughtUpDate = '';   // 已经补到当天行情的日期，当天不再重复补
  async function catchUpClosedQuote() {
    if (!staleAfterClose() || marketClosed) return;
    const today = cstDate();
    if (caughtUpDate === today) return;       // 今天已经补过了
    const codes = allCodes();
    if (!codes.length) return;
    if (hasQuoteToday(codes)) { caughtUpDate = today; return; }  // 已经是最新的一天，不必再拉
    if (Date.now() - lastQuotePullAt < 60000) return;   // 一分钟内不重复补
    try {
      await refreshQuotes();
      if (hasQuoteToday(allCodes())) caughtUpDate = today;
    } catch (e) { /* 补拉失败就等下次，不打扰用户 */ }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    // 收尾期同样要补拉：11:31 切回前台时正是最需要把最后一笔捞回来的时刻。
    if ((inTradingWindow() || inSettleWindow()) && !marketClosed) tickQuotes().catch(() => {});
    catchUpClosedQuote();      // 收尾期之后才回到前台的话，靠这一下把当天收盘价补齐
    scheduleQuotes();
  });
  window.addEventListener('online', () => {
    if ((inTradingWindow() || inSettleWindow()) && !marketClosed) tickQuotes().catch(() => {});
    catchUpClosedQuote();
    scheduleQuotes();
    // 网络回来了：状态栏恢复，并立刻重拉一次，把断网期间落下的价格补齐。
    const st = $('#system-status');
    if (st) st.classList.remove('offline');
    markOffline(false);
    loadStatus();   // 状态栏文字也要跟着回到"数据服务在线"，否则一直挂着离线/未连接的旧文案
    // 断网期间列表用的是本地留存，可能已经很旧。联网后把这些一次性清掉重拉，
    // 免得继续拿着旧数据当实时价看（不清的话要等下次重新打开页面才会更新）。
    offlineApplied = false;
    klineMap.clear();
    if (window.TdxChart && window.TdxChart.markOnline) window.TdxChart.markOnline();
    refreshQuotes().then(() => {
      loadKlines(allCodes()).catch(() => {});
      if (!openCode || !window.TdxChart || !window.TdxChart.applyQuote) return;
      const q = quoteMap.get(openCode);
      if (q) window.TdxChart.applyQuote(q);
      // 光推一笔行情不够：看盘主图的 K 线本身还是断网时那份旧留存，
      // 得让它重新回源一次，否则用户看到的还是旧图（只是提示没了，更容易误判成最新）。
      if (window.TdxChart.load) window.TdxChart.load().catch(() => {});
    }).catch(() => {});
  });

  // ---------- 断网降级 ----------
  // 断网时：列表先用本地留存的最近一次行情快照填起来（能看，但不是实时价），
  // 看盘里已缓存的 K 线/分时同样能翻看。顶部会标注数据日期，避免被当成实时价。
  let offlineApplied = false;
  function markOffline(on) {
    document.body.classList.toggle('offline-mode', !!on);
    const tip = $('#offline-tip');
    if (tip) tip.hidden = !on;
  }
  function handleOffline(reason) {
    const st = $('#system-status');
    if (st) { st.textContent = '离线'; st.classList.add('offline'); }
    markOffline(true);
    if (!offlineApplied) {
      const ts = applyQuoteSnap();
      offlineApplied = true;
      const tip = $('#offline-tip');
      if (tip) {
        const why = reason ? `（${reason}）` : '';
        tip.textContent = ts
          ? `离线模式${why}：显示的是 ${fmtStamp(ts)} 留存的行情，不是实时价`
          : `离线模式${why}：本地还没有存过行情，联网后再看`;
      }
    }
  }
  function fmtStamp(ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  window.addEventListener('offline', handleOffline);
  // 页面刚加载完也补一次：11:36 才打开 App 的场景走这条
  setTimeout(() => { catchUpClosedQuote(); }, 800);

  // ---------- 启动 ----------
  loadWatch();
  renderWatch();
  renderHistory();
  // 先把本地留存的行情/小图垫上，再去请求网络。
  // 不能等"判断出没网"再回填：手机上报的联网状态经常是错的（WiFi 没外网也报在线、
  // PWA 冷启动时状态还没就绪），只要判错一次，用户看到的就是满屏短横线。
  // 垫完之后网络请求成功会直接覆盖，失败则保留并标出留存日期。
  primeFromSnap();
  loadStatus();
  refreshWatch();
  // 选股页默认选中最新一次历史运行（等策略库就绪，策略栏才能联动到对应策略）。
  loadStrategyLibrary().then(() => {
    if (historyItems.length) applyHistoryItem(historyItems[0]);
  });

  // PWA
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register(API_BASE + '/sw.js', { scope: API_BASE + '/' }).catch(() => {});
    });
  }
})();

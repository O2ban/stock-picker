// 日内（分时）选股引擎：与日/周线选股完全分开的一条通道。
//
// 为什么单独一套：日线引擎是「每只票取一批日K，在最后一根上求值」，
// 而日内策略要的是「把今天的分时点逐分钟走一遍，找到第一次满足条件的时刻」，
// 数据源、时间轴、求值方式都不同，硬塞进日线条件白名单只会把两边都搞乱。
//
// 硬性口径（回测脚本 scripts/intraday-backtest 与之对齐）：
//   · 决策只能用「那一刻已经出现」的分时点，绝不看触发之后的价格；
//   · 买入价 = 触发那一分钟的成交价；
//   · 「中」（降中线）= (当日累计最高 + 当日累计最低)/2，与分时图上的「中」同一算法；
//   · 量能三段 = 先成堆放量 → 成堆缩量（价格回踩、接近中线上方）→ 成堆放量上拉不动摇。
//
// 当前生效的选股条件（用户 2026-11-19 版口径）：
//   ① 开盘幅度：低开不超过 2 个点，高开不超过 1.5 个点；
//   ② 时间窗：9:35 起，到 10:00 止；
//   ③ 位置：价格在昨收之上（不做一直待在水下的票），且「中」线也在昨收之上；
//   ④ 买点涨幅：1~3 个点，太高不留拉升空间；
//   ⑤ 前一日不能拉太猛也不能跌太深；
//   ⑥ 形态：不来回抽搐（短窗口内方向翻转次数受限），要求有趋势感；
//   ⑦ 量能（必须满足）：连续若干根放量 → 连续若干根明显缩量（价格回踩到中线附近或上方）→ 连续若干根放量上拉；
//      孤零零一根大阳量不算。
import { fetchQuotes, fetchTimeline } from './quotes.js';
import { loadShortDaily } from './db.js';

export const INTRADAY_INDICATORS = ['intraday'];

const DEFAULT_PARAMS = {
  window: { from: '0935', to: '1000' },
  gap: { min: -2, max: 1.5 },
  gain: { min: 1, max: 3 },
  // 前一日涨跌幅：用户已明确「不看前一天怎么走」，默认关闭，参数保留以便日后要用时打开。
  prevDay: { enabled: false, min: -5, max: 5 },
  // 降中线只要求买点时价格在它附近或上方，不再强求它整体站在昨收之上。
  mid: { requireAboveWater: false, requireAboveMid: true, nearPct: 0.8 },
  // 形态成立后不硬卡在同一根出手：允许再等最多 waitBars 根，
  // 等到价格确实在往上涨、且站在水面和降中线上方时再买。避免「特征刚好那根涨幅不够」漏票。
  entry: { waitBars: 4, requireRising: true },
  vol: {
    shrinkRatio: 0.3,     // 缩量堆均量不得超过「开盘至今每分钟均量」的这个倍数
    shrinkBurst: 3,       // 缩量堆比前一段放量堆小多少倍才算「夸张地缩」
    rebound: 2.2,         // 拉升堆均量比缩量堆放大多少倍
    pileMin: 3,           // 缩量堆至少连续几根
    upMin: 2,             // 拉升段至少几根
    upMax: 8,             // 拉升段最多几根
    upPct: 0.2,           // 拉升段累计涨幅下限（%）
    dropPct: 0.25,        // 缩量堆里砸下来的幅度下限（%）
    look: 20,             // 每段最多看多少根
  },
  shape: { enabled: true, look: 6, maxFlips: 2 },
  excludeLimitUp: false,
};

function hhmmToMinute(t) {
  const s = String(t || '');
  if (!/^\d{4}$/.test(s)) return null;
  return Number(s.slice(0, 2)) * 60 + Number(s.slice(2));
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function mergeParams(raw) {
  const out = {};
  for (const [k, v] of Object.entries(DEFAULT_PARAMS)) {
    const given = raw && raw[k];
    out[k] = (v && typeof v === 'object' && !Array.isArray(v)) ? { ...v, ...(given || {}) } : (given === undefined ? v : given);
  }
  return out;
}

// 策略校验：日内策略的结构与日线策略不同，走这一支，不进日线的条件白名单。
// all 里只放「给人看的模块说明」，真正生效的是 intraday 参数块，
// 这样界面上那份条件清单读起来仍然是自然语言。
export function validateIntradayStrategy(strategy) {
  if (!strategy || strategy.version !== 1) throw new Error('strategy.version must be 1');
  if (!strategy.intraday || typeof strategy.intraday !== 'object' || Array.isArray(strategy.intraday)) {
    throw new Error('日内策略缺少 intraday 参数块');
  }
  const p = mergeParams(strategy.intraday);
  const from = hhmmToMinute(p.window.from);
  const to = hhmmToMinute(p.window.to);
  if (from == null || to == null) throw new Error('intraday.window 的时刻必须是 4 位 HHMM');
  if (from >= to) throw new Error('intraday.window.from 必须早于 to');
  if (from < 9 * 60 + 30) throw new Error('intraday.window.from 不能早于 09:30');
  if (to > 15 * 60) throw new Error('intraday.window.to 不能晚于 15:00');
  for (const key of ['min', 'max']) {
    const v = num(p.gap[key]);
    if (v == null || Math.abs(v) > 20) throw new Error(`intraday.gap.${key} 必须是 -20~20 之间的数字`);
  }
  if (p.gap.min > p.gap.max) throw new Error('intraday.gap.min 不能大于 max');
  if (num(p.gain.min) == null || num(p.gain.max) == null) throw new Error('intraday.gain.min/max 必须是数字');
  if (p.gain.min > p.gain.max) throw new Error('intraday.gain.min 不能大于 max');
  if (num(p.mid.nearPct) == null || p.mid.nearPct < 0 || p.mid.nearPct > 10) throw new Error('intraday.mid.nearPct 必须是 0~10 之间的数字');
  if (!Number.isInteger(p.entry.waitBars) || p.entry.waitBars < 0 || p.entry.waitBars > 24) throw new Error('intraday.entry.waitBars 必须是 0~24 的整数');
  if (p.prevDay.enabled) {
    if (num(p.prevDay.min) == null || num(p.prevDay.max) == null) throw new Error('intraday.prevDay.min/max 必须是数字');
    if (p.prevDay.min > p.prevDay.max) throw new Error('intraday.prevDay.min 不能大于 max');
  }
  for (const key of ['shrinkRatio', 'shrinkBurst', 'rebound', 'upPct', 'dropPct']) {
    const v = num(p.vol[key]);
    if (v == null || v <= 0 || v > 20) throw new Error(`intraday.vol.${key} 必须是 0~20 之间的数字`);
  }
  for (const key of ['pileMin', 'upMin', 'upMax', 'look']) {
    const v = p.vol[key];
    if (!Number.isInteger(v) || v < 1 || v > 120) throw new Error(`intraday.vol.${key} 必须是 1~120 的整数`);
  }
  if (p.vol.upMin > p.vol.upMax) throw new Error('intraday.vol.upMin 不能大于 upMax');
  if (p.shape.enabled) {
    if (!Number.isInteger(p.shape.look) || p.shape.look < 2 || p.shape.look > 60) throw new Error('intraday.shape.look 必须是 2~60 的整数');
    if (!Number.isInteger(p.shape.maxFlips) || p.shape.maxFlips < 0 || p.shape.maxFlips > 30) throw new Error('intraday.shape.maxFlips 必须是 0~30 的整数');
  }
  if (strategy.all != null && !Array.isArray(strategy.all)) throw new Error('strategy.all 必须是数组');
  // 日内策略的结果条数刻意放到很大：日内筛出的常常是几千只（开盘幅度这一刀切得很松），
  // 用户要自己按涨跌幅排序逐只翻看，截断到 100 会把绝大多数结果藏起来、造成「只剩上涨的」错觉。
  const limit = strategy.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 20000) throw new Error('strategy.limit 必须是 1~20000 的整数');
  return true;
}

// 把一只票的分时点算成「决策时能看到的」序列。全部是前缀量，天然不带未来信息。
function buildSeries(tl) {
  const pts = (tl.points || []).filter((p) => num(p.price) > 0);
  if (pts.length < 6) return null;
  const prev = num(tl.prevClose);
  if (!(prev > 0)) return null;
  const price = [];
  const vol = [];
  const minute = [];
  const times = [];
  for (const p of pts) {
    const m = hhmmToMinute(p.t);
    if (m == null) continue;
    price.push(Number(p.price));
    vol.push(Number(p.vol) || 0);
    minute.push(m);
    times.push(p.t);
  }
  if (price.length < 6) return null;
  const mid = [];
  let hi = -Infinity;
  let lo = Infinity;
  for (const x of price) {
    if (x > hi) hi = x;
    if (x < lo) lo = x;
    mid.push((hi + lo) / 2);
  }
  return { prev, price, vol, minute, mid, times };
}

// 均价量基准：开盘到现在（含当前这一分钟）平均每分钟成交多少手。
// 用它当「放量/缩量」的参照，是当日自身的节奏，不掺隔日差异。
function volBase(s, i) {
  let sum = 0;
  for (let k = 0; k <= i; k++) sum += s.vol[k];
  return i >= 0 ? sum / (i + 1) : null;
}

// 形态：最近 look 根里价格方向翻转了几次。翻转太多就是「一涨一跌反复抽搐」，
// 说明多空分歧而不是有人在控盘，这类不买。
function shapeOk(s, i, cfg) {
  const from = Math.max(1, i - cfg.look + 1);
  let flips = 0;
  let lastDir = 0;
  let bars = 0;
  for (let k = from; k <= i; k++) {
    const d = Math.sign(s.price[k] - s.price[k - 1]);
    if (!d) continue;
    bars++;
    if (lastDir && d !== lastDir) flips++;
    lastDir = d;
  }
  return bars >= 2 && flips <= cfg.maxFlips;
}

function avgRange(arr, from, to) {
  if (to < from) return null;
  let sum = 0;
  for (let k = from; k <= to; k++) sum += arr[k];
  return sum / (to - from + 1);
}

// 量能三段，按「堆均量」互相比较，不逐根卡阈值。
// 之所以必须按堆比：逐根卡「这根是不是放量」，最后那段上拉几乎不可能连续每根都达标，
// 结果就是所有票一律卡死在这步（实测全市场 572 个候选里 567 个死在这里）。
// 堆比才贴近用户原话——「成堆的放量」「成堆的明显缩量」，看的是这一段整体小不小。
// 全部只用到 i 及之前的数据，不看触发之后。
function volumeShape(s, i, v, midCfg) {
  const { price, vol, mid } = s;
  const lo = Math.max(1, i - v.look - v.upMax);
  if (i < v.pileMin + v.upMin) return null;
  const dayAvg = volBase(s, i);
  if (!(dayAvg > 0)) return null;

  // ① 最后那段上拉：长度在 [upMin, upMax] 之间，从长到短试，
  // 条件是「现价是这一段里的最高点」且整段涨幅够。越长越能说明是成堆买上去的。
  const bLong = Math.max(1, i - v.upMax + 1);
  const bShort = i - v.upMin + 1;
  for (let b = bLong; b <= bShort; b++) {
    let top = -Infinity;
    for (let k = b; k <= i; k++) if (price[k] > top) top = price[k];
    if (price[i] < top * 0.999) continue;                 // 上拉途中还在往下掉，不算一路买上去
    if ((price[i] / price[b] - 1) * 100 < v.upPct) continue;
    const upLen = i - b + 1;
    const upAvg = avgRange(vol, b, i);
    if (!(upAvg > 0)) continue;

    // ② 紧贴在上拉之前的缩量堆：连续 sLen 根，均量必须小得夸张。
    // 两个方向同时卡：相对前一段放量堆缩到 1/shrinkBurst 以下，相对当日自身节奏也压在 shrinkRatio 以下。
    for (let sLen = v.pileMin; sLen <= v.look; sLen++) {
      const s2 = b - 1;
      const s1 = s2 - sLen + 1;
      if (s1 < 1) break;
      const sAvg = avgRange(vol, s1, s2);
      if (!(sAvg > 0)) continue;
      if (sAvg > dayAvg * v.shrinkRatio) continue;         // 相对当日节奏不算缩量，缩短这段再试
      if (upAvg / sAvg < v.rebound) continue;              // 拉升时的量没比缩量段放大够

      // ③ 缩量堆之前还得有一段成堆放量（先放量）。
      const p2 = s1 - 1;
      if (p2 < 1) break;
      const p1 = Math.max(0, p2 - v.look + 1);
      const pAvg = avgRange(vol, p1, p2);
      if (!(pAvg > 0)) break;
      if (pAvg / sAvg < v.shrinkBurst) continue;

      // ④ 明显缩量之后、上拉之前，价格要接近降中线或停在它上方。
      const midAt = mid[s2];
      const touch = price[s2];
      if (!(midAt > 0)) break;
      if (touch < midAt * (1 - midCfg.nearPct / 100)) break;

      // ⑤ 缩量堆里确实砸下来过，或者从上拉起点算已经明显抬高，两者居其一。
      let peak = -Infinity;
      let trough = Infinity;
      for (let k = s1; k <= s2; k++) {
        if (price[k] > peak) peak = price[k];
        if (price[k] < trough) trough = price[k];
      }
      if (!(peak > 0) || !(trough > 0)) break;
      const drop = ((peak - trough) / peak) * 100;
      const rise = (price[i] / trough - 1) * 100;
      if (drop < v.dropPct && rise < v.dropPct) continue;

      return {
        form: '放量上拉',
        desc: `放量→缩量到1/${(pAvg / sAvg).toFixed(1)}(${sLen}根)→拉升${upLen}根`,
      };
    }
  }
  return null;
}

// 在窗口内找第一次出手点。返回 { i, form } 或 null。
//
// 两段式：先在某一根上认出「放量→明显缩量→放量上拉」的量能特征（锚点），
// 然后允许再往后等最多 waitBars 根，等一个「价格正在往上走、并且站上水面和降中线、
// 当日涨幅在 1%~3%」的根再买。硬卡在特征刚出现的那一根会漏掉大量票：
// 特征成立时涨幅常常还不到 1 个点，等它再走两根往往正好进入买点区间。
function findTrigger(s, params, prevDayPct) {
  const fromMin = hhmmToMinute(params.window.from);
  const toMin = hhmmToMinute(params.window.to);
  const waitBars = Math.max(0, Number(params.entry && params.entry.waitBars) || 0);
  const requireRising = !(params.entry && params.entry.requireRising === false);
  const requireAboveMid = !(params.mid && params.mid.requireAboveMid === false);
  for (let i = 0; i < s.price.length; i++) {
    if (s.minute[i] < fromMin) continue;
    if (s.minute[i] > toMin) break;
    if (params.prevDay.enabled) {
      if (prevDayPct == null) continue;
      if (prevDayPct < params.prevDay.min - 1e-9 || prevDayPct > params.prevDay.max + 1e-9) continue;
    }
    // 「中」要站在水面之上这一条，用户已取消，但保留开关以备回测对比。
    if (params.mid.requireAboveWater && !(s.mid[i] > s.prev)) continue;
    if (params.shape.enabled && !shapeOk(s, i, params.shape)) continue;
    const vs = volumeShape(s, i, params.vol, params.mid);
    if (!vs) continue;

    // 锚点成立，往后再看最多 waitBars 根，挑第一根合格的作为买点。
    for (let j = i; j <= Math.min(i + waitBars, s.price.length - 1); j++) {
      if (s.minute[j] > toMin) break;
      const p = s.price[j];
      if (!(p >= s.prev)) continue;                                    // 出手时必须在水平面之上
      if (requireAboveMid && !(s.mid[j] > 0) ) continue;
      if (requireAboveMid && !(p >= s.mid[j])) continue;                // 出手时必须在降中线之上
      if (requireRising && !(s.price[j] > s.price[j - 1])) continue;    // 出手时价格确实在往上走
      const gain = (p / s.prev - 1) * 100;
      if (gain < params.gain.min - 1e-9 || gain > params.gain.max + 1e-9) continue;
      return { i: j, anchor: i, form: vs.form, volShape: vs.desc, gain };
    }
    // 这个锚点之后 waitBars 内没等到合格买点，继续往后找下一个锚点。
  }
  return null;
}

// 分时拉取并发池：上游是腾讯一个网关，并发太高会被限流，
// 实测 40 路稳定（全市场约 3800 只，二十秒量级）。
const POOL = Number(process.env.INTRADAY_POOL || 40);

async function mapPool(items, limit, fn, onTick) {
  const out = new Array(items.length).fill(null);
  let cursor = 0;
  let done = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      try { out[i] = await fn(items[i], i); } catch { out[i] = null; }
      done++;
      if (onTick) onTick(done, items.length);
    }
  });
  await Promise.all(workers);
  return out;
}

function localDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 分时接口给的日期是 20261118 这种紧凑写法，行情快照给的是 2026-11-18，
// 直接比较字符串会永远不相等，把每一只票都当成过期数据丢掉（曾因此选出一只都没有）。
function sameDay(raw, isoDate) {
  return String(raw || '').replace(/\D/g, '') === String(isoDate || '').replace(/\D/g, '');
}

// 前一日涨跌幅：用户要求「前一天也不能拉太猛、跌太深」。用库里的日线取当天之前最近两根收盘价。
function prevDayMap(codes, asOf, log) {
  const out = new Map();
  if (!codes.length) return out;
  let map;
  try {
    map = loadShortDaily('qfq', 6, asOf || undefined);
  } catch (e) {
    log(`前一日日线读取失败，本条条件暂不生效：${e && e.message}`);
    return out;
  }
  const cut = String(asOf || '');
  for (const code of codes) {
    const rows = map.get(code);
    if (!rows || !rows.length) continue;
    const before = cut ? rows.filter((r) => String(r.date) < cut) : rows;
    if (before.length < 2) continue;
    const a = Number(before[before.length - 2].close);
    const b = Number(before[before.length - 1].close);
    if (!(a > 0) || !(b > 0)) continue;
    out.set(code, (b / a - 1) * 100);
  }
  return out;
}

// 日内选股主流程。
// 返回与日线选股同形状的结果（code/name/close + 若干诊断字段），
// 前端沿用同一套结果列表，点一下就能看到这只票当天的分时图。
export async function runIntradayScreen(strategy, stocks, { now = new Date(), baseDate, log = () => {} } = {}) {
  validateIntradayStrategy(strategy);
  const params = mergeParams(strategy.intraday);
  const t0 = Date.now();
  // 「用哪一天的分时」不能拿服务器日历当依据：凌晨零点之后日历已经翻页，
  // 而行情还是上一交易日的，按当天日期去比会把每一只票都判成过期，结果一只不剩。
  // 所以以「数据自己声明的交易日」为准，用户显式指定基准日时以用户为准。
  const requested = /^\d{4}-\d{2}-\d{2}$/.test(String(baseDate || '')) ? String(baseDate) : null;

  // 第一道漏斗：用一次批量快照把「开盘幅度不合要求」的票剔掉。
  // 这一刀最便宜（一次请求覆盖几十只），能砍掉一大截，避免对几千只票逐个拉分时。
  let quoteMap = new Map();
  let asOf = null;
  try {
    const qs = await fetchQuotes(stocks.map((s) => s.code));
    // 取快照里出现次数最多的日期当数据交易日，避免个别停牌/异常票的旧日期带偏。
    const counter = new Map();
    for (const q of qs) if (q && q.date) counter.set(q.date, (counter.get(q.date) || 0) + 1);
    let bestN = 0;
    let dataDate = null;
    for (const [d, n] of counter) if (n > bestN) { bestN = n; dataDate = d; }
    asOf = requested || dataDate;
    for (const q of qs) if (q && asOf && sameDay(q.date, asOf)) quoteMap.set(q.code, q);
    log(`数据交易日 ${dataDate || '未知'}${requested ? `（按指定基准日 ${requested} 取数）` : ''}，匹配快照 ${quoteMap.size}/${stocks.length}`);
  } catch (e) {
    log(`快照拉取失败，改为直接按分时筛：${e && e.message}`);
  }
  // 快照整批失败时退回按日历日期，至少保证盘中正常可用。
  const today = asOf || localDate(now);
  const universe = [];
  let gapDropped = 0;
  let noQuote = 0;
  for (const s of stocks) {
    const q = quoteMap.get(s.code);
    if (!q || !(q.open > 0) || !(q.prevClose > 0)) { noQuote++; continue; }
    if (q.suspended) continue;
    const gap = (q.open / q.prevClose - 1) * 100;
    if (gap < params.gap.min - 1e-9 || gap > params.gap.max + 1e-9) { gapDropped++; continue; }
    universe.push({ ...s, gap, open: q.open, prevClose: q.prevClose });
  }
  log(`开盘幅度预筛：${stocks.length} → ${universe.length}（幅度不符 ${gapDropped}，无快照 ${noQuote}，${Date.now() - t0}ms）`);

  const prevPcts = params.prevDay.enabled
    ? prevDayMap(universe.map((s) => s.code), asOf, log)
    : new Map();
  if (params.prevDay.enabled) log(`前一日涨跌幅取到 ${prevPcts.size}/${universe.length} 只`);

  const passed = [];
  let fetched = 0;
  const tFetch = Date.now();
  const tick = (done, total) => {
    if (done % 400 === 0 || done === total) {
      const ms = Date.now() - tFetch;
      const pct = total ? Math.round((done / total) * 100) : 100;
      const eta = done > 0 ? Math.round((ms / done) * (total - done)) : 0;
      log(`拉取分时 ${done}/${total}（${pct}%，已用 ${(ms / 1000).toFixed(1)}s，预计还需 ${(eta / 1000).toFixed(1)}s）`);
    }
  };
  await mapPool(universe, POOL, async (stock) => {
    let tl;
    try { tl = await fetchTimeline(stock.code); } catch { return; }
    if (!tl || (tl.date && !sameDay(tl.date, today))) return;   // 节假日/停牌快照，不用
    fetched++;
    const s = buildSeries(tl);
    if (!s) return;
    const prevDayPct = prevPcts.size ? (prevPcts.get(stock.code) ?? null) : null;
    const hit = findTrigger(s, params, prevDayPct);
    if (!hit) return;
    const buy = s.price[hit.i];
    const last = s.price[s.price.length - 1];
    if (params.excludeLimitUp) {
      const pct = (last / s.prev - 1) * 100;
      if (pct >= 9.8) return;
    }
    passed.push({
      code: stock.code,
      name: stock.name,
      close: last,
      open: stock.open,
      prevClose: s.prev,
      gap: (stock.open / stock.prevClose - 1) * 100,
      triggerTime: s.times[hit.i] || '',
      anchorTime: s.times[hit.anchor] || '',
      triggerPrice: buy,
      triggerPct: (buy / s.prev - 1) * 100,
      nowPct: (last / s.prev - 1) * 100,
      form: hit.form,
      volShape: hit.volShape,
      prevDayPct,
      midPct: ((s.mid[hit.i] / s.prev) - 1) * 100,
    });
  }, tick);

  // 排序：先按触发后的表现（现价相对买入价）从高到低，让「选对了的还是选错了的」一眼看见。
  // 注意这里的名次只是服务端的默认顺序；前端列表有自己的涨幅排序，全量返回后用户可以任意重排，
  // 所以上面的截断必须放得足够宽（strategies 里给到 20000），否则用户根本看不到被截掉的那些。
  passed.sort((a, b) => (b.nowPct - b.triggerPct) - (a.nowPct - a.triggerPct));
  const limit = strategy.limit ?? 100;
  const results = passed.slice(0, limit).map((r, i) => ({
    ...r,
    rank: i + 1,
    // 触发后到最新价的浮动（不扣费），仅用于列表排序与说明，不当作收益结论
    afterPct: r.nowPct - r.triggerPct,
  }));
  return {
    mode: 'intraday',
    count: results.length,
    passed: passed.length,
    scanned: stocks.length,
    universeSize: stocks.length,
    baseDate: today,
    adjust: '不复权',
    source: 'intraday',
    elapsedMs: Date.now() - t0,
    universe: { gapPassed: universe.length, timelineFetched: fetched },
    prefilter: { enabled: true, bars: 0, conditionCount: 1, universe: stocks.length, survived: universe.length },
    results,
  };
}

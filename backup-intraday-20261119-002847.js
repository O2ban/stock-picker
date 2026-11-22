// 日内（分时）选股引擎：与日/周线选股完全分开的一条通道。
//
// 为什么单独一套：日线引擎是「每只票取一批日K，在最后一根上求值」，
// 而日内策略要的是「把今天的分时点逐分钟走一遍，找到第一次满足条件的时刻」，
// 数据源、时间轴、求值方式都不同，硬塞进日线条件白名单只会把两边都搞乱。
//
// 硬性口径（与回测脚本 scripts/intraday-backtest/layer_today.py 保持完全一致）：
//   · 决策只能用「那一刻已经出现」的分时点，绝不看触发之后的价格；
//   · 买入价 = 触发那一分钟的成交价；
//   · 「中」= (当日累计最高 + 当日累计最低)/2；
//   · 「分时前高」= 开盘前 5 分钟的最高价（开盘那段没参与拉升，拿它当第一道压力位）；
//   · 缩量 = 触发前若干分钟的均量 / 开盘至今均量；
//   · 震荡验证 = 先拉起过、再砸下来过（砸的过程量能要缩）、此刻已回到水上。
import { fetchQuotes, fetchTimeline } from './quotes.js';

export const INTRADAY_INDICATORS = ['intraday'];

const DEFAULT_PARAMS = {
  window: { from: '0935', to: '1015' },
  gap: { min: -2, max: 1.5 },
  triggers: { backAboveWater: true, breakPrevHigh: true },
  prevHighBars: 5,
  midAboveWater: false,
  shrink: { enabled: false, win: 5, max: 0.8 },
  shake: { enabled: false, upPct: 0.5, dropPct: 0.3, volRatio: 0.85 },
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
  if (!p.triggers.backAboveWater && !p.triggers.breakPrevHigh) throw new Error('至少要启用一种出手点（翻上水面 / 过分时前高）');
  if (!Number.isInteger(p.prevHighBars) || p.prevHighBars < 2 || p.prevHighBars > 60) throw new Error('intraday.prevHighBars 必须是 2~60 的整数');
  if (p.shrink.enabled) {
    if (!Number.isInteger(p.shrink.win) || p.shrink.win < 2 || p.shrink.win > 60) throw new Error('intraday.shrink.win 必须是 2~60 的整数');
    const r = num(p.shrink.max);
    if (r == null || r <= 0 || r > 3) throw new Error('intraday.shrink.max 必须是 0~3 之间的数字');
  }
  if (p.shake.enabled) {
    for (const key of ['upPct', 'dropPct']) {
      const v = num(p.shake[key]);
      if (v == null || v < 0 || v > 10) throw new Error(`intraday.shake.${key} 必须是 0~10 之间的数字`);
    }
    const r = num(p.shake.volRatio);
    if (r == null || r <= 0 || r > 3) throw new Error('intraday.shake.volRatio 必须是 0~3 之间的数字');
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

function shrinkRatio(s, i, win) {
  if (i < win) return null;
  let recent = 0;
  for (let k = i - win + 1; k <= i; k++) recent += s.vol[k];
  recent /= win;
  let hist = 0;
  for (let k = 0; k <= i; k++) hist += s.vol[k];
  hist /= (i + 1);
  if (!(hist > 0)) return null;
  return recent / hist;
}

// 震荡验证：只用 i 及之前的数据。要求出现过一次 ≥upPct 的拉高、之后砸下来过（幅度 ≥dropPct）、
// 砸的那段均量相对拉高那段缩小到 volRatio 以内。
function shakeOk(s, i, params) {
  const { upPct, dropPct, volRatio } = params;
  let peak = -1;
  let peakI = -1;
  for (let k = 0; k <= i; k++) {
    const rise = (s.price[k] / s.prev - 1) * 100;
    if (rise >= upPct && s.price[k] > peak) { peak = s.price[k]; peakI = k; }
  }
  if (peakI < 0) return false;
  let lowI = -1;
  let low = Infinity;
  for (let k = peakI; k <= i; k++) if (s.price[k] < low) { low = s.price[k]; lowI = k; }
  if (lowI <= peakI) return false;
  if (((peak - low) / peak) * 100 < dropPct) return false;
  let upSum = 0, upN = 0;
  for (let k = Math.max(0, peakI - 4); k <= peakI; k++) { upSum += s.vol[k]; upN++; }
  let dnSum = 0, dnN = 0;
  for (let k = peakI + 1; k <= lowI; k++) { dnSum += s.vol[k]; dnN++; }
  if (!upN || !dnN) return false;
  const upAvg = upSum / upN;
  const dnAvg = dnSum / dnN;
  if (!(upAvg > 0)) return false;
  return dnAvg / upAvg <= volRatio;
}

// 在窗口内找第一次出手点。返回 { i, form } 或 null。
function findTrigger(s, params) {
  const fromMin = hhmmToMinute(params.window.from);
  const toMin = hhmmToMinute(params.window.to);
  let firstHigh = -Infinity;
  for (let k = 0; k < Math.min(params.prevHighBars, s.price.length); k++) if (s.price[k] > firstHigh) firstHigh = s.price[k];
  for (let i = 0; i < s.price.length; i++) {
    if (s.minute[i] < fromMin) continue;
    if (s.minute[i] > toMin) break;
    const p = s.price[i];
    if (p < s.prev) continue;                       // 此刻必须在水上
    let backUp = false;                             // 之前跌破过水面
    for (let k = 0; k < i; k++) if (s.price[k] < s.prev) { backUp = true; break; }
    const breakHigh = p > firstHigh;
    const hitBack = params.triggers.backAboveWater && backUp;
    const hitHigh = params.triggers.breakPrevHigh && breakHigh;
    if (!hitBack && !hitHigh) continue;
    if (params.midAboveWater && s.mid[i] < s.prev) continue;
    if (params.shrink.enabled) {
      const r = shrinkRatio(s, i, params.shrink.win);
      if (r == null || r >= params.shrink.max) continue;
    }
    if (params.shake.enabled && !shakeOk(s, i, params.shake)) continue;
    return { i, form: hitBack ? '翻上水面' : '过分时前高' };
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
    const hit = findTrigger(s, params);
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
      triggerPrice: buy,
      triggerPct: (buy / s.prev - 1) * 100,
      nowPct: (last / s.prev - 1) * 100,
      form: hit.form,
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

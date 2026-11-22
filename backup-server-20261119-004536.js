import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataSource, databaseStats, getStock, listStocks, loadDaily, loadDailyTail, loadIndicators, loadRecentDaily, loadShortDaily, loadWeeklyIndicators, precomputeStatus, searchStocks } from './db.js';
import { aggregatePeriod, conditionNeedBars, engineInfo, evaluateConditions, finalizeResults, screenChunk, validateStrategy } from './engine.js';
import { fetchQuotes, fetchTimeline } from './quotes.js';
import { runIntradayScreen, validateIntradayStrategy } from './intraday.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3100);
const publicDir = path.join(__dirname, '..', 'public');

const DEFAULT_SCAN_WINDOW_DAYS = 90;
const WARMUP_DAYS = 60; // 仅用于回退现场计算时的预热期；预计算模式下行已带 MA，不需要预热

// 全市场一次性把 5373 只票的几十万行都映射成对象，堆会瞬间涨到 1.5GB+，
// 触发持续 GC 与内存争抢（实测 loadMs 从 3s 恶化到 20~40s）。
// 改为按块「取数 → 求值 → 只留通过项 → 释放整块」，峰值内存与扫描规模解耦。
const SCREEN_CHUNK_SIZE = Number(process.env.SCREEN_CHUNK_SIZE || 400);

const EXPR_WINDOWS = new Set(['ma', 'sum', 'hhv', 'llv', 'count', 'every']);

// 板块分组：库里 board 只有 bj/sh_main/sz_main/sz_gem/sh_star 五种，
// 「主板」是 sh_main + sz_main 的组合，必须展开成多值过滤，否则 value="main" 会命中 0 只。
const BOARD_GROUPS = { main: ['sh_main', 'sz_main'] };
function normalizeBoard(board) {
  if (!board) return undefined;                       // 空 = 全部
  const key = String(board).trim();
  if (BOARD_GROUPS[key]) return BOARD_GROUPS[key];
  if (key.includes(',')) return key.split(',').map((s) => s.trim()).filter(Boolean);
  return key;
}

// 表达式节点在最后一根 bar 上依赖的最远历史根数（0 = 只看最后一根）：
//   window(n, x) 需要 n-1 根旧数据；ref(n, x) 再往前推 n 根。
// 用于精确算出「缩量低吸」这类公式真正要回看的窗口（≈70 天），避免取数不足导致条件恒不成立。
function exprDepth(node, vars) {
  if (typeof node === 'number' || !node || typeof node !== 'object') return 0;
  if (node.var != null) {
    const def = vars && vars[String(node.var)];
    return def ? exprDepth(def, vars) : 0;
  }
  const inner = Array.isArray(node.args) ? node.args.map((a) => exprDepth(a, vars)) : [];
  const deepest = inner.length ? Math.max(...inner) : 0;
  if (node.op === 'field') return 0;
  if (node.op === 'ref') return Number(node.n || 0) + deepest;
  if (EXPR_WINDOWS.has(node.op)) return Math.max(0, Number(node.n || 0) - 1) + deepest;
  return deepest;
}

// 从策略条件里提取所需的最大指标窗口，用于精确控制取数行数
function calcNeedDays(strategy) {
  let maxLen = 20; // 默认至少 20 天
  const vars = strategy.vars || null;
  const conds = strategy.all || [];
  for (const c of conds) {
    const p = c.params || {};
    for (const key of ['length', 'fast', 'slow', 'within']) {
      const v = Number(p[key]);
      if (Number.isInteger(v) && v > maxLen) maxLen = v;
    }
    if (c.indicator === 'expr' && p.expr) maxLen = Math.max(maxLen, exprDepth(p.expr, vars) + 1);
  }
  for (const node of Object.values(vars || {})) maxLen = Math.max(maxLen, exprDepth(node, vars) + 1);
  return maxLen + 5; // 多取 5 天缓冲
}

// bars(交易日根数) → 需要的自然日跨度：A 股约每周 5 个交易日，乘以 7/5 并留足假期缓冲。
// 表达式条件是在 rows 上现场滚动计算，必须真的取够交易日根数，不能像预计算列那样只看最后一根。
function barsToCalendarDays(bars) {
  return Math.ceil((Number(bars) || 20) * 7 / 5) + 15;
}

// 策略是否用到周线。用不到时跳过周线取数——周线预计算表全市场一次要读 6s 以上，
// 而纯日线策略（如「缩量低吸」15 个条件全是 day）完全不需要。
function strategyUsesWeekly(strategy) {
  const conds = strategy.all || [];
  return conds.some((c) => c.period === 'week');
}

// 策略里的表达式条件是否用到了 OHLC（预计算指标表只有 close/vol，需另从 daily_kline 补）
function strategyNeedsOhlc(strategy) {
  const scan = (node) => {
    if (!node || typeof node !== 'object') return false;
    if (node.op === 'field') return node.name !== 'close' && node.name !== 'vol';
    return Array.isArray(node.args) && node.args.some(scan);
  };
  const vars = strategy.vars || null;
  const conds = strategy.all || [];
  for (const c of conds) if (c.indicator === 'expr' && scan(c.params?.expr)) return true;
  return Object.values(vars || {}).some(scan);
}

// 策略是否需要库里的预计算 MA/VR 列。
// 仅当存在非 expr 指标（close_above_ma / volume_ratio 等）时才需要——那些指标直接读 ma*/vr*；
// 纯 expr 策略在引擎里用 close/vol 现场滚动计算，读预计算列纯属浪费内存与 I/O。
function strategyNeedsMaVr(strategy) {
  const conds = strategy.all || [];
  return conds.some((c) => c.indicator !== 'expr');
}

const strategies = new Map();
// 选股结果缓存：仅用于 POST 后按 id 回查，必须有上限 + 过期，避免全市场结果无限堆积导致内存泄漏
const runs = new Map();
const MAX_RUNS = 50; // 最多保留的选股结果条数
const RUN_TTL_MS = 30 * 60 * 1000; // 单条结果最长保留 30 分钟

function rememberRun(id, run) {
  runs.set(id, run);
  const now = Date.now();
  for (const [key, value] of runs) {
    const ts = Date.parse(value.startedAt);
    const age = Number.isNaN(ts) ? Infinity : now - ts; // startedAt 缺失/非法时按最旧处理，避免 NaN 使 TTL 驱逐静默失效
    if (runs.size > MAX_RUNS || age > RUN_TTL_MS) runs.delete(key);
    else break; // Map 按插入顺序迭代：队首最旧，一旦既不超龄也不超量，其后均无需处理
  }
}

function shiftDate(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

// 某日期所在自然周的 ISO 周一，用于周线口径对齐（库内 week_start 即周一）
function weekStartOf(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const dow = d.getUTCDay() || 7; // 周日=7
  d.setUTCDate(d.getUTCDate() - dow + 1);
  return d.toISOString().slice(0, 10);
}

// 校验选股基准日：格式、真实日期、不得晚于数据最新日
function validateBaseDate(raw, fallbackRaw) {
  const value = raw || fallbackRaw;
  if (!value) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return '选股基准日需为 YYYY-MM-DD 格式';
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) return `选股基准日不是有效日期：${value}`;
  const latest = latestDate();
  if (value > latest) return `选股基准日不能晚于数据最新日 ${latest}`;
  return null;
}

function groupByCode(rows) {
  const map = new Map();
  for (const row of rows || []) {
    if (!map.has(row.code)) map.set(row.code, []);
    map.get(row.code).push(row);
  }
  return map;
}

function average(nums) {
  const list = nums.filter(Number.isFinite);
  if (!list.length) return null;
  return list.reduce((a, b) => a + b, 0) / list.length;
}

// 库内行 → 选股引擎行结构。maVr 为 true 时带上库中已算好的 MA/VR 列供引擎直接取用；
// 纯表达式策略（indicator 全为 expr）在引擎里用 close/vol 现场滚动计算，根本不读预计算列，
// 此时省略这 8 个字段可显著减小每行对象体积（全市场 40 万行时对 GC 压力影响很大）。
// 用工厂而非给 mapDailyRow 加第二个参数：避免 rows.map(mapDailyRow) 把数组下标当成 maVr 传入。
function makeDailyMapper(maVr = true) {
  return (row) => {
    if (!row) return null;
    const out = {
      date: row.date,
      o: row.open != null ? Number(row.open) : null,
      h: row.high != null ? Number(row.high) : null,
      l: row.low != null ? Number(row.low) : null,
      c: Number(row.close),
      vol: Number(row.vol || 0),
      amount: row.amount != null ? Number(row.amount) : 0,
    };
    if (maVr) {
      out.ma5 = row.ma5; out.ma10 = row.ma10; out.ma20 = row.ma20; out.ma60 = row.ma60;
      out.vr5 = row.vr5; out.vr10 = row.vr10; out.vr20 = row.vr20; out.vr60 = row.vr60;
    }
    // 实时补出的当日 bar 只有盘中部分成交量，聚合周线/月线时必须能认出并排除它，
    // 否则周线成交量被低估、收盘价变成盘中价。
    if (row.rt) out.rt = true;
    return out;
  };
}

function mapWeeklyRow(row) {
  if (!row) return null;
  return {
    date: row.date ?? row.week_start,
    o: null, h: null, l: null,
    c: Number(row.close),
    vol: Number(row.vol || 0),
    amount: 0,
    ma5: row.ma5, ma10: row.ma10, ma20: row.ma20, ma60: row.ma60,
    vr5: row.vr5, vr10: row.vr10, vr20: row.vr20, vr60: row.vr60,
  };
}

// 当天还没入库：拿实时价补最后一根 K 线，只重算这一天的 MA 与量比。
// 历史天一律沿用库里已算好的值，不做任何重算。
// dataLatest 是库内数据的最后一天：只有「系统今天」紧跟在它后面（1~4 个自然日，
// 覆盖周末与短假）且今天是工作日时，才认为今天这一根缺失、可以用实时价补上。
// 数据陈旧（相差很远）时绝不补，否则会凭空插出一根远期 K 线，污染时间线。
// 本地日期（服务器为 CST）。不能用 toISOString：UTC 08:00 之前会算成前一天，
// 早盘选股会把实时价插到错误日期上。
function localDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 当日已开盘时间占全天交易时间的比例（0~1），用于把"盘中累计成交量"折算成可比口径。
// 交易时段 9:30-11:30 + 13:00-15:00 共 240 分钟。收盘后返回 1，
// 此时量比 = 全天量 / 过去N日均量，与历史行口径完全一致，不会造成前后不一致。
function intradayFraction(now) {
  const hm = now.getHours() * 60 + now.getMinutes();
  const OPEN_AM = 9 * 60 + 30, CLOSE_AM = 11 * 60 + 30;
  const OPEN_PM = 13 * 60, CLOSE_PM = 15 * 60;
  if (hm < OPEN_AM) return 0;
  if (hm >= CLOSE_PM) return 1;
  let mins;
  if (hm <= CLOSE_AM) mins = hm - OPEN_AM;
  else if (hm < OPEN_PM) mins = 120;            // 午休：上午已走完
  else mins = 120 + (hm - OPEN_PM);
  // 开盘第一分钟内不折算到 0，否则量比会除爆；按 1 分钟起步。
  return Math.max(mins, 1) / 240;
}

// 今天这根日K能否用实时价补上：能补就返回今天的日期串，否则 null。
// 抽成独立函数是为了让「补不补」和「对外报的基准日」用同一个判断，
// 避免出现「结果是今天的价、基准日却还是上一个交易日」的矛盾口径。
function realtimeDateFor(dataLatest, now = new Date()) {
  const today = localDate(now);
  const gapDays = Math.round((Date.parse(today) - Date.parse(dataLatest)) / 86400000);
  if (!(gapDays >= 1 && gapDays <= 4)) return null;
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
  if (dow === 0 || dow === 6) return null;
  if (!(intradayFraction(now) > 0)) return null;   // 尚未开盘，没有可用当日量
  return today;
}

// now 由调用方传入：同一次选股请求里预筛和完整扫描必须用同一个时间点，
// 否则跨越收盘时点时两阶段算出的「全天等效量」折算比例不同，同一只票的
// 量比会出现差异（虽然幅度极小，但这是两阶段口径不一致的唯一缝隙）。
function applyRealtimeToDaily(dailyMap, enabled, dataLatest, quoteMap, now = new Date()) {
  if (!enabled) return dailyMap;
  const today = realtimeDateFor(dataLatest, now);
  if (!today) return dailyMap;
  if (!quoteMap || !quoteMap.size) return dailyMap;
  const frac = intradayFraction(now);
  for (const [code, rows] of dailyMap) {
    const last = rows.at(-1);
    if (!last) continue;
    if (last.date >= today) continue;
    const q = quoteMap.get(code);
    const price = Number((q && q.price) || 0);
    if (!(price > 0)) continue;
    // 行情快照必须属于今天、且当日确有成交，否则不补：
    // 停牌股（quotes.js 用昨收顶替 price、vol=0）和节假日（上游返回上一交易日快照、
    // 而 realtimeDateFor 只看自然日判断不出来）都会凭空插出一根「今天」的假 K 线，
    // 早盘 frac 很小时量比会被成倍放大，时间线也被塞进不存在的交易日。
    // 这两类情况统一跳过，自然降级为只用库内数据。
    if ((q && q.date) !== today) continue;
    // 成交量取当日累积量（盘中即为「至今」的量），这样量比反映的是
    // 「今日至今 vs 过去N日均量」，与行情软件口径一致。
    // 不再退回上一交易日成交量：拿昨天的全天量冒充今天的量，量比会凭空放大。
    const vol = Number((q && q.vol) || 0);
    if (!(vol > 0)) continue;
    // 盘中成交量只有全天的一小部分，直接拿去和「过去N日全天均量」比，量比类条件
    // （vol/ma5vol、vol > ma5vol）恒定偏低，策略在上午几乎不可能命中。
    // 这里把当日累计量按已开盘时间占比折算成「全天等效量」，让 rt bar 与历史行同为全天口径；
    // 收盘后 frac=1，折算形同不做，前后口径一致。原始累计量保留在 volRaw 便于排查。
    const volEff = frac > 0 && frac < 1 ? vol / frac : vol;
    // 开/高/低必须一并补上：引擎把缺失字段读成 NaN，映射层又会把 null 变成 0，
    // 于是「收阳（close >= open）」这类条件会因为 0 而恒真、「回调幅度」会因为
    // llv(low) 取到 0 而恒假，盘中选股结果被系统性污染。
    // 行情里的 open/high/low 是原始价，前复权序列最新一日本就等于原始价，量纲一致。
    const pick = (v) => (Number(v) > 0 ? Number(v) : price);
    const open = pick(q && q.open);
    const high = Math.max(pick(q && q.high), price);
    const low = Math.min(pick(q && q.low), price);
    const amount = Number((q && q.amount) || 0);
    const merged = [...rows, {
      date: today, open, high, low, close: price, vol: volEff, volRaw: vol, amount,
      rt: true, // 标记为实时补出的当日 bar：只参与日线判断，拼周线时剔除
      ma5: null, ma10: null, ma20: null, ma60: null,
      vr5: null, vr10: null, vr20: null, vr60: null,
    }];
    for (const n of [5, 10, 20, 60]) {
      const win = merged.slice(-n);
      const avg = average(win.map((r) => r.close));
      merged.at(-1)[`ma${n}`] = avg;
    }
    for (const n of [5, 10, 20, 60]) {
      const win = merged.slice(0, -1).slice(-n);
      const avg = average(win.map((r) => Number(r.volRaw != null ? r.volRaw : r.vol)));
      // vol 已是全天等效量，分母用历史全天均量，量比 = 等效量 / 均量。
      merged.at(-1)[`vr${n}`] = avg > 0 ? Number(merged.at(-1).vol) / avg : null;
    }
    dailyMap.set(code, merged);
  }
  return dailyMap;
}

function latestDate() {
  const s = precomputeStatus();
  return s.lastCompletedDate || new Date().toISOString().slice(0, 10);
}

function buildLoader(strategy, stocks, options = {}) {
  const scanWindowDays = Number(options.scanWindowDays || strategy.scanWindowDays || DEFAULT_SCAN_WINDOW_DAYS);
  const dataLatest = latestDate();
  const baseDate = options.baseDate || strategy.baseDate || dataLatest;
  // 只有基准日就是数据最新日时，才用实时价补最后一根日 K。
  // 指定历史基准日时不能补：否则今天的实时价会被插到历史日期之上，时间线错乱。
  const realtime = options.realtime !== false && baseDate >= dataLatest;

  // 预计算模式：每行已带 MA/VR，只需取策略所需天数（最大 length + 5 天缓冲），
  // 不再硬加 60 天预热。扫描窗口仍然保证用户看的天数够。
  const needDays = barsToCalendarDays(calcNeedDays(strategy));
  const from = shiftDate(baseDate, needDays);
  const to = baseDate;

  const codes = stocks.map((s) => s.code);
  // 纯 expr 策略不需要预计算 MA/VR 列：少 SELECT 8 列、少造 8 个字段
  const needsMaVr = strategyNeedsMaVr(strategy);
  const needsOhlc = strategyNeedsOhlc(strategy);
  // 两查合一：纯 expr 且需要 OHLC 的策略（如「缩量低吸」），daily_indicators(close,vol) 和
  // daily_kline(OHLC) 取的是同一批行——预计算入库时停牌日已一并写进 daily_kline，两表
  // (code,date) 一一对应，close_qfq/vol 与 daily_indicators.close/vol 逐行一致。
  // 这时直接单查 daily_kline 一次拿到 close/vol/OHLC，省掉第二次全表扫描，
  // 也省掉几十万行的「code\0date」字符串键合并。冷缓存下少读一遍页，收益最明显。
  // 含非 expr 指标（要读预计算 ma*/vr* 列）的策略仍走原两次查询路径。
  const singlePass = !needsMaVr && needsOhlc;
  const dailyMap = groupByCode(
    singlePass
      ? loadRecentDaily(codes, { from, to, adjust: 'qfq' })
      : loadIndicators(codes, { from, to, maVr: needsMaVr })
  );

  const needsWeekly = strategyUsesWeekly(strategy);

  // 周线只需取策略所需周数（最大 length + 2 周缓冲）
  const needWeeks = calcNeedDays(strategy);
  const weeklyFrom = shiftDate(baseDate, needWeeks * 7 + 14);
  const weeklyMap = needsWeekly ? groupByCode(loadWeeklyIndicators(codes, { from: weeklyFrom, to, maVr: needsMaVr })) : new Map();

  // 防前视偏差：一根周线覆盖「周一~周日」，只有整周都落在基准日之内才算已完成。
  // 基准日落在周中时（如周三），库里那根含本周未来交易日的完整周线必须剔除，
  // 否则 MA/VR 窗口会把基准日之后的收盘价与成交量算进来，等于提前知道未来走势。
  for (const [code, rows] of weeklyMap) {
    weeklyMap.set(code, rows.filter((r) => shiftDate(r.date, -6) <= baseDate));
  }

  applyRealtimeToDaily(dailyMap, realtime, dataLatest, options.quoteMap, options.now || new Date());

  // 当前周拼合：用日线拼一根"当前周周线"追加到历史周线后面
  // 周一=1...周日=7，当前周的第一天 ISO 周一
  // 注意：实时补出的当日 bar（rt=true）不参与周线拼合。它只有盘中部分成交量，
  // 混进来会让「本周量比」被系统性低估（上午的量只有全天的三分之一），
  // 也会让周线收盘价变成盘中价，与「周线不叠加实时价」的口径冲突。
  for (const [code, allDailyRows] of needsWeekly ? dailyMap : []) {
    if (!allDailyRows.length) continue;
    const dailyRows = allDailyRows.filter((r) => !r.rt);
    if (!dailyRows.length) continue;
    const lastDate = dailyRows.at(-1).date;
    const d = new Date(lastDate + 'T00:00:00Z');
    const dayOfWeek = d.getUTCDay() || 7; // 周日=7
    const monday = new Date(d);
    monday.setUTCDate(d.getUTCDate() - dayOfWeek + 1);
    const mondayStr = monday.toISOString().slice(0, 10);
    const weekRows = dailyRows.filter((r) => r.date >= mondayStr);
    if (weekRows.length < 1) continue;
    const histWeekly = weeklyMap.get(code) || [];
    const lastHistWeek = histWeekly.at(-1);
    const lastHistDate = lastHistWeek && (lastHistWeek.date || lastHistWeek.week_start);
    if (lastHistDate && lastHistDate >= mondayStr) continue; // 已有当前周
    // 拼当前周周线
    const volSum = weekRows.reduce((s, r) => s + Number(r.vol || 0), 0);
    const lastClose = weekRows.at(-1).close;
    const curWeek = {
      code, week_start: mondayStr,
      close: lastClose,
      c: lastClose, // 与 mapWeeklyRow 输出形状对齐，供下面的 MA 窗口直接取用
      vol: volSum,
      ma5: null, ma10: null, ma20: null, ma60: null,
      vr5: null, vr10: null, vr20: null, vr60: null,
    };
    // 用历史周线算 MA 和 VR
    const allWeeks = [...histWeekly.map(mapWeeklyRow).filter(Boolean), curWeek];
    for (const n of [5, 10, 20, 60]) {
      const win = allWeeks.slice(-n);
      const closes = win.map((w) => w.c).filter(Number.isFinite);
      if (closes.length === n) curWeek[`ma${n}`] = average(closes);
      const vols = allWeeks.slice(0, -1).slice(-n).map((w) => w.vol).filter(Number.isFinite);
      if (vols.length === n) {
        const avgVol = average(vols);
        if (avgVol > 0) curWeek[`vr${n}`] = volSum / avgVol;
      }
    }
    histWeekly.push(curWeek);
    weeklyMap.set(code, histWeekly);
  }

  // 提前 map，避免 loader 每次调用都重复映射（子代理排查发现的 181ms 浪费）
  const dailyMapped = new Map();
  const weeklyMapped = new Map();
  const mapDaily = makeDailyMapper(needsMaVr);
  for (const [code, rows] of dailyMap) {
    dailyMapped.set(code, rows.map(mapDaily).filter(Boolean));
  }
  for (const [code, rows] of weeklyMap) {
    weeklyMapped.set(code, rows.map(mapWeeklyRow).filter(Boolean));
  }

  // 表达式条件需要开/高/低：预计算指标表只有 close/vol，这里按日期把 OHLC 合并进日线行。
  // 只回看 dailyMapped 已有的日期范围（from~to），不影响其它条件的取数口径。
  // singlePass 时 dailyMap 本来就是 daily_kline 单查出来的，行里已带 open/high/low，无需再合并。
  if (needsOhlc && !singlePass) {
    const ohlcRows = loadRecentDaily(codes, { from, to, adjust: 'qfq' });
    const byCodeDate = new Map();
    for (const row of ohlcRows) byCodeDate.set(`${row.code}\u0000${row.date}`, row);
    for (const [code, rows] of dailyMapped) {
      for (const row of rows) {
        const src = byCodeDate.get(`${code}\u0000${row.date}`);
        if (!src) continue;
        row.o = src.open != null ? Number(src.open) : null;
        row.h = src.high != null ? Number(src.high) : null;
        row.l = src.low != null ? Number(src.low) : null;
      }
    }
  }

  // 表达式函数全部按「数据不足即返回 NaN、条件不成立」处理：滚动窗口超出已有历史时，
  // 该节点在最后几根 bar 上恒为空。取数窗口（calcNeedDays）已按公式最深回看加缓冲，
  // 正常应足够；若仍不足，条件会静默不通过，属于预期安全行为。

  return function loader(code, adjust) {
    // 后复权/未复权没有预计算表，走 daily_kline 现查，并且只取到基准日（to）为止——
    // 否则会取到全量历史（含基准日之后），历史基准日下产生前视偏差。
    if (adjust && adjust !== 'qfq') {
      // 现查回来的原始行字段是 open/close，必须经 mapDailyRow 转成引擎要求的 o/c 形状。
      // 日线窗口取到周线所需范围（weeklyFrom 比 from 更早），保证周线条件有足够历史；
      // 该口径没有周线预计算表，weekly 传 null 由引擎按自然周从日线聚合，不能把日线当周线用。
      const daily = loadDaily(code, adjust, { from: weeklyFrom, to }).map(mapDaily).filter(Boolean);
      return { daily, weekly: null };
    }
    return {
      daily: dailyMapped.get(code) || [],
      weekly: weeklyMapped.get(code) || [],
    };
  };
}

// 两种策略走不同校验：日内策略的结构（intraday 参数块）与日线条件白名单无关，
// 不能拿日线的校验器去卡它，否则载入/保存一律报「不支持的指标」。
function validateAnyStrategy(strategy) {
  if (strategy && strategy.intraday) return validateIntradayStrategy(strategy);
  return validateStrategy(strategy);
}

strategies.set('starter', {
  version: 1,
  name: '日周趋势与量能',
  universe: { excludeSt: true },
  all: [
    { period: 'week', indicator: 'close_above_ma', params: { length: 20 } },
    { period: 'day', indicator: 'volume_ratio', params: { length: 20, min: 1.2 } },
  ],
  limit: 100,
});

// 内置策略库：把 strategies/*.json（如「缩量低吸」）在启动时载入，供 UI「策略库」下拉直接选用。
// 载入失败只跳过该条，不影响服务启动。
const strategyDir = path.join(__dirname, '..', 'strategies');
try {
  for (const file of fs.readdirSync(strategyDir)) {
    if (!file.endsWith('.json')) continue;
    const id = file.replace(/\.json$/, '');
    try {
      const strategy = JSON.parse(fs.readFileSync(path.join(strategyDir, file), 'utf8'));
      validateAnyStrategy(strategy);
      strategies.set(id, strategy);
    } catch (e) {
      console.error(`跳过策略文件 ${file}：${e.message}`);
    }
  }
} catch { /* strategies 目录不存在时忽略 */ }

// 策略库列表（含内置与已载入的文件策略），UI 下拉用。
function strategyLibrary() {
  return [...strategies.entries()].map(([id, s]) => ({ id, name: s.name || id, conditions: (s.all || []).length }));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); } catch (e) { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

function send(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

function staticFile(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  if (rel.includes('..')) { send(res, 400, { error: '非法路径' }); return; }
  const file = path.join(publicDir, rel);
  if (!file.startsWith(publicDir)) { send(res, 400, { error: '非法路径' }); return; }
  fs.readFile(file, (err, data) => {
    if (err) { send(res, 404, { error: 'not found' }); return; }
    const ext = path.extname(file);
    const type = ext === '.html' ? 'text/html; charset=utf-8'
      : ext === '.js' ? 'text/javascript; charset=utf-8'
      : ext === '.css' ? 'text/css; charset=utf-8'
      : ext === '.webmanifest' ? 'application/manifest+json; charset=utf-8'
      : ext === '.svg' ? 'image/svg+xml'
      : ext === '.png' ? 'image/png'
      : ext === '.ico' ? 'image/x-icon'
      : ext === '.json' ? 'application/json; charset=utf-8' : 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache, must-revalidate' });
    res.end(data);
  });
}

// 构建单只股票的 K 线载荷（不含指标，指标一律前端算）。
// 单只 /api/kline 与批量预取 /api/klines 共用，避免两处口径漂移。
function avgVol5(code) {
  try {
    const rows = loadDailyTail(code, 'qfq', 6);
    if (!rows || rows.length < 2) return null;
    // 最后一行可能就是当日（盘后已落库），剔除掉再取最多 5 天
    // 日期格式契约：daily_kline.date 统一为 'YYYY-MM-DD'，与下面 toISOString 的切片同格式。
    const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    const hist = rows.filter(r => r.date !== today).slice(-5);
    const use = hist.length ? hist : rows.slice(-5);
    let sum = 0, n = 0;
    for (const r of use) { const v = Number(r.vol); if (v > 0) { sum += v; n++; } }
    if (!n) return null;
    // 通达信量比的分母是「最近 5 个交易日平均成交量」，停牌日按 0 计入，
    // 所以分母用交易日数 use.length（不足 5 日的新股用实际天数），
    // 而不是有成交的天数 n —— 否则停牌多的票分母被抬高、量比系统性偏低。
    return sum / use.length;
  } catch { return null; }
}

// ---------- 5 分钟 K 线（复盘页专用）----------
// 数据由 scripts/intraday-backtest/build_min5_index.py 预生成到 data/min5/：
//   <code>.idx     每行「日期,字节偏移,条数」，一天一行，用来按日快速定位
//   <code>.ndjson  每行「YYYYMMDDHHMM,开,高,低,收,成交量,成交额」，一根 5 分钟 K 线一行
// 只读最近 N 根：全程 7 万多根一次全给前端会拖死浏览器，取数窗口由 bars 控制。
const MIN5_DIR = path.join(__dirname, '..', 'data', 'min5');

function min5Paths(code) {
  const bare = String(code || '').replace(/[^0-9a-zA-Z]/g, '');
  if (!/^(sh|sz|bj)\d{6}$/i.test(bare)) return null;
  const base = path.join(MIN5_DIR, bare.toLowerCase());
  if (!fs.existsSync(`${base}.idx`) || !fs.existsSync(`${base}.ndjson`)) return null;
  return { idx: `${base}.idx`, data: `${base}.ndjson` };
}

function loadMin5Tail(code, bars) {
  const p = min5Paths(code);
  if (!p) return null;
  // 索引很小（一千多行），整体读进内存按天倒推，避免每次扫 7MB 数据文件。
  const idxLines = fs.readFileSync(p.idx, 'utf8').split('\n').filter(Boolean);
  if (!idxLines.length) return null;
  // 每根 5 分钟 K 线一行，一天 48 根；按 bars 折算需要回看多少个交易日，多给一天兜底。
  const needDays = Math.max(1, Math.ceil(bars / 48) + 1);
  const startAt = Math.max(0, idxLines.length - needDays);
  const parts = idxLines[startAt].split(',');
  const byteOffset = Number(parts[1]) || 0;
  const buf = fs.readFileSync(p.data);
  const text = buf.slice(byteOffset).toString('utf8');
  const rows = text.split('\n').filter(Boolean);
  const picked = rows.slice(-bars);
  const klines = [];
  for (const line of picked) {
    const f = line.split(',');
    if (f.length < 7) continue;
    const ts = f[0];
    // 时间戳 YYYYMMDDHHMM → 统一成日线的日期格式 + 时分，x 轴标签直接可用。
    const date = `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`;
    klines.push({
      date,
      time: ts.slice(8, 12),
      o: Number(f[1]), h: Number(f[2]), l: Number(f[3]), c: Number(f[4]),
      vol: Number(f[5]) || 0, amount: Number(f[6]) || 0,
    });
  }
  return klines;
}

function buildMin5Payload(code, bars) {
  const stock = getStock(code);
  if (!stock) return null;
  const klines = loadMin5Tail(code, bars);
  if (!klines || !klines.length) return null;
  return {
    code,
    name: stock.name,
    board: stock.board,
    adjust: 'qfq',
    period: 'min5',
    bars: klines.length,
    count: klines.length,
    first: klines[0].date,
    last: klines[klines.length - 1].date,
    klines,
  };
}

function buildKlinePayload(code, period, adjust, bars) {
  const stock = getStock(code);
  if (!stock) return null;
  let klines;
  if (period === 'day') {
    klines = loadDailyTail(code, adjust, bars);
  } else {
    // 周线：多取日线做聚合，再截取尾部 bars 根，避免“取到最早一段”。
    const daily = loadDailyTail(code, adjust, Math.min(bars * 5 + 30, 5000)).map(r => ({
      date: r.date,
      o: r.open, h: r.high, l: r.low, c: r.close,
      vol: Number(r.vol) || 0,
      amount: Number(r.amount) || 0,
    }));
    klines = aggregatePeriod(daily, 'week').slice(-bars);
  }
  const norm = klines.map(r => ({
    date: r.date,
    o: Number(r.o ?? r.open),
    h: Number(r.h ?? r.high),
    l: Number(r.l ?? r.low),
    c: Number(r.c ?? r.close),
    vol: Number(r.vol) || 0,
    amount: Number(r.amount) || 0,
  }));
  return {
    code,
    name: stock.name,
    board: stock.board,
    adjust,
    period,
    bars,
    count: norm.length,
    first: norm[0]?.date || null,
    last: norm[norm.length - 1]?.date || null,
    klines: norm,
  };
}

// 归一化 period/adjust/bars 参数，保证单只与批量口径一致。
function klineParams(periodRaw, adjustRaw, barsRaw) {  const period = periodRaw === 'week' ? 'week' : 'day';
  const adjust = ['raw', 'qfq', 'hfq'].includes(adjustRaw) ? adjustRaw : 'qfq';
  // 日线上限放到 3000 根：复盘页要看「上市至今全程」约 1660 个交易日，
  // 原 1200 根覆盖不了；默认取数仍是 250 根，不影响看盘页。
  const maxBars = period === 'week' ? 1200 : 3000;
  const defBars = period === 'week' ? 120 : 250;
  const bars = Math.max(20, Math.min(Number(barsRaw) || defBars, maxBars));
  return { period, adjust, bars };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const route = `${req.method} ${url.pathname}`;

  try {
    if (route === 'GET /api/health') {
      return send(res, 200, { ok: true, dataSource: dataSource(), engine: engineInfo, now: new Date().toISOString() });
    }
    if (route === 'GET /api/stats') {
      return send(res, 200, databaseStats());
    }
    if (route === 'GET /api/precompute-status') {
      return send(res, 200, precomputeStatus());
    }
    // 自选股搜索：按代码或名称模糊匹配，用于添加自选。
    if (route === 'GET /api/stocks') {
      const q = (url.searchParams.get('q') || '').trim();
      if (!q) return send(res, 200, { items: [] });
      const limit = Number(url.searchParams.get('limit') || 20);
      return send(res, 200, { items: searchStocks(q, limit) });
    }
    // 实时行情：代理腾讯 qt.gtimg.cn（项目共用 kline 的行情能力）。
    // 客户端每分钟轮询一次；服务端带 5s 缓存并合并同一批并发请求。
    if (route === 'GET /api/quotes') {
      const raw = (url.searchParams.get('codes') || '').trim();
      const codes = raw.split(',').map(s => s.trim()).filter(Boolean).slice(0, 100);
      if (!codes.length) return send(res, 200, { items: [], ts: Date.now() });
      const items = await fetchQuotes(codes);
      return send(res, 200, { items, ts: Date.now() });
    }
    // 当日分时曲线：代理腾讯 proxy.finance.qq.com（web.ifzq 域名有 WAF，不可用）。
    // 返回 242 个交易时段内的分钟点，服务端带 2s 缓存合并同一只的并发请求。
    if (route === 'GET /api/timeline') {
      const code = (url.searchParams.get('code') || '').trim();
      if (!code) return send(res, 400, { error: '缺少 code 参数' });
      try {
        const data = await fetchTimeline(code);
        // 量比基准：最近 5 个交易日（不含当日）的日均成交量（手）。
        // 分时量比 = 当前累计量 /（5 日均量 × 已开盘时间占比），基准必须在服务端算，
        // 否则前端为了一个副图还得再拉一次日线。
        data.vol5 = avgVol5(code);
        return send(res, 200, data);
      } catch (e) {
        return send(res, 502, { error: e.message || '分时获取失败' });
      }
    }
    // 5 分钟 K 线：复盘页看盘中买卖点用，只读预生成的本地数据，不走外部行情源。
    if (route === 'GET /api/min5') {
      const code = (url.searchParams.get('code') || '').trim();
      if (!code) return send(res, 400, { error: '缺少 code 参数' });
      const barsRaw = Number(url.searchParams.get('bars')) || 480;
      const bars = Math.max(48, Math.min(barsRaw, 20000));
      const payload = buildMin5Payload(code, bars);
      if (!payload) return send(res, 404, { error: `未找到 ${code} 的 5 分钟数据` });
      return send(res, 200, payload);
    }
    // 看盘数据：只出 OHLCV，MA/MACD 等指标一律前端计算。
    // 日线与周线走同一接口，period 切换；取“最近 N 根”而非最早 N 根。
    if (route === 'GET /api/kline') {
      const code = (url.searchParams.get('code') || '').trim();
      if (!code) return send(res, 400, { error: '缺少 code 参数' });
      const { period, adjust, bars } = klineParams(
        url.searchParams.get('period'),
        url.searchParams.get('adjust'),
        url.searchParams.get('bars'),
      );
      const payload = buildKlinePayload(code, period, adjust, bars);
      if (!payload) return send(res, 404, { error: `未找到股票 ${code}` });
      return send(res, 200, payload);
    }
    // 批量预取：选股结果出来后一次性把命中股票的 K 线取回前端缓存，
    // 避免逐只点开各发一次请求。用 code 白名单 + 分块查询，命中 (code,date) 主键。
    if (route === 'POST /api/klines') {
      const body = await readBody(req);
      const codes = Array.isArray(body.codes) ? body.codes.filter(c => typeof c === 'string' && c.trim()) : [];
      if (!codes.length) return send(res, 400, { error: '缺少 codes 参数' });
      if (codes.length > 300) return send(res, 400, { error: '一次最多预取 300 只' });
      const { period, adjust, bars } = klineParams(body.period, body.adjust,
        body.bars || (body.period === 'week' ? 200 : 320));
      const items = [];
      for (const code of codes) {
        const payload = buildKlinePayload(code.trim(), period, adjust, bars);
        if (payload) { items.push(payload); }
      }
      return send(res, 200, { period, adjust, bars, count: items.length, items });
    }
    if (route === 'GET /api/strategies') {
      return send(res, 200, strategyLibrary());
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/strategies/')) {
      const id = decodeURIComponent(url.pathname.split('/').pop());
      const strategy = strategies.get(id);
      if (!strategy) return send(res, 404, { error: `未找到策略 ${id}` });
      return send(res, 200, { id, strategy });
    }
    if (route === 'GET /api/demo-strategy') {
      return send(res, 200, strategies.get('starter'));
    }
    if (route === 'POST /api/strategies/validate') {
      const body = await readBody(req);
      try {
        validateAnyStrategy(body.strategy || body);
        return send(res, 200, { ok: true });
      } catch (e) {
        return send(res, 200, { ok: false, error: e.message });
      }
    }
    if (route === 'POST /api/strategies') {
      const body = await readBody(req);
      try { validateAnyStrategy(body.strategy || body); } catch (e) { return send(res, 400, { error: e.message }); }
      const id = `strategy-${Date.now()}`;
      strategies.set(id, body.strategy || body);
      return send(res, 200, { id, strategy: body.strategy || body });
    }
    // 就地更新已有策略（改名/改条件）：不新增下拉项，同步内存 Map 并写回 strategies/<id>.json，
    // 保证下次重启仍能载入同一份定义。仅允许改已存在的 id，避免误造新策略。
    if (req.method === 'PUT' && url.pathname.startsWith('/api/strategies/')) {
      const id = decodeURIComponent(url.pathname.split('/').pop());
      if (!strategies.has(id)) return send(res, 404, { error: `未找到策略 ${id}` });
      const body = await readBody(req);
      const strategy = body.strategy || body;
      try { validateAnyStrategy(strategy); } catch (e) { return send(res, 400, { error: e.message }); }
      try {
        fs.writeFileSync(path.join(strategyDir, `${id}.json`), `${JSON.stringify(strategy, null, 2)}\n`, 'utf8');
      } catch (e) {
        return send(res, 500, { error: `策略文件写入失败：${e.message}` });
      }
      strategies.set(id, strategy);
      return send(res, 200, { id, strategy });
    }
    if (route === 'POST /api/screenings') {
      const body = await readBody(req);
      // 支持 body.strategy 或 body.strategyId（后者从已载入的策略库查找）。
      // 之前只处理 body.strategy，客户端传 strategyId 会被静默回退到 starter，
      // 导致「按策略 ID 跑选股」实际用的是内置策略，行为不可预期。
      // 策略来源优先级：显式传入的策略内容 > 策略 ID 查库 > 内置 starter。
      // 指定了 strategyId 却查不到时必须报错，不能静默落到 starter：
      // 那会让用户看到的策略名与实际执行的策略完全不是一回事，且结果无从察觉。
      let strategy = body.strategy || null;
      if (!strategy && body.strategyId) {
        strategy = strategies.get(body.strategyId) || null;
        if (!strategy) return send(res, 404, { error: `未找到策略 ${body.strategyId}` });
      }
      strategy = strategy || strategies.get('starter');
      // 回查实际生效的策略 id，供运行记录打标签：请求里传的 strategyId 可能与
      // 真正被执行的那份策略内容（body.strategy）不是同一个，标签不能照抄请求参数。
      let resolvedStrategyId = body.strategyId || null;
      if (!body.strategy) {
        for (const [k, v] of strategies) if (v === strategy) { resolvedStrategyId = k; break; }
      }
      // 直接传策略内容（未走策略库）时用其自带名字打标签，避免历史记录里
      // 把一份自定义策略显示成 starter。
      if (!resolvedStrategyId) {
        const named = typeof body.strategy?.name === 'string' ? body.strategy.name.trim() : '';
        resolvedStrategyId = named || 'starter';
      }
      try { validateAnyStrategy(strategy); } catch (e) { return send(res, 400, { error: e.message }); }
      // 日内策略是另一条通道：数据源是当天分时、按分钟逐点判定，
      // 与日线选股（历史日K + 表达式求值）没有任何共用环节，直接在这里分流出去。
      // 结果结构刻意保持与日线一致（code/name/close + results），
      // 前端结果列表、点开看分时图那套逻辑就能原样复用。
      if (strategy.intraday) {
        const tI = Date.now();
        const stocksI = listStocks({ board: normalizeBoard(body.board), excludeST: strategy.universe?.excludeSt !== false });
        const runI = await runIntradayScreen(strategy, stocksI, {
          now: new Date(),
          // 用户指定了基准日就按它来；没指定则用行情自己声明的交易日。
          baseDate: body.baseDate || strategy.baseDate || undefined,
          log: (m) => console.log(`[intraday] ${m}`),
        });
        const idI = `run-${Date.now()}`;
        rememberRun(idI, {
          id: idI, strategyId: resolvedStrategyId, adjust: runI.adjust, source: runI.source,
          startedAt: new Date().toISOString(), loadMs: 0, elapsedMs: Date.now() - tI,
          baseDate: runI.baseDate, prefilter: runI.prefilter,
          mode: 'intraday', count: runI.count, passed: runI.passed,
          scanned: runI.scanned, universeSize: runI.universeSize,
          results: runI.results, universe: runI.universe,
        });
        return send(res, 200, runs.get(idI));
      }
      const baseDateErr = validateBaseDate(body.baseDate, strategy.baseDate);
      if (baseDateErr) return send(res, 400, { error: baseDateErr });
      const adjust = body.adjust || 'qfq';
      const stocks = listStocks({ board: normalizeBoard(body.board), excludeST: strategy.universe?.excludeSt !== false });
      // 整个请求只取一次时间点：预筛与各批完整扫描都用它折算盘中成交量占比，
      // 保证同一只票在两阶段看到的「当前时刻」完全相同。
      const reqNow = new Date();
      // 当日选股要用今天的实时价补齐最后一根日K，否则盘中选出来的仍是上一交易日收盘的答案。
      // 只有「未指定历史基准日」时才拉：指定基准日是回看历史，混入今日价会让时间线错乱。
      // 全市场 5373 只约 3.3s（90 批并发，5s 内复用缓存），是这次请求固定的一笔开销。
      const t0 = Date.now();
      let quoteMap = null;
      if (!body.baseDate && !strategy.baseDate && body.realtime !== false) {
        try {
          // 只拉参与扫描的股票；行情失败不影响选股，退化为只用库内数据。
          const items = await fetchQuotes(stocks.map((s) => s.code));
          // 只保留「快照日期就是今天」的行情。节假日上游会返回上一交易日的陈旧快照，
          // 用它补 K 会凭空插出一根假日 K 线、并把基准日报成今天；
          // 停牌股的快照日期同样停留在停牌前，一并被剔除。
          const todayStr = localDate(reqNow);
          const fresh = items.filter((it) => it && it.date === todayStr);
          quoteMap = fresh.length ? new Map(fresh.map((it) => [it.code, it])) : null;
        } catch (e) {
          console.error('[screenings] 实时行情拉取失败，改用库内数据:', e && e.message);
          quoteMap = null;
        }
      }
      // ----- 预筛阶段（两阶段漏斗）-----
      // 策略里有很多条件只需要看最近几天（今日收阳、涨幅区间、站上 MA5）；先用
      // 最近 PREFILTER_BARS 根短窗数据把这些"浅"日线条件跑一遍，明确不通过的
      // 直接剔除，剩下的存活票再走完整扫描。数据不足（NaN/行数不够）一律放行，
      // 保证预筛只能淘汰"确定不合格"的票，不会误杀。
      const PREFILTER_BARS = Number(process.env.PREFILTER_BARS || 10);
      const prefilterEnabled = process.env.PREFILTER !== '0' && body.prefilter !== false;
      const vars_ = strategy.vars || null;
      const prefilterIndices = [];
      if (prefilterEnabled) {
        for (let i = 0; i < strategy.all.length; i++) {
          const c = strategy.all[i];
          if (c.period !== 'day') continue;
          const need = conditionNeedBars(c, vars_);
          if (need <= PREFILTER_BARS) prefilterIndices.push(i);
        }
      }
      // 未启用预筛时不带 universe/survived：否则 {enabled:false, survived:5373}
      // 会被读成「筛过了、全放行」。
      let prefilterStats = { enabled: false, bars: 0, conditionCount: 0 };
      let scanStocks = stocks;
      if (prefilterIndices.length === 0) {
        // 无可预筛条件时自动跳过，保持与未改造路径完全一致的行为
      } else {
        // 短窗根数 = max(浅条件的 need) + 实时补根 1，避免误判"够长"。
        const shortBars = Math.max(...prefilterIndices.map(i => conditionNeedBars(strategy.all[i], vars_))) + 1;
        prefilterStats.bars = shortBars;
        prefilterStats.conditionCount = prefilterIndices.length;
        prefilterStats.enabled = true;
        prefilterStats.universe = stocks.length;

        const tPre = Date.now();
        // 基准日必须与 buildLoader 的取值完全一致，否则两阶段的「最后一根 bar」
        // 不是同一天：指定历史基准日回看时，短窗会用最近的今天去判「今天有没有放量/收阳」，
        // 与那天的真实情况无关，会把当天其实合格的票误杀。
        // （曾复现：看 10-16 应出 18 只，预筛后只剩 2 只。）
        const dataLatest = latestDate();
        const scanBaseDate = body.baseDate || strategy.baseDate || dataLatest;
        // 只有基准日就是数据最新日时才补实时，与 buildLoader 的 realtime 判断同源。
        const prefilterRealtime = body.realtime !== false && scanBaseDate >= dataLatest;

        // 一次加载全市场短窗日线；字段形状与 loadRecentDaily 一致（open/high/low/close 已复权）
        const shortMap = loadShortDaily(adjust, shortBars, scanBaseDate);
        // 关键：补实时。用与 buildLoader 里完全相同的判断、quoteMap 与时间点，
        // 短窗最后一根 bar 与完整扫描口径一致，才不会把"今天才合格"的票误杀。
        applyRealtimeToDaily(shortMap, prefilterRealtime, dataLatest, quoteMap, reqNow);

        // 求值 & 剔除
        const survivors = [];
        const mapDaily = makeDailyMapper(false);
        for (const s of stocks) {
          const rows = shortMap.get(s.code) || [];
          const bundle = { daily: rows.map(mapDaily).filter(Boolean), weekly: [] };
          const r = evaluateConditions(strategy, bundle, prefilterIndices);
          if (r.failed) continue;
          // r.failed=false（含 r.unknown=true 的数据不足情况）：一律放行到第二阶段
          survivors.push(s);
        }
        scanStocks = survivors;
        prefilterStats.survived = survivors.length;
        console.log(`[screenings] 预筛 ${stocks.length} → ${survivors.length}（${prefilterStats.conditionCount} 条件，${shortBars} 根，${Date.now() - tPre}ms）`);
      }

      // ----- 完整扫描：分批对存活票跑全部条件 -----
      // 每块「取数 → 求值 → 只留通过项」，块内数据用完即弃。
      // 全市场一次性映射会瞬间堆起几十万个行对象（实测 RSS 冲到 1.6GB），
      // 触发持续 GC 使耗时从 3s 恶化到 20~40s；分批后峰值内存与扫描规模解耦。
      // 语义与单批一致：finalizeResults 对全部通过项做全局排序后按 limit 截断。
      let loadMs = 0;
      const allOutput = [];
      for (let i = 0; i < scanStocks.length; i += SCREEN_CHUNK_SIZE) {
        const chunk = scanStocks.slice(i, i + SCREEN_CHUNK_SIZE);
        const tLoad = Date.now();
        const loader = buildLoader(strategy, chunk, { ...body, adjust, quoteMap, now: reqNow });
        loadMs += Date.now() - tLoad;
        for (const item of screenChunk(strategy, chunk, loader, { adjust })) allOutput.push(item);
      }
      const result = finalizeResults(strategy, allOutput, scanStocks.length);
      const elapsedMs = Date.now() - t0;
      // 基准日要和实际参与计算的数据一致：用了今日实时价补齐，就报今天。
      // 否则会出现「结果里是今天的收盘价、基准日却写着上一个交易日」的矛盾展示。
      // 反之显式传 realtime:false 时并没有补今日价，基准日必须退回库内最新日，
      // 不能报今天——那会让人以为结果基于今日行情。
      const dataLatest = latestDate();
      const realtimeEnabled = body.realtime !== false;
      const baseDate = body.baseDate || strategy.baseDate
        || (realtimeEnabled && quoteMap && quoteMap.size ? realtimeDateFor(dataLatest) : null)
        || dataLatest;
      const id = `run-${Date.now()}`;
      rememberRun(id, { id, strategyId: resolvedStrategyId, adjust, source: dataSource().mode, startedAt: new Date().toISOString(), universeSize: stocks.length, loadMs, elapsedMs, baseDate, prefilter: prefilterStats, ...result });
      return send(res, 200, runs.get(id));
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/screenings/')) {
      const id = url.pathname.split('/').pop();
      const run = runs.get(id);
      if (!run) return send(res, 404, { error: 'not found' });
      return send(res, 200, run);
    }
    if (route.startsWith('GET /api/')) return send(res, 404, { error: 'not found' });
    if (req.method === 'GET') return staticFile(req, res);
    return send(res, 400, { error: 'unsupported' });
  } catch (err) {
    console.error('[screenings] 处理请求失败:', err && err.stack ? err.stack : err);
    return send(res, 400, { error: err.message });
  }
});

// PID 文件：由服务自己在启动后写入真实进程号，退出时清掉。
// 之前这份文件是手工留下的旧编号，长期与实际进程对不上，守护脚本也没有维护它，
// 一旦有人按文件去 kill 会打错进程。改为进程自维护后，文件内容永远等于当前实例。
const PID_FILE = path.join(__dirname, '..', 'stock-picker.pid');
function writePidFile() {
  try {
    fs.writeFileSync(PID_FILE, String(process.pid));
  } catch (err) {
    console.error('[pid] 写入 PID 文件失败:', err.message);
  }
}
function removePidFile() {
  try {
    // 只有文件里记的确实是本进程时才删，避免误删后来者的记录
    if (fs.readFileSync(PID_FILE, 'utf8').trim() === String(process.pid)) fs.unlinkSync(PID_FILE);
  } catch { /* 文件不存在或不可读，忽略 */ }
}
writePidFile();
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    removePidFile();
    process.exit(0);
  });
}
process.on('exit', removePidFile);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`stock-picker listening on http://0.0.0.0:${PORT}`);
});

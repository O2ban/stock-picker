const PERIODS = new Set(['day', 'week', 'month']);
const INDICATORS = new Set(['close_above_ma', 'close_below_ma', 'volume_ratio', 'momentum', 'ma_cross_up', 'trend_strength', 'expr']);
const MAX_LENGTH = 250;
const MA_COLUMNS = new Set([5, 10, 20, 60]);

// 表达式条件（indicator: 'expr'）的函数白名单与字段白名单。
// 用 JSON 表达式树而非文本解析：可递归校验、无 eval、无任意脚本。
const EXPR_FIELDS = new Set(['open', 'high', 'low', 'close', 'vol']);
const EXPR_BINARY = new Set(['+', '-', '*', '/', '>', '>=', '<', '<=', '=', '<>', 'and', 'or']);
const EXPR_WINDOW = new Set(['ma', 'sum', 'hhv', 'llv', 'count', 'every']);
// 顶层表达式必须是布尔运算（比较或逻辑），保证条件语义是"成立/不成立"
const EXPR_BOOL = new Set(['>', '>=', '<', '<=', '=', '<>', 'and', 'or']);
const FIELD_KEYS = { open: 'o', high: 'h', low: 'l', close: 'c', vol: 'vol' };
// field 序列的二级缓存挂在 cache 上用的符号键：Symbol 与字符串键天然不冲突，
// 不会与 strategy.vars 里用户自定义的变量名撞键。
const FIELD_CACHE_KEY = Symbol('fieldCache');
const MAX_REF = 250;

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

export function aggregatePeriod(rows, period = 'day') {
  if (period === 'day') return rows;
  if (period === 'month') throw new Error('month period is reserved for a later release');
  // 实时补出的当日 bar（rt）只代表盘中已走出的一小段：成交量是部分量、收盘价是盘中价。
  // 聚合周线/月线时必须剔除，否则会算出一根量能严重偏低、价格失真的假周线。
  // 该 flag 只由 server 补实时价时打上，历史行走库内数据永远没有它。
  const completed = rows.some((row) => row.rt) ? rows.filter((row) => !row.rt) : rows;
  const buckets = new Map();
  for (const row of completed) {
    const date = new Date(`${row.date}T00:00:00Z`);
    const day = date.getUTCDay() || 7;
    const monday = new Date(date);
    monday.setUTCDate(date.getUTCDate() - day + 1);
    const key = monday.toISOString().slice(0, 10);
    const bucket = buckets.get(key) || { date: row.date, o: row.o, h: row.h, l: row.l, c: row.c, vol: 0, amount: 0 };
    bucket.date = row.date;
    bucket.h = Math.max(bucket.h, row.h);
    bucket.l = Math.min(bucket.l, row.l);
    bucket.c = row.c;
    bucket.vol += Number(row.vol || 0);
    bucket.amount += Number(row.amount || 0);
    buckets.set(key, bucket);
  }
  return [...buckets.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function values(rows, key) { return rows.map((row) => Number(row[key])).filter(Number.isFinite); }
function average(list) { return list.length ? list.reduce((sum, value) => sum + value, 0) / list.length : null; }
function sma(rows, key, length) { return average(values(rows.slice(-length), key)); }

// 优先读预计算均线列 ma5/ma10/ma20/ma60，列缺失或非预计算档位时回退到现场计算
function rowMa(row, length) {
  const pre = MA_COLUMNS.has(length) ? row?.[`ma${length}`] : undefined;
  return finite(pre) ? pre : null;
}
function lastMa(rows, length) {
  const current = rowMa(rows.at(-1), length);
  if (current != null) return current;
  return sma(rows, 'c', length);
}

// ---------------------------------------------------------------------------
// 表达式条件：把通达信风格公式（HHV/LLV/REF/COUNT/EVERY/MA）表达成 JSON 树。
// 每个节点求值为一条与 rows 等长的数列；最终取最后一根 bar 上的布尔值。
// 不做文本解析、不用 eval，函数与字段都在白名单内，可递归校验。
// ---------------------------------------------------------------------------
function seriesOf(rows, key) {
  return rows.map((row) => { const value = Number(row[key]); return Number.isFinite(value) ? value : NaN; });
}
function windowSeries(input, n, reduce) {
  const out = new Array(input.length).fill(NaN);
  for (let i = 0; i < input.length; i += 1) {
    if (i + 1 < n) continue;
    out[i] = reduce(input.slice(i + 1 - n, i + 1));
  }
  return out;
}
function shiftSeries(input, n) {
  const out = new Array(input.length).fill(NaN);
  for (let i = n; i < input.length; i += 1) out[i] = input[i - n];
  return out;
}
function truthy(value) { return Number.isFinite(value) && value !== 0; }

function evalNode(node, rows, vars, cache) {
  if (typeof node === 'number') return new Array(rows.length).fill(node);
  if (!node || typeof node !== 'object' || Array.isArray(node)) throw new Error('表达式节点必须是数字或对象');
  if (node.var != null) {
    const name = String(node.var);
    if (!vars || !(name in vars)) throw new Error(`未定义的变量: ${name}`);
    if (!cache.has(name)) cache.set(name, evalNode(vars[name], rows, vars, cache));
    return cache.get(name);
  }
  const op = node.op;
  if (typeof op !== 'string') throw new Error('表达式节点缺少 op');
  // 字段序列在同一周期内恒定，缓存后避免每个引用都重扫一遍 rows
  if (op === 'field') {
    // 同一周期内字段序列恒定，缓存后避免每个引用都重扫一遍 rows。
    // 用独立的子 Map（挂在 Symbol 键下），而不是往 vars 缓存里塞字符串键，避免撞名。
    let fields = cache.get(FIELD_CACHE_KEY);
    if (!fields) { fields = new Map(); cache.set(FIELD_CACHE_KEY, fields); }
    if (!fields.has(node.name)) fields.set(node.name, seriesOf(rows, FIELD_KEYS[node.name]));
    return fields.get(node.name);
  }
  if (op === 'ref') return shiftSeries(evalNode(node.args[0], rows, vars, cache), node.n);
  if (op === 'ma') return windowSeries(evalNode(node.args[0], rows, vars, cache), node.n, (w) => w.reduce((s, v) => s + v, 0) / w.length);
  if (op === 'sum') return windowSeries(evalNode(node.args[0], rows, vars, cache), node.n, (w) => w.reduce((s, v) => s + v, 0));
  if (op === 'hhv') return windowSeries(evalNode(node.args[0], rows, vars, cache), node.n, (w) => Math.max(...w));
  if (op === 'llv') return windowSeries(evalNode(node.args[0], rows, vars, cache), node.n, (w) => Math.min(...w));
  if (op === 'count') return windowSeries(evalNode(node.args[0], rows, vars, cache), node.n, (w) => w.filter(truthy).length);
  if (op === 'every') return windowSeries(evalNode(node.args[0], rows, vars, cache), node.n, (w) => (w.every(truthy) ? 1 : 0));
  if (EXPR_BINARY.has(op)) {
    const a = evalNode(node.args[0], rows, vars, cache);
    const b = evalNode(node.args[1], rows, vars, cache);
    return a.map((x, i) => {
      const y = b[i];
      switch (op) {
        case '+': return x + y;
        case '-': return x - y;
        case '*': return x * y;
        case '/': return y === 0 ? NaN : x / y;
        case '>': return x > y ? 1 : 0;
        case '>=': return x >= y ? 1 : 0;
        case '<': return x < y ? 1 : 0;
        case '<=': return x <= y ? 1 : 0;
        case '=': return x === y ? 1 : 0;
        case '<>': return x !== y ? 1 : 0;
        case 'and': return truthy(x) && truthy(y) ? 1 : 0;
        case 'or': return truthy(x) || truthy(y) ? 1 : 0;
        default: throw new Error(`不支持的运算符: ${op}`);
      }
    });
  }
  throw new Error(`不支持的表达式运算: ${op}`);
}

// 计算表达式对「有效历史长度」的需求：只需要最后 lookback+1 根 bar 就能得出最后一根的值。
// 纯尾部求值，语义与全序列求值完全一致（窗口/引用都只看前 n 根），但计算量随窗口长度而不是 bar 总数增长。
function lookback(node, vars, seen) {
  if (typeof node === 'number') return 0;
  if (!node || typeof node !== 'object') return 0;
  if (node.var != null) {
    const name = String(node.var);
    if (!vars || !(name in vars) || seen.has(name)) return 0;
    seen.add(name);
    const value = lookback(vars[name], vars, seen);
    seen.delete(name);
    return value;
  }
  if (node.op === 'field') return 1;
  const args = Array.isArray(node.args) ? node.args : [];
  const inner = args.map((arg) => lookback(arg, vars, seen));
  if (node.op === 'ref') return Number(node.n) + (inner[0] || 0);
  if (EXPR_WINDOW.has(node.op)) return Number(node.n) + (inner[0] || 0);
  return inner.length ? Math.max(...inner) : 0;
}

// 计算「最后一根 bar」上判定该条件成立/不成立所需的 bar 根数（含当前 bar 本身）。
// 用于预筛阶段筛选「回溯深度浅」的日线条件：只要 need <= PREFILTER_BARS，
// 就能用最近 PREFILTER_BARS 根短窗数据算出与完整扫描一致的结果。
// 铁律：宁大勿小。误判"够长"会误杀；误判"不够"只是放行到第二阶段，安全。
// 说明：非 expr 指标统一 +2，主要覆盖 momentum / trend_strength 的 rows.at(-1-length)
// 与 ma_cross_up 的"前一根 MA"两种需要额外历史的情况。expr 指标的 lookback 已经
// 精确统计窗口/引用深度，只需要 +1 计入当前 bar 本身。
export function conditionNeedBars(condition, vars) {
  const p = condition?.params || {};
  if (condition?.indicator === 'expr') {
    return lookback(p.expr, vars, new Set()) + 1;
  }
  return Math.max(Number(p.length || 20), Number(p.fast || 5), Number(p.slow || 20)) + 2;
}

// 可复用的条件求值入口：只求值 indices 里指定的条件子集，并区分「不通过」与「数据不足」。
// 设计要点：
//   - unknown = 数据不足、无法判定，绝不参与 failed 判定（预筛阶段一律放行）；
//   - 只要有一个明确 pass=false，立即短路返回 failed=true；
//   - withDetails=false 时不构造 details 数组，减少预筛阶段 GC 压力。
// bundle 形如 { daily, weekly }，与 screenChunk 内部加载结果同形。
//
// 关于"短窗 MA fallback 是否与完整扫描口径一致"的分析：
//   - 短窗数据来自 daily_kline（无 ma*/vr* 列），loadShortDaily + makeDailyMapper(false)
//     产出的 rows 上 ma5/ma10/... 都是 undefined，rowMa 会返回 null 触发 fallback。
//   - close_above_ma / close_below_ma：fallback sma(rows, 'c', N) 取最后 N 根 close；
//     当 N ≤ PREFILTER_BARS - 2 时，短窗里的最后 N 根 close 就是完整数据里的最后 N 根
//     close（含最后一根 rt），两者计算结果完全一致。
//   - volume_ratio：fallback 用 rows.slice(0,-1).slice(-N) 取历史 N 根 vol；
//     只要 N ≤ PREFILTER_BARS - 2，短窗历史 vol 就等于完整数据历史 vol，结果一致。
//     注意：短窗里没有 vrN 列，所以不会走"读 vrN 预计算列"的分支。
//   - momentum / trend_strength：使用 rows.at(-1-length)，短窗与完整数据的第 (-1-N) 根
//     close 是同一根，直接一致。
//   - ma_cross_up：使用 rows.at(-2) 与 rows.slice(0,-1) 的 MA；上面已保证需要 ≥ slow+2
//     根，短窗足够时结果与完整数据一致；不足时 rows.length < need 会把条件标 unknown。
//
// 综上，只要走的是"完整 bar 数满足 need 时的正常路径"，短窗与完整扫描对最后一根的
// 判定结果数学上等价，不存在误杀风险。need 判定的保守性（+2）是唯一的护栏。
export function evaluateConditions(strategy, bundle, indices, { withDetails = false } = {}) {
  const vars = strategy.vars || null;
  const daily = Array.isArray(bundle?.daily) ? bundle.daily : [];
  const weekly = Array.isArray(bundle?.weekly) ? bundle.weekly : [];
  const periodRows = new Map([['day', daily], ['week', weekly]]);
  const caches = new Map();
  const details = withDetails ? [] : null;
  let failed = false;
  let unknown = false;
  for (const idx of indices || []) {
    const condition = strategy.all[idx];
    if (!condition) continue;
    const rows = periodRows.get(condition.period) || [];
    const need = conditionNeedBars(condition, vars);
    if (rows.length < need) {
      unknown = true;
      if (withDetails) details.push({ ...condition, result: { pass: false, value: null, reason: `数据不足（${rows.length}/${need}）` }, unknown: true });
      continue;
    }
    if (!caches.has(condition.period)) caches.set(condition.period, new Map());
    const result = indicatorResult(rows, condition.indicator, condition.params, vars, caches.get(condition.period), rows.length);
    if (withDetails) details.push({ ...condition, result });
    if (!result.pass) {
      failed = true;
      break;
    }
  }
  return { failed, unknown, details };
}

// cache 由调用方按「单票 + 单周期」提供并跨条件复用：同一条 vars 变量被多个条件引用时只求值一次。
// 未提供时退化为一次性 Map，语义与旧实现完全一致。
function exprResult(rows, node, vars, label, cache, fullBars) {
  if (!rows.length) return { pass: false, value: null, reason: '数据不足' };
  const line = evalNode(node, rows, vars, cache || new Map());
  const last = line.at(-1);
  return {
    pass: truthy(last),
    value: { result: Number.isFinite(last) ? last : null, bars: fullBars != null ? fullBars : rows.length },
    reason: `${label || '表达式'}：${truthy(last) ? '成立' : '不成立'}`,
  };
}

function validateExpr(node, path, vars) {
  if (typeof node === 'number') { if (!Number.isFinite(node)) throw new Error(`${path} 的数值必须有限`); return; }
  if (!node || typeof node !== 'object' || Array.isArray(node)) throw new Error(`${path} 必须是数字或对象`);
  if (node.var != null) {
    if (!vars || !(String(node.var) in vars)) throw new Error(`${path}.var 引用了未定义的变量`);
    return;
  }
  const op = node.op;
  if (op === 'field') { if (!EXPR_FIELDS.has(node.name)) throw new Error(`${path}.name 字段不在白名单`); return; }
  if (op === 'ref') {
    if (!Number.isInteger(node.n) || node.n < 1 || node.n > MAX_REF) throw new Error(`${path}.n 必须是 1 到 ${MAX_REF} 的整数`);
    if (!Array.isArray(node.args) || node.args.length !== 1) throw new Error(`${path} 需要且仅需要 1 个参数`);
    validateExpr(node.args[0], `${path}.args[0]`, vars);
    return;
  }
  if (EXPR_WINDOW.has(op)) {
    if (!Number.isInteger(node.n) || node.n < 2 || node.n > MAX_LENGTH) throw new Error(`${path}.n 必须是 2 到 ${MAX_LENGTH} 的整数`);
    if (!Array.isArray(node.args) || node.args.length !== 1) throw new Error(`${path} 需要且仅需要 1 个参数`);
    validateExpr(node.args[0], `${path}.args[0]`, vars);
    return;
  }
  if (EXPR_BINARY.has(op)) {
    if (!Array.isArray(node.args) || node.args.length !== 2) throw new Error(`${path} 需要且仅需要 2 个参数`);
    validateExpr(node.args[0], `${path}.args[0]`, vars);
    validateExpr(node.args[1], `${path}.args[1]`, vars);
    return;
  }
  throw new Error(`${path} 使用了不支持的运算: ${op}`);
}

function indicatorResult(rows, indicator, params = {}, vars = null, cache = null, fullBars = null) {
  if (indicator === 'expr') return exprResult(rows, params.expr, vars, params.label, cache, fullBars);
  const length = Number(params.length || 20);
  const current = rows.at(-1);
  if (!current || !Number.isInteger(length) || length < 2) return { pass: false, value: null, reason: '数据不足或参数无效' };
  const close = Number(current.c);
  const ma = lastMa(rows, length);
  if (!finite(close) || !finite(ma ?? NaN)) return { pass: false, value: null, reason: `至少需要 ${length} 个周期` };
  if (indicator === 'close_above_ma') return { pass: close > ma, value: { close, ma }, reason: `收盘 ${close.toFixed(2)} / MA${length} ${ma.toFixed(2)}` };
  if (indicator === 'close_below_ma') return { pass: close < ma, value: { close, ma }, reason: `收盘 ${close.toFixed(2)} / MA${length} ${ma.toFixed(2)}` };
  if (indicator === 'volume_ratio') {
    const min = Number(params.min ?? 1);
    // 历史天直接用库中已算好的量比（当天量 / 前 N 日均量，不含当天，对齐通达信口径）
    const pre = current[`vr${length}`];
    if (finite(pre)) {
      // volumeMa 必须展示 ratio 的真实分母（今日那一根已按开盘时间折算、且不含当日），
      // 否则界面出现「94351 / 34442」却报量比 5.82 的自相矛盾数字，用户会以为算错了。
      const effMa = pre > 0 ? Number(current.vol || 0) / pre : null;
      return { pass: pre >= min, value: { volume: current.vol, volumeMa: finite(effMa ?? NaN) ? effMa : null, ratio: pre }, reason: `量比 ${pre.toFixed(2)}，要求不低于 ${min}` };
    }
    // 回退分支的分母同样不含当日：库内 vrN 预计算就是「当日量 / 前 N 日均量」口径，
    // 若这里用含当日的 sma，两种情况会算出两个量比，测试与线上对不上。
    const vma = sma(rows.slice(0, -1), 'vol', length);
    if (!finite(vma ?? NaN) || vma === 0) return { pass: false, value: null, reason: '成交量数据不足' };
    const ratio = Number(current.vol || 0) / vma;
    return { pass: ratio >= min, value: { volume: current.vol, volumeMa: vma, ratio }, reason: `量比 ${ratio.toFixed(2)}，要求不低于 ${min}` };
  }
  if (indicator === 'momentum') {
    const previous = rows.at(-1 - length);
    const momentum = previous?.c ? close / previous.c - 1 : null;
    const min = Number(params.min ?? 0);
    return { pass: finite(momentum) && momentum >= min, value: { momentum }, reason: `${length}周期涨幅 ${((momentum || 0) * 100).toFixed(2)}%` };
  }
  if (indicator === 'ma_cross_up') {
    const fast = Number(params.fast || 5);
    const slow = Number(params.slow || 20);
    const previous = rows.at(-2);
    const fastNow = lastMa(rows, fast); const slowNow = lastMa(rows, slow);
    const fastPrev = previous ? lastMa(rows.slice(0, -1), fast) : null;
    const slowPrev = previous ? lastMa(rows.slice(0, -1), slow) : null;
    const pass = finite(fastPrev ?? NaN) && finite(slowPrev ?? NaN) && fastPrev <= slowPrev && fastNow > slowNow;
    return { pass, value: { fast: fastNow, slow: slowNow }, reason: `MA${fast} ${fastNow.toFixed(2)} / MA${slow} ${slowNow.toFixed(2)}` };
  }
  if (indicator === 'trend_strength') {
    const momentum = rows.at(-1 - length)?.c ? close / rows.at(-1 - length).c - 1 : null;
    const position = ma ? close / ma - 1 : 0;
    return { pass: finite(momentum) && momentum > 0 && position > 0, value: { momentum, position }, reason: `趋势 ${(((momentum || 0) + position) * 100).toFixed(2)}%` };
  }
  throw new Error(`unsupported indicator: ${indicator}`);
}

function validateCondition(condition, path, vars) {
  if (!condition || typeof condition !== 'object') throw new Error(`${path} must be an object`);
  if (!PERIODS.has(condition.period)) throw new Error(`${path}.period must be day, week or month`);
  if (!INDICATORS.has(condition.indicator)) throw new Error(`${path}.indicator is not supported`);
  if (condition.period === 'month') throw new Error('month period is reserved for a later release');
  const params = condition.params || {};
  if (condition.indicator === 'expr') {
    if (!params.expr || typeof params.expr !== 'object') throw new Error(`${path}.params.expr is required for expr indicator`);
    validateExpr(params.expr, `${path}.params.expr`, vars);
    return;
  }
  for (const [key, value] of Object.entries(params)) if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${path}.params.${key} must be a number`);
  for (const key of ['length', 'fast', 'slow', 'within']) if (params[key] != null && (!Number.isInteger(params[key]) || params[key] < 2 || params[key] > MAX_LENGTH)) throw new Error(`${path}.params.${key} must be an integer from 2 to ${MAX_LENGTH}`);
}

export function validateStrategy(strategy) {
  if (!strategy || strategy.version !== 1) throw new Error('strategy.version must be 1');
  const vars = strategy.vars || null;
  if (vars) {
    if (typeof vars !== 'object' || Array.isArray(vars)) throw new Error('strategy.vars must be an object');
    for (const [name, node] of Object.entries(vars)) validateExpr(node, `strategy.vars.${name}`, vars);
  }
  if (!Array.isArray(strategy.all) || strategy.all.length === 0 || strategy.all.length > 20) throw new Error('strategy.all must contain 1 to 20 conditions');
  strategy.all.forEach((condition, index) => validateCondition(condition, `strategy.all[${index}]`, vars));
  const limit = strategy.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('strategy.limit must be an integer from 1 to 500');
  return true;
}

// 选股主流程：每只票只取一次数（日线 + 周线一起带回），所有条件复用同一份数据，
// 彻底消除原先每条件重复取数、重复聚合周线、重复算指标的开销。
// loadRows(code, adjust) 返回 { daily, weekly }；weekly 缺失时才回退到由 daily 聚合。
//
// screenChunk 只负责「扫一批、返回通过项」，不做排序截断，供上层分批调用后统一收口；
// runScreen 是它的单批封装（保留原有对外契约）。
export function screenChunk(strategy, stocks, loadRows, { adjust = 'qfq' } = {}) {
  validateStrategy(strategy);
  const output = [];
  // 只统计策略真正用到的周期：纯日线策略不会触发周线聚合，
  // 避免对每只票白跑一次 aggregatePeriod(daily, 'week')。
  const periodsUsed = new Set(strategy.all.map((condition) => condition.period));
  for (const stock of stocks) {
    const bundle = loadRows(stock.code, adjust) || {};
    const daily = Array.isArray(bundle.daily) ? bundle.daily : aggregatePeriod(bundle, 'day');
    const weekly = periodsUsed.has('week')
      ? (Array.isArray(bundle.weekly) && bundle.weekly.length ? bundle.weekly : aggregatePeriod(daily, 'week'))
      : null;
    const rowsFor = (period) => (period === 'day' ? daily : period === 'week' ? weekly : aggregatePeriod(daily, period));
    const vars = strategy.vars || null;
    // 每个周期只保留「最长窗口」所需的尾部 bar：所有条件都只看尾部窗口，
    // 裁掉前面用不到的历史可让每次窗口/引用计算的数据量骤降。
    const tails = new Map();
    const tailFor = (period) => {
      if (tails.has(period)) return tails.get(period);
      const full = rowsFor(period) || [];
      let need = 0;
      for (const condition of strategy.all) {
        if (condition.period !== period) continue;
        const p = condition.params || {};
        if (condition.indicator === 'expr') need = Math.max(need, lookback(p.expr, vars, new Set()) + 1);
        else need = Math.max(need, Number(p.length || 20) + 1, Number(p.fast || 5) + 1, Number(p.slow || 20) + 1);
      }
      const tail = need > 0 && need < full.length ? full.slice(-need) : full;
      tails.set(period, tail);
      return tail;
    };
    // 单票单周期一个缓存：同一周期下所有条件共享同一份 vars 求值结果。
    // 必须按周期隔离（日线/周线 rows 不同），因此每个周期一个 Map。
    const caches = new Map();
    const cacheFor = (period) => {
      if (!caches.has(period)) caches.set(period, new Map());
      return caches.get(period);
    };
    const fullLen = (period) => (rowsFor(period) || []).length;
    const evaluate = (condition) => indicatorResult(
      tailFor(condition.period), condition.indicator, condition.params, vars,
      cacheFor(condition.period), fullLen(condition.period),
    );
    // 顺序求值 + 前缀短路：一旦某条不通过就无需再算后面的条件。
    // 通过项仍会跑完全部条件，保证 matched 明细完整（前端条件面板依赖它）。
    const details = [];
    let failed = false;
    for (const condition of strategy.all) {
      const result = evaluate(condition);
      details.push({ ...condition, result });
      if (!result.pass) { failed = true; break; }
    }
    if (failed) continue;
    output.push({
      code: stock.code,
      name: stock.name,
      board: stock.board,
      latest: daily.at(-1)?.date || null,
      close: daily.at(-1)?.c || null,
      weeklyLatest: weekly?.at(-1)?.date || null,
      matched: details.map((item) => ({ period: item.period, indicator: item.indicator, reason: item.result.reason, value: item.result.value })),
    });
  }
  return output;
}

// 把若干批 screenChunk 的产出统一收口：合并 → 截断 limit → 编号。
// 分批调用时各批已互相独立地算完，这里只做最终的全局截断，
// 语义与单批 runScreen 完全一致（limit 作用于全局，而非各批）。
export function finalizeResults(strategy, output, scanned) {
  const results = output.slice(0, strategy.limit ?? 100).map((row, index) => ({ ...row, rank: index + 1 }));
  return {
    count: results.length,
    scanned,
    passed: output.length,
    results,
  };
}

// 单批封装：保持原有对外契约（返回 { count, scanned, passed, results }）。
export function runScreen(strategy, stocks, loadRows, { adjust = 'qfq' } = {}) {
  const output = screenChunk(strategy, stocks, loadRows, { adjust });
  return finalizeResults(strategy, output, stocks.length);
}

export const engineInfo = { periods: ['day', 'week'], indicators: [...INDICATORS], maColumns: [...MA_COLUMNS], prefilter: { enabled: true, minBars: 10 } };

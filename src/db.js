import Database from '/home/ubuntu/kline-trainer/node_modules/better-sqlite3/lib/index.js';

const DB_PATH = process.env.KLINE_DB || '/home/ubuntu/kline-trainer/kline-server/data/kline.db';

let _conn = null;
function conn() {
  if (!_conn) _conn = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  return _conn;
}

const ADJUST_SUFFIX = { raw: 'raw', qfq: 'qfq', hfq: 'hfq' };

export function dataSource() {
  return { dbPath: DB_PATH, kind: 'kline.db', mode: 'precompute' };
}

export function listStocks({ board, excludeST = true } = {}) {
  const c = conn();
  const where = [];
  const params = [];
  // board 支持单值或数组/逗号串：主板在库里是 sh_main + sz_main 两个板块，需按组过滤。
  const boards = Array.isArray(board)
    ? board
    : (board ? String(board).split(',').map((s) => s.trim()).filter(Boolean) : []);
  if (boards.length === 1) { where.push('board = ?'); params.push(boards[0]); }
  else if (boards.length > 1) { where.push(`board IN (${boards.map(() => '?').join(',')})`); params.push(...boards); }
  // 排除 ST / *ST / S 类风险股（此前 excludeST 参数虽存在却从未参与查询，等于失效）
  if (excludeST) where.push("name NOT LIKE 'ST%' AND name NOT LIKE '*ST%' AND name NOT LIKE 'SST%' AND name NOT LIKE 'S*ST%'");
  const sql = `SELECT code, name, board, first_date, last_date, rows FROM stocks
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY code`;
  return c.prepare(sql).all(...params);
}

export function getStock(code) {
  return conn().prepare('SELECT code, name, board, first_date, last_date, rows FROM stocks WHERE code = ?').get(code) || null;
}

// 按代码或名称模糊搜索，供自选股添加使用。
// 代码匹配时同时兼容带/不带市场前缀的写法（用户常只记得 000807）。
export function searchStocks(query, limit = 20) {
  const q = String(query || '').trim();
  if (!q) return [];
  const c = conn();
  const like = `%${q}%`;
  const bare = q.replace(/^(sh|sz|bj)/i, '');
  const n = Math.max(1, Math.min(Number(limit) || 20, 50));
  return c.prepare(
    `SELECT code, name, board, last_date, rows FROM stocks
     WHERE name LIKE ? OR code LIKE ? OR code LIKE ?
     ORDER BY CASE WHEN code LIKE ? THEN 0 ELSE 1 END, code
     LIMIT ?`
  ).all(like, like, `%${bare}%`, `${bare}%`, n);
}

export function loadDaily(code, adjust = 'qfq', { from, to } = {}) {
  const c = conn();
  const suffix = ADJUST_SUFFIX[adjust];
  let sql = `SELECT code, date,
      open_${suffix} AS open,
      high_${suffix} AS high,
      low_${suffix} AS low,
      close_${suffix} AS close,
      vol, amount
    FROM daily_kline WHERE code = ?`;
  const params = [code];
  if (from) { sql += ' AND date >= ?'; params.push(from); }
  if (to) { sql += ' AND date <= ?'; params.push(to); }
  sql += ' ORDER BY date ASC';
  return c.prepare(sql).all(...params);
}

// 取某只票最新的 bars 根日线（先按日期倒序取尾部，再翻回正序）。
// 注意：不能复用 loadDaily 的 ASC + LIMIT —— 那会把最早的一段历史当"最近 N 根"返回。
export function loadDailyTail(code, adjust = 'qfq', bars = 250) {
  const c = conn();
  const suffix = ADJUST_SUFFIX[adjust] || 'qfq';
  const n = Math.max(1, Math.min(Number(bars) || 250, 5000));
  const rows = c.prepare(
    `SELECT code, date,
      open_${suffix} AS open,
      high_${suffix} AS high,
      low_${suffix} AS low,
      close_${suffix} AS close,
      vol, amount
    FROM daily_kline WHERE code = ? ORDER BY date DESC LIMIT ?`
  ).all(code, n);
  return rows.reverse();
}

// 按 code 分块执行 IN 查询。日线指标表自建库起即全市场写入，
// 不带 code 过滤会走 idx_di_date 扫全市场并触发临时 B 树排序（实测 1371 只票慢到 4.9s）；
// 带上 code 后命中主键 (code,date) WITHOUT ROWID，既砍行数又免排序（同一查询 ~0.4s）。
// SQLite 3.32+ 参数上限 32766，全市场 5574 只可一次装下，仍分块以防极端情况。
const CODE_CHUNK = 2000;
function queryByCodes(c, baseSql, codes, from, to, dateCol) {
  const out = [];
  const run = (chunk) => {
    let sql = baseSql;
    const params = [];
    if (chunk && chunk.length) {
      sql += ` AND code IN (${chunk.map(() => '?').join(',')})`;
      params.push(...chunk);
    }
    if (from) { sql += ` AND ${dateCol} >= ?`; params.push(from); }
    if (to) { sql += ` AND ${dateCol} <= ?`; params.push(to); }
    sql += ` ORDER BY code, ${dateCol} ASC`;
    // 不能写 out.push(...rows)：一块可能返回数万行，展开成数万个实参会爆栈
    // （实测 1371 只票时报 RangeError: Maximum call stack size exceeded）。
    const rows = c.prepare(sql).all(...params);
    for (let k = 0; k < rows.length; k++) out.push(rows[k]);
  };
  if (!codes || !codes.length) {
    run(null); // 未指定股票池时退化为全市场，保持原行为
    return out;
  }
  for (let i = 0; i < codes.length; i += CODE_CHUNK) run(codes.slice(i, i + CODE_CHUNK));
  return out;
}

// 字段裁剪：纯表达式策略（indicator 全为 expr）在引擎里是拿 close/vol 现场滚动计算，
// 根本不读预计算的 ma*/vr* 列。此时只 SELECT 2 列，实测比全 12 列快约 40%，
// 且每行少造 8 个字段、显著降低 V8 堆压力。
export function loadIndicators(codes, { from, to, maVr = true } = {}) {
  const c = conn();
  const cols = maVr
    ? 'close, vol, ma5, ma10, ma20, ma60, vr5, vr10, vr20, vr60'
    : 'close, vol';
  const baseSql = `SELECT code, date, ${cols}
    FROM daily_indicators WHERE 1=1`;
  return queryByCodes(c, baseSql, codes, from, to, 'date');
}

export function loadRecentDaily(codes, { from, to, adjust = 'qfq' } = {}) {
  if (!codes?.length) return [];
  const c = conn();
  const suffix = ADJUST_SUFFIX[adjust];
  // 与 loadIndicators 同理：daily_kline 主键是 (code, date)，带上 code IN 命中主键顺序扫描，
  // 比只按 date 过滤快约 8~10 倍；分块避免一次展开过多参数。
  const baseSql = `SELECT code, date,
      open_${suffix} AS open,
      high_${suffix} AS high,
      low_${suffix} AS low,
      close_${suffix} AS close,
      vol, amount
    FROM daily_kline WHERE 1=1`;
  return queryByCodes(c, baseSql, codes, from, to, 'date');
}

// 一次性把全市场最近 N 个交易日的日线拉出来，用于选股预筛阶段：
//   - 不用 code IN (...) 传 5574 个参数（会变成超大 SQL，且参数展开成本高），
//     改用 WHERE date >= ? AND date <= ?，命中 idx_kline_date 全表按日期扫一次。
//   - 先用 SELECT DISTINCT date ... LIMIT N 找到真实的最近 N 个交易日，避免自然日换算误差。
//   - 返回 Map<code, rows[]>，rows 已按 date 升序，字段形状与 loadRecentDaily 一致
//     （open/high/low/close 已按 adjust 复权别名列），便于直接喂给 applyRealtimeToDaily。
export function loadShortDaily(adjust = 'qfq', bars = 10, toDate = null) {
  const n = Math.max(1, Math.min(Number(bars) || 10, 250));
  const c = conn();
  const suffix = ADJUST_SUFFIX[adjust] || 'qfq';
  const to = toDate || c.prepare('SELECT MAX(date) as d FROM daily_kline').get()?.d;
  if (!to) return new Map();
  const dates = c.prepare(
    'SELECT DISTINCT date FROM daily_kline WHERE date <= ? ORDER BY date DESC LIMIT ?'
  ).all(to, n).map((r) => r.date);
  if (!dates.length) return new Map();
  const from = dates[dates.length - 1];
  const rows = c.prepare(
    `SELECT code, date,
        open_${suffix} AS open,
        high_${suffix} AS high,
        low_${suffix} AS low,
        close_${suffix} AS close,
        vol, amount
      FROM daily_kline
      WHERE date >= ? AND date <= ?
      ORDER BY code, date ASC`
  ).all(from, to);
  const out = new Map();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    let bucket = out.get(row.code);
    if (!bucket) { bucket = []; out.set(row.code, bucket); }
    bucket.push(row);
  }
  return out;
}

export function loadWeeklyIndicators(codes, { from, to, maVr = true } = {}) {
  const c = conn();
  const cols = maVr
    ? 'close, vol, ma5, ma10, ma20, ma60, vr5, vr10, vr20, vr60'
    : 'close, vol';
  const baseSql = `SELECT code, week_start AS date, ${cols}
    FROM weekly_indicators WHERE 1=1`;
  return queryByCodes(c, baseSql, codes, from, to, 'week_start');
}

export function loadLatestIndicator(code) {
  const c = conn();
  return c.prepare(
    `SELECT code, date, close, vol, ma5, ma10, ma20, ma60, vr5, vr10, vr20, vr60
     FROM daily_indicators WHERE code = ? ORDER BY date DESC LIMIT 1`
  ).get(code);
}

export function precomputeStatus() {
  const c = conn();
  try {
    const meta = c.prepare('SELECT key, value FROM precompute_meta').all();
    const m = {};
    meta.forEach(r => { m[r.key] = r.value; });
    return {
      ok: !!m.last_completed_date,
      lastCompletedDate: m.last_completed_date || null,
      lastCompletedAt: m.completed_at || null,
      schemaVersion: m.schema_version || null,
    };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

export function hasPrecomputedIndicator(code) {
  const c = conn();
  const r = c.prepare('SELECT MAX(date) as d FROM daily_indicators WHERE code = ?').get(code);
  return !!(r && r.d);
}

export function databaseStats() {
  const c = conn();
  const pick = (sql) => {
    try { return c.prepare(sql).get().n; } catch (e) { return 0; }
  };
  return {
    stocks: pick('SELECT COUNT(*) as n FROM stocks'),
    kline: pick('SELECT COUNT(*) as n FROM daily_kline'),
    dailyIndicators: pick('SELECT COUNT(*) as n FROM daily_indicators'),
    weeklyKline: pick('SELECT COUNT(*) as n FROM weekly_kline'),
    weeklyIndicators: pick('SELECT COUNT(*) as n FROM weekly_indicators'),
  };
}

#!/usr/bin/env node
/**
 * 预计算脚本：从 daily_kline 生成 daily_indicators / weekly_kline / weekly_indicators
 *
 * 口径：停牌日 close 用前一日收盘价填充（vol 保持 0），对齐通达信。
 * 停牌日 close = prev_close, vol = 0 → volume_ratio = 0，不会误报"放量"。
 * 增量模式：从 daily_indicators 最新日期之后的交易日开始预计算，避免全量重跑。
 */

import Database from '/home/ubuntu/kline-trainer/node_modules/better-sqlite3/lib/index.js';
import fs from 'fs';

const DB_PATH = process.env.KLINE_DB || '/home/ubuntu/kline-trainer/kline-server/data/kline.db';
const STAMP_FILE = '/tmp/stock-picker-precompute.stamp';
const SAMPLE_MODE = process.env.PRECOMPUTE_SAMPLE === '1';
const SAMPLE_LIMIT = parseInt(process.env.PRECOMPUTE_SAMPLE_LIMIT || '20', 10);
const BATCH_SIZE = 2000;
const MA_LENGTHS = [5, 10, 20, 60];
const VR_LENGTHS = [5, 10, 20, 60];

function log(msg) {
  console.log(`[precompute ${new Date().toISOString()}] ${msg}`);
}

function createTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS daily_indicators (
      code TEXT NOT NULL,
      date TEXT NOT NULL,
      close REAL,
      vol REAL,
      ma5 REAL, ma10 REAL, ma20 REAL, ma60 REAL,
      vr5 REAL, vr10 REAL, vr20 REAL, vr60 REAL,
      PRIMARY KEY (code, date)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS weekly_kline (
      code TEXT NOT NULL,
      week_start TEXT NOT NULL,
      open REAL, high REAL, low REAL, close REAL,
      vol REAL, amount REAL,
      trade_days INTEGER,
      PRIMARY KEY (code, week_start)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS weekly_indicators (
      code TEXT NOT NULL,
      week_start TEXT NOT NULL,
      close REAL,
      vol REAL,
      ma5 REAL, ma10 REAL, ma20 REAL, ma60 REAL,
      vr5 REAL, vr10 REAL, vr20 REAL, vr60 REAL,
      PRIMARY KEY (code, week_start)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS precompute_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

function getIncrementalStart(db) {
  try {
    const row = db.prepare(
      `SELECT value FROM precompute_meta WHERE key = 'last_completed_date'`
    ).get();
    return row ? row.value : null;
  } catch {
    return null;
  }
}

function setIncrementalStart(db, date) {
  db.prepare(
    `INSERT OR REPLACE INTO precompute_meta (key, value) VALUES ('last_completed_date', ?)`
  ).run(date);
}

/**
 * 滚动计算 MA 和 VR
 * rows: [{date, open, high, low, close, vol, amount}]，按 date ASC 排序
 * 停牌日处理：close 为空 → 用前一日 close 填充；vol 保持 0
 * 返回值：填充后的 rows
 */
function fillSuspendedDays(rows) {
  let prevClose = null;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.close == null || Number.isNaN(r.close)) {
      // 停牌日：用前一日 close 填充，vol 设为 0
      if (prevClose != null) r.close = prevClose;
      r.vol = 0;
      r.amount = 0;
    } else {
      prevClose = r.close;
    }
  }
  return rows;
}

/**
 * 计算所有 MA 和 VR，返回扩展后的 rows
 * 每行的 ma5/ma10/ma20/ma60 和 vr5/vr10/vr20/vr60
 */
function computeIndicators(rows) {
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    for (const len of MA_LENGTHS) {
      const key = `ma${len}`;
      if (i < len - 1) {
        r[key] = null;
      } else {
        let sum = 0;
        for (let j = i - len + 1; j <= i; j++) sum += rows[j].close;
        r[key] = sum / len;
      }
    }
    for (const len of VR_LENGTHS) {
      const key = `vr${len}`;
      if (i < len) {
        r[key] = null;
      } else {
        let sum = 0;
        for (let j = i - len; j < i; j++) sum += rows[j].vol;
        const avg = sum / len;
        r[key] = avg > 0 ? r.vol / avg : 0;
      }
    }
  }
  return rows;
}

/**
 * 按周聚合日线为周线
 * 完整周判定：包含周五或以前为结束日的周（即周五及以前的周算完整）
 * 停牌日：open 取周首交易日；close 取周末最后一日（含 fill）
 */
function aggregateToWeekly(dailyRows) {
  const groups = new Map();
  for (const r of dailyRows) {
    const ds = new Date(r.date + 'T00:00:00Z');
    const day = ds.getUTCDay();
    let offset = (day === 0) ? 6 : (day === 1 ? 0 : day - 1);
    const ws = new Date(ds);
    ws.setUTCDate(ws.getUTCDate() - offset);
    const wsKey = ws.toISOString().slice(0, 10);
    let g = groups.get(wsKey);
    if (!g) { g = { ws: wsKey, rows: [] }; groups.set(wsKey, g); }
    g.rows.push(r);
  }
  return [...groups.values()].sort((a, b) => a.ws.localeCompare(b.ws));
}

/**
 * 返回 date 所在周的周一（周起点），口径必须与 aggregateToWeekly 保持一致
 * 用于增量模式下判断"哪些周需要回写"
 */
function weekStartOf(dateStr) {
  const ds = new Date(dateStr + 'T00:00:00Z');
  const day = ds.getUTCDay();
  const offset = (day === 0) ? 6 : (day === 1 ? 0 : day - 1);
  ds.setUTCDate(ds.getUTCDate() - offset);
  return ds.toISOString().slice(0, 10);
}

function buildWeeklyRecords(groups, code) {
  const weekly = [];
  for (const g of groups) {
    let open = null, high = -Infinity, low = Infinity, close = null;
    let vol = 0, amount = 0, tradeDays = 0;
    for (const r of g.rows) {
      if (open === null) open = r.open;
      high = Math.max(high, r.high);
      low = Math.min(low, r.low);
      close = r.close;
      vol += r.vol || 0;
      amount += r.amount || 0;
      if ((r.vol || 0) > 0) tradeDays++;
    }
    weekly.push({
      code,
      date: g.ws,
      open, high, low, close, vol, amount,
      tradeDays,
      ma5: null, ma10: null, ma20: null, ma60: null,
      vr5: null, vr10: null, vr20: null, vr60: null,
    });
  }
  return weekly;
}

function buildInserts(db) {
  const diStmt = db.prepare(`
    INSERT OR REPLACE INTO daily_indicators
      (code, date, close, vol, ma5, ma10, ma20, ma60, vr5, vr10, vr20, vr60)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const wkStmt = db.prepare(`
    INSERT OR REPLACE INTO weekly_kline
      (code, week_start, open, high, low, close, vol, amount, trade_days)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const wiStmt = db.prepare(`
    INSERT OR REPLACE INTO weekly_indicators
      (code, week_start, close, vol, ma5, ma10, ma20, ma60, vr5, vr10, vr20, vr60)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  return { insertDaily: diStmt, insertWeekly: wkStmt, insertWeeklyInd: wiStmt };
}



function processStocks(db, stmts, args) {
  const { limit, start, since } = args;
  let stockList;
  if (args.sample) {
    stockList = db.prepare("SELECT code FROM stocks ORDER BY code LIMIT ?").all(SAMPLE_LIMIT).map(r => r.code);
  } else if (limit) {
    stockList = db.prepare("SELECT code FROM stocks ORDER BY code LIMIT ?").all(limit).map(r => r.code);
  } else if (start) {
    stockList = db.prepare("SELECT code FROM stocks WHERE code >= ? ORDER BY code").all(start).map(r => r.code);
  } else {
    stockList = db.prepare("SELECT code FROM stocks ORDER BY code").all().map(r => r.code);
  }
  const total = stockList.length;
  const t0 = Date.now();
  let totalRead = 0, totalDaily = 0, totalWeekly = 0, totalWeeklyInd = 0, skipped = 0;
  for (let i = 0; i < total; i++) {
    const code = stockList[i];
    const rows = db.prepare(
      "SELECT code, date, open_qfq AS open, high_qfq AS high, low_qfq AS low, close_qfq AS close, vol, amount " +
      "FROM daily_kline WHERE code = ? ORDER BY date ASC"
    ).all(code).filter(r => r.close !== null && r.close !== undefined);
    if (!rows.length) { skipped++; continue; }
    // 增量模式判定：该股是否确有 since 之后的新数据，无则跳过（避免无谓计算）
    if (since && !rows.some(r => r.date >= since)) { skipped++; continue; }

    // 计算统一使用全历史（calcRows），因为 MA60/VR60 等需要前置窗口，
    // 若按 since 截断会因窗口不足算出错误值（ma5 等）或空值（ma20/ma60），
    // 周线更会只用一周内的残余交易日合成出错误 K 线并覆盖正确结果。
    const calcRows = rows;
    fillSuspendedDays(calcRows);
    computeIndicators(calcRows);
    const groups = aggregateToWeekly(calcRows);
    const wRows = buildWeeklyRecords(groups, code);
    // 用 computeIndicators 处理周指标，需 date 字段
    const wkForInd = wRows.map(w => ({ code, date: w.date, close: w.close, vol: w.vol }));
    computeIndicators(wkForInd);
    const wkInd = wkForInd;

    // 回写范围：全量模式写全部；增量模式只回写 since 及之后的新数据。
    // 周线按周起点过滤，使 since 所在的那一周（可能是残缺周）以完整数据重算后回写。
    const sinceWeek = since ? weekStartOf(since) : null;
    const dWrite = since ? calcRows.filter(r => r.date >= since) : calcRows;
    const wIdx = [];
    for (let j = 0; j < wRows.length; j++) {
      if (!sinceWeek || wRows[j].date >= sinceWeek) wIdx.push(j);
    }
    if (!dWrite.length && !wIdx.length) { skipped++; continue; }
    db.transaction(() => {
      for (let j = 0; j < dWrite.length; j++) {
        const r = dWrite[j];
        stmts.insertDaily.run(r.code, r.date, r.close, r.vol || 0, r.ma5, r.ma10, r.ma20, r.ma60, r.vr5, r.vr10, r.vr20, r.vr60);
      }
      for (const j of wIdx) {
        const r = wRows[j];
        stmts.insertWeekly.run(r.code, r.date, r.open, r.high, r.low, r.close, r.vol, r.amount, r.tradeDays);
      }
      for (const j of wIdx) {
        const r = wkInd[j];
        stmts.insertWeeklyInd.run(r.code, r.date, r.close, r.vol || 0, r.ma5, r.ma10, r.ma20, r.ma60, r.vr5, r.vr10, r.vr20, r.vr60);
      }
    })();
    totalRead += rows.length;
    totalDaily += dWrite.length;
    totalWeekly += wIdx.length;
    totalWeeklyInd += wIdx.length;
    if ((i + 1) % 500 === 0 || i + 1 === total) {
      log("processed " + (i+1) + "/" + total + ", read=" + totalRead + ", wrote daily=" + totalDaily + " weekly=" + totalWeekly);
    }
  }
  const elapsed = Date.now() - t0;
  const summary = { total, processed: total - skipped, skipped, read: totalRead, daily: totalDaily, weekly: totalWeekly, weeklyInd: totalWeeklyInd, elapsed, sample: !!args.sample };
  log("DONE " + JSON.stringify(summary));
  fs.appendFileSync("/home/ubuntu/stock-picker/logs/precompute.log", "[" + new Date().toISOString() + "] " + JSON.stringify(summary) + "\n");
  return summary;
}

function writeStamp() {
  fs.writeFileSync(STAMP_FILE, JSON.stringify({ time: new Date().toISOString(), user: process.env.USER, pid: process.pid }, null, 2));
}

const force = process.argv.includes("--force");
const sample = SAMPLE_MODE;
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === "--limit" && process.argv[i+1]) { args.limit = parseInt(process.argv[i+1], 10); i++; }
  else if (process.argv[i] === "--start" && process.argv[i+1]) { args.start = process.argv[i+1]; i++; }
}
if (sample) log("SAMPLE mode: " + SAMPLE_LIMIT + " stocks");

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
createTables(db);

let since = null;
if (!force) { since = getIncrementalStart(db); if (since) log("incremental since " + since); }
const stmts = buildInserts(db);
const summary = processStocks(db, stmts, { ...args, since, sample });
if (summary.processed > 0) {
  const maxDate = db.prepare("SELECT MAX(date) as d FROM daily_indicators").get().d;
  setIncrementalStart(db, maxDate);
  log("max_date=" + maxDate);
}
// WAL 回收：预计算是每日链路的最后一环，此处 checkpoint 可一并覆盖
// 上游下载与本次预计算产生的 WAL 增量。TRUNCATE 把 WAL 文件回收为 0，
// 避免常驻读连接（kline-server / stock-picker）长期持有快照导致 WAL 只涨不缩。
try {
  const ck = db.pragma("wal_checkpoint(TRUNCATE)");
  log("wal_checkpoint=" + JSON.stringify(ck));
} catch (e) {
  log("wal_checkpoint skipped: " + e.message);
}
writeStamp();
db.close();
console.log("=== precompute summary ===");
console.log(JSON.stringify(summary, null, 2));

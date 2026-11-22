// 日内自动盯盘 + 买票清单。
//
// 干的事很窄：在早盘约定的时间窗里，每 5 分钟替人跑一次日内策略，
// 把「这一刻出手的票」按代码去重地记到当天的清单文件里，供网页端翻看。
//
// 三条不越界的约定：
//   ① 只做记录，不做任何交易动作；
//   ② 记录的内容全部来自那一次选股当时的结果（触发时刻、买价、形态等），事后不再改写；
//   ③ 只在时间窗内自动跑；窗外除非人手动点，否则一次也不跑。
//
// 存盘格式（data/intraday-picks/YYYY-MM-DD.json）：
//   { date, updatedAt, strategyId, runs:[{at,hhmm,count,scanned,baseDate,elapsedMs,added}], picks:[...] }
// picks 里每条就是选股结果那一行，外加 firstSeen（第一次被记下的时刻）与 seenAt（最近一次被看到的时刻），
// 这样同一只票在 09:40 和 09:50 都被选中时，清单上只有一行，看得出它是什么时候第一次露面的。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listStocks } from './db.js';
import { runIntradayScreen } from './intraday.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PICK_DIR = path.join(__dirname, '..', 'data', 'intraday-picks');

// 自动盯盘的默认节奏：早盘 09:35 起，到 10:00 结束（含），每 5 分钟一次。
// 这三个数字与策略里的出手时间窗是两回事：策略窗口决定「哪一分钟的形态算数」，
// 这里决定「我们隔多久去看一眼」。窗口末尾再往后看已经买不进去了，所以按时收工。
const AUTO_DEFAULT = { from: '0935', to: '1000', everyMin: 5 };

// 服务器在哪个时区都得按北京时间判断早盘，不能拿机器本地时间凑合。
function cstParts(d = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short',
  });
  const out = {};
  for (const p of fmt.formatToParts(d)) out[p.type] = p.value;
  // en-CA 的 hour 在 24 点整可能给出 "24"，归一成 "00"
  const hour = out.hour === '24' ? '00' : out.hour;
  return { date: `${out.year}-${out.month}-${out.day}`, hhmm: `${hour}${out.minute}`, weekday: out.weekday };
}

function toMinute(hhmm) {
  const s = String(hhmm || '');
  if (!/^\d{4}$/.test(s)) return null;
  return Number(s.slice(0, 2)) * 60 + Number(s.slice(2));
}

function ensureDir() {
  try { fs.mkdirSync(PICK_DIR, { recursive: true }); } catch { /* 已存在 */ }
}

function fileFor(date) {
  return path.join(PICK_DIR, `${date}.json`);
}

export function listPickDates(limit = 15) {
  ensureDir();
  let names = [];
  try {
    names = fs.readdirSync(PICK_DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
  } catch { return []; }
  names.sort().reverse();
  return names.slice(0, limit).map((f) => f.replace(/\.json$/, ''));
}

export function readPicks(date) {
  const d = String(date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return { date: '', updatedAt: null, runs: [], picks: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(fileFor(d), 'utf8'));
    return {
      date: d,
      updatedAt: raw.updatedAt || null,
      strategyId: raw.strategyId || '',
      runs: Array.isArray(raw.runs) ? raw.runs : [],
      picks: Array.isArray(raw.picks) ? raw.picks : [],
    };
  } catch {
    return { date: d, updatedAt: null, strategyId: '', runs: [], picks: [] };
  }
}

function writePicks(doc) {
  ensureDir();
  // 先写临时文件再改名：写一半被中断时不会留下半个坏文件，把当天清单整份毁掉。
  const tmp = `${fileFor(doc.date)}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, fileFor(doc.date));
}

// 把一次选股结果并进当天清单。同一只票只留一行（更新最近被看到的时刻与现价），
// 新出现的票记下 firstSeen。返回本次新增了几只，用于日志和前端提示。
export function mergePicks(date, run, atHHMM) {
  const doc = readPicks(date);
  doc.date = date;
  doc.strategyId = run.strategyId || doc.strategyId || '';
  doc.updatedAt = new Date().toISOString();
  const seen = new Map(doc.picks.map((p) => [p.code, p]));
  let added = 0;
  for (const r of (run.results || [])) {
    const old = seen.get(r.code);
    if (old) {
      // 已经记过的票：只刷新「最近看到」的现价与时刻，触发那一刻的事实保持原样。
      old.seenAt = atHHMM;
      old.nowPct = r.nowPct;
      old.lastSeenPrice = r.close;
      continue;
    }
    added++;
    doc.picks.push({
      code: r.code,
      name: r.name,
      firstSeen: atHHMM,
      seenAt: atHHMM,
      baseDate: run.baseDate || date,
      open: r.open,
      prevClose: r.prevClose,
      gap: r.gap,
      triggerTime: r.triggerTime,
      anchorTime: r.anchorTime,
      triggerPrice: r.triggerPrice,
      triggerPct: r.triggerPct,
      nowPct: r.nowPct,
      form: r.form,
      volShape: r.volShape,
      midPct: r.midPct,
      close: r.close,
    });
  }
  doc.picks.sort((a, b) => String(a.firstSeen).localeCompare(String(b.firstSeen))
    || (Number(b.triggerPct) || 0) - (Number(a.triggerPct) || 0));
  doc.runs = [...(doc.runs || []), {
    at: new Date().toISOString(),
    hhmm: atHHMM,
    count: run.count,
    scanned: run.scanned,
    passed: run.passed,
    baseDate: run.baseDate,
    elapsedMs: run.elapsedMs,
    added,
  }].slice(-60);
  writePicks(doc);
  return { added, total: doc.picks.length };
}

// 手动补记 / 强制跑一次：给接口用，也能在非交易时段拿当天（最近交易日）数据试。
export async function runPickOnce(strategy, strategyId, { force = false, baseDate, log = () => {} } = {}) {
  const now = new Date();
  const cst = cstParts(now);
  const stocks = listStocks({ board: undefined, excludeST: strategy.universe?.excludeSt !== false });
  const run = await runIntradayScreen(strategy, stocks, {
    now,
    baseDate: baseDate || strategy.baseDate || undefined,
    log,
  });
  const runOut = { ...run, strategyId };
  // 分时接口只给最近一个交易日：如果数据日不是今天，说明今天没开市（节假日/周末/还没开盘），
  // 这时记进「今天」的清单就是错的，直接拒绝，免得清单里混进上一天的价格。
  const dateMatches = run.baseDate === cst.date;
  if (!force && !dateMatches) {
    return { ok: false, reason: 'not-trading-day', baseDate: run.baseDate, today: cst.date, run: runOut };
  }
  const date = dateMatches ? cst.date : (baseDate || run.baseDate || cst.date);
  const info = mergePicks(date, runOut, cst.hhmm);
  log(`清单记入 ${date}：本次新增 ${info.added} 只，累计 ${info.total} 只`);
  return { ok: true, date, ...info, run: runOut };
}

// ---------- 自动盯盘调度 ----------
// 每 20 秒看一次表。到了窗口内某个 5 分钟刻度且这一格还没跑过，就跑一次。
// 用「刻度」而不是「距上次隔了多久」来判定，电脑睡眠/服务重启后不会把该跑的那几格补成连环比。
let timer = null;
let running = false;
let lastBucket = '';       // 形如 2026-11-20|0945
let lastResult = null;     // 最近一次自动跑的结果摘要，供前端显示

export function autoWatchStatus() {
  const cfg = getConfig();
  return {
    enabled: !!timer,
    running,
    from: cfg.from,
    to: cfg.to,
    everyMin: cfg.everyMin,
    lastBucket,
    lastResult,
  };
}

let cfgOverride = null;
function getConfig() { return { ...AUTO_DEFAULT, ...(cfgOverride || {}) }; }

/**
 * 启动自动盯盘。
 * @param {object} opts
 * @param {() => {id:string, strategy:object}|null} opts.resolveStrategy 每次跑之前重新取策略，
 *        这样用户在页面上改了参数，下一次自动跑就用新参数，不用重启服务。
 */
export function startAutoWatch({ resolveStrategy, log = () => {} } = {}) {
  if (timer) return;
  const tick = async () => {
    try {
      const cfg = getConfig();
      const cst = cstParts();
      if (cst.weekday === 'Sat' || cst.weekday === 'Sun') return;
      const m = toMinute(cst.hhmm);
      const from = toMinute(cfg.from);
      const to = toMinute(cfg.to);
      if (m == null || from == null || to == null) return;
      if (m < from || m > to) return;
      // 归到最近的 5 分钟刻度；刻度用「当天日期 + 分钟数」唯一标识，避免跨日串号
      const bucketMin = Math.floor(m / cfg.everyMin) * cfg.everyMin;
      const bucket = `${cst.date}|${String(Math.floor(bucketMin / 60)).padStart(2, '0')}${String(bucketMin % 60).padStart(2, '0')}`;
      if (bucket === lastBucket || running) return;
      const picked = resolveStrategy ? resolveStrategy() : null;
      if (!picked || !picked.strategy) {
        log('自动盯盘：没有可用的日内策略，跳过');
        return;
      }
      running = true;
      // 先占住这一格：跑失败了也不在同一格里反复重试，下一格再来。
      lastBucket = bucket;
      log(`自动盯盘开始：${cst.hhmm}（策略 ${picked.id}）`);
      const t0 = Date.now();
      const res = await runPickOnce(picked.strategy, picked.id, { log });
      lastResult = {
        at: new Date().toISOString(), hhmm: cst.hhmm, bucket,
        ok: !!res.ok, reason: res.reason || '', date: res.date || '',
        added: res.added || 0, total: res.total || 0,
        count: res.run ? res.run.count : 0, elapsedMs: Date.now() - t0,
      };
      if (!res.ok) log(`自动盯盘跳过（${res.reason}）：数据日 ${res.baseDate}，今天 ${res.today}`);
    } catch (e) {
      log(`自动盯盘出错：${e && e.message}`);
    } finally {
      running = false;
    }
  };
  // 起服务时先看一眼现在是不是就在窗口里：如果是，立刻补跑这一次，不等下一个刻度。
  tick();
  timer = setInterval(tick, 20 * 1000);
  if (timer.unref) timer.unref();
  log(`自动盯盘已启动：每天 ${getConfig().from}~${getConfig().to} 每 ${getConfig().everyMin} 分钟一次`);
}

export function stopAutoWatch() {
  if (timer) { clearInterval(timer); timer = null; }
}

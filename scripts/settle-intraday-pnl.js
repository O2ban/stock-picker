#!/usr/bin/env node
// 每日盈亏台账：把买票清单里每只票按 T+1 口径结算，落到 data/intraday-pnl/。
//
// 口径（用户 2026-11-19 定稿）：
//   买入价 = 触发那一分钟的成交价（清单里的 triggerPrice，与分时曲线同源）
//   卖出价 = 下一个交易日开盘价（当天买、当天不能卖，最早次日开盘走）
//   费用   = 双边合计 0.26%（佣金+印花税+滑差估，与回测 FEE 同源）
//   净收益 = 卖出/买入 - 1，换成百分数后减 0.26
//
// 同时附带几个参考数字（不参与主账，只供复盘对比）：
//   次日收盘卖、次日最高价（理论最优）、次日最低价（理论最差）
//
// 用法：
//   node scripts/settle-intraday-pnl.js              # 结算所有清单日期
//   node scripts/settle-intraday-pnl.js 2026-11-19   # 只结算某一天的清单
//
// 产出：
//   data/intraday-pnl/ledger.json   全量明细 + 汇总（页面与后续统计都读这份）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listPickDates, readPicks } from '../src/intraday-picks.js';
import { loadRecentDaily } from '../src/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '..', 'data', 'intraday-pnl');
const LEDGER = path.join(OUT_DIR, 'ledger.json');
const FEE = 0.26;          // 双边合计百分比，与回测同源
const LOOKAHEAD_DAYS = 12; // 找「下一个交易日」的搜索窗口

function r2(x) { return x == null ? null : Math.round(x * 100) / 100; }

function addDays(dash, n) {
  const d = new Date(`${dash}T00:00:00+08:00`);
  d.setDate(d.getDate() + n);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

function loadLedger() {
  try { return JSON.parse(fs.readFileSync(LEDGER, 'utf8')); } catch { return { updatedAt: null, fee: FEE, trades: [] }; }
}

async function main() {
  const only = process.argv.slice(2).find((s) => /^\d{4}-\d{2}-\d{2}$/.test(s));
  const dates = only ? [only] : listPickDates(60);
  if (!dates.length) { console.log('[pnl] 还没有任何买票清单'); return; }

  // 1) 收集所有待结算记录（以「日期+代码」为唯一键，重跑不重复计入）
  const all = loadLedger();
  const byKey = new Map((all.trades || []).map((t) => [`${t.date}|${t.code}`, t]));

  const fresh = [];
  for (const date of dates) {
    const doc = readPicks(date);
    for (const p of doc.picks || []) {
      const key = `${date}|${p.code}`;
      const prev = byKey.get(key);
      // 已结算的（有 sellPrice）不再重算；未结算的每次重跑都尝试补上
      if (prev && prev.sellPrice != null) continue;
      fresh.push({ date, code: p.code, name: p.name || '', p, prev });
    }
  }

  if (!fresh.length) {
    console.log('[pnl] 没有新的待结算记录');
  } else {
    // 2) 一次把需要的日线取回来：最近 15 个自然日足够覆盖「买点日 → 次日」
    const codes = [...new Set(fresh.map((f) => f.code))];
    const from = addDays(fresh.map((f) => f.date).sort()[0], -2);
    const to = addDays(new Date().toISOString().slice(0, 10), 1);
    const rows = loadRecentDaily(codes, { from, to, adjust: 'raw' });
    const byCode = new Map();
    for (const r of rows) {
      if (!byCode.has(r.code)) byCode.set(r.code, []);
      byCode.get(r.code).push(r);
    }
    for (const arr of byCode.values()) arr.sort((a, b) => (a.date < b.date ? -1 : 1));

    for (const f of fresh) {
      const buy = f.p?.triggerPrice;
      const bars = byCode.get(f.code) || [];
      const i = bars.findIndex((b) => b.date === f.date);
      let next = null;
      if (i >= 0) next = bars[i + 1] || null;
      // 当天没有日线（停牌等）就退化成按日期顺序找第一条之后的
      if (!next) next = bars.find((b) => b.date > f.date) || null;

      const base = f.prev || {
        date: f.date,
        code: f.code,
        name: f.name,
        triggerTime: f.p?.triggerTime || null,
        triggerPct: f.p?.triggerPct == null ? null : r2(f.p.triggerPct),
        buyPrice: buy == null ? null : buy,
      };
      base.triggerTime = base.triggerTime || f.p?.triggerTime || null;
      base.triggerPct = base.triggerPct == null ? (f.p?.triggerPct == null ? null : r2(f.p.triggerPct)) : base.triggerPct;
      base.buyPrice = base.buyPrice == null ? (buy == null ? null : buy) : base.buyPrice;

      if (buy == null || !next) {
        base.settled = false;
        base.settleDate = next ? next.date : null;
        base.sellPrice = null;
        base.net = null;
        base.reason = buy == null ? '缺买价' : '次日行情未到';
        byKey.set(`${f.date}|${f.code}`, base);
        continue;
      }

      const sellOpen = next.open;
      base.settled = true;
      base.settleDate = next.date;
      base.sellPrice = sellOpen;
      base.net = r2((sellOpen / buy - 1) * 100 - FEE);
      // 参考口径
      base.sellClose = next.close;
      base.netClose = r2((next.close / buy - 1) * 100 - FEE);
      base.nextHigh = next.high;
      base.nextLow = next.low;
      base.netHigh = r2((next.high / buy - 1) * 100 - FEE);
      base.netLow = r2((next.low / buy - 1) * 100 - FEE);
      base.reason = null;
      byKey.set(`${f.date}|${f.code}`, base);
    }
  }

  // 3) 汇总
  const trades = [...byKey.values()].sort((a, b) => (a.date === b.date ? 0 : (a.date < b.date ? 1 : -1)));
  const done = trades.filter((t) => t.settled && t.net != null);
  const wins = done.filter((t) => t.net > 0);
  const sum = done.reduce((s, t) => s + t.net, 0);
  const byDate = {};
  for (const t of trades) {
    const k = t.date;
    byDate[k] = byDate[k] || { date: k, count: 0, settled: 0, wins: 0, sumNet: 0 };
    byDate[k].count++;
    if (t.settled && t.net != null) {
      byDate[k].settled++;
      if (t.net > 0) byDate[k].wins++;
      byDate[k].sumNet = r2(byDate[k].sumNet + t.net);
    }
  }
  const summary = {
    total: trades.length,
    settled: done.length,
    pending: trades.length - done.length,
    wins: wins.length,
    winRate: done.length ? r2((wins.length / done.length) * 100) : null,
    avgNet: done.length ? r2(sum / done.length) : null,
    sumNet: r2(sum),
    daily: Object.values(byDate).sort((a, b) => (a.date < b.date ? 1 : -1))
      .map((d) => ({ ...d, avgNet: d.settled ? r2(d.sumNet / d.settled) : null })),
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(LEDGER, JSON.stringify({ updatedAt: new Date().toISOString(), fee: FEE, summary, trades }, null, 1));
  console.log(`[pnl] 台账 ${trades.length} 笔（已结算 ${done.length}，待结算 ${trades.length - done.length}）`
    + `；胜率 ${summary.winRate}%，平均每笔 ${summary.avgNet}%，合计 ${summary.sumNet}%`);
}

main().catch((e) => { console.error('[pnl] 异常', e); process.exit(1); });

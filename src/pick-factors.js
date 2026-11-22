// 买票清单的「叠加特征」打分。
//
// 干的事：给清单里每一只票，按买点那一天之前已经收盘的日线，补算几个特征值并打分，
// 让用户一眼看出这只票是「多重条件同时满足」还是「只沾了一个边」。
//
// 三条不能破的规矩：
//   ① 因子只能取买点日之前收盘的日线。当天收盘价、当天最高最低都不能用，
//      否则等于拿后来的结果去解释当时的选择，看着漂亮、实际没用。
//   ② 这里只做「标注」，不改清单里任何一条选股结果。清单记的是当时发生了什么，
//      事后只能往旁边加注释，不能把原样改掉。
//   ③ 打分只用于排序和提示，不作为买卖建议。
import { loadDailyTail } from './db.js';

// 四个特征的阈值，全部来自此前对「策略自己选出来的票」做的分组统计
// （注意：不是拿全市场所有票统计，那个口径会得出相反结论）。
export const FACTOR_RULES = {
  ret1Up: 0,      // 买点日前一天收盘是涨的
  amp5Max: 2.7,   // 前 5 个交易日的平均振幅，越小说明越收敛
  ma5SlopeMax: 0, // 5 日线相比前 5 个交易日的位置，小于 0 表示均线在往下走（缩量回踩）
  aboveMA60Min: 0, // 收盘价相对 60 日均线，大于 0 表示还站在中期均线上方
};

const MIN_BARS = 25;   // 60 日均线至少要 60 根，但清单里的票大多上市已久；低于这个数直接标「数据不足」
const TAIL_BARS = 90;

function mean(a) {
  if (!a.length) return NaN;
  let s = 0;
  for (const v of a) s += v;
  return s / a.length;
}

function toDash(d) {
  const s = String(d || '');
  return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s;
}

// 对单只票算特征。prevDate 是买点日（YYYY-MM-DD），只取它之前的行。
function computeOne(code, prevDate) {
  let rows;
  try {
    rows = loadDailyTail(code, 'qfq', TAIL_BARS);
  } catch {
    return { error: 'no-data' };
  }
  const prev = (rows || []).filter((r) => r && r.date < prevDate && Number(r.close) > 0);
  if (prev.length < MIN_BARS) return { error: 'short-history' };

  const close = prev.map((r) => Number(r.close));
  const vol = prev.map((r) => Number(r.vol) || 0);
  const last = close[close.length - 1];

  const ma = (n) => mean(close.slice(-n));
  const ma5 = ma(5);
  const ma5Prev = mean(close.slice(-10, -5));
  const ma20 = ma(20);
  const ma60 = prev.length >= 60 ? ma(60) : NaN;

  const hi20 = Math.max(...close.slice(-20));
  const lo20 = Math.min(...close.slice(-20));

  const amp5 = mean(prev.slice(-5).map((r) => {
    const h = Number(r.high) || 0;
    const l = Number(r.low) || 0;
    const c = Number(r.close) || 0;
    return c > 0 && h > 0 && l > 0 ? ((h - l) / c) * 100 : 0;
  }));

  const vol5 = mean(vol.slice(-5));
  const vol20 = mean(vol.slice(-20));

  const ret1 = close.length >= 2 ? (last / close[close.length - 2] - 1) * 100 : NaN;
  const ret5 = close.length >= 6 ? (last / close[close.length - 6] - 1) * 100 : NaN;

  const f = {
    ret1,
    ret5,
    amp5,
    ma5up: ma5Prev > 0 ? (ma5 / ma5Prev - 1) * 100 : NaN,
    aboveMA20: ma20 > 0 ? (last / ma20 - 1) * 100 : NaN,
    aboveMA60: ma60 > 0 ? (last / ma60 - 1) * 100 : NaN,
    pos20: hi20 > lo20 ? ((last - lo20) / (hi20 - lo20)) * 100 : NaN,
    volRatio: vol20 > 0 ? vol5 / vol20 : NaN,
  };

  const R = FACTOR_RULES;
  const checks = {
    ret1Up: Number.isFinite(f.ret1) && f.ret1 > R.ret1Up,
    amp5Tight: Number.isFinite(f.amp5) && f.amp5 < R.amp5Max,
    ma5Down: Number.isFinite(f.ma5up) && f.ma5up < R.ma5SlopeMax,
    aboveMA60: Number.isFinite(f.aboveMA60) && f.aboveMA60 > R.aboveMA60Min,
  };
  f.checks = checks;
  f.score = Object.values(checks).filter(Boolean).length;
  // 「三个条件同时成立」是此前统计里表现最好的一组；第 4 条（站上中期均线）
  // 加进去反而变差，所以单独展示、不计入通过判定。
  f.pass = checks.ret1Up && checks.amp5Tight && checks.ma5Down;
  f.asOf = prev[prev.length - 1].date;
  return f;
}

// 清单可能上百只，同一份清单在翻页/刷新时会被反复请求，算过的就存下来。
// 键里带买点日：同一只票在 11-18 和 11-19 用的日线不一样，不能混。
const cache = new Map();

export function annotatePicks(picks, baseDate) {
  const list = Array.isArray(picks) ? picks : [];
  if (!list.length) return { picks: [], summary: null };
  const prevDate = toDash(String(baseDate || '').replace(/\D/g, '').slice(0, 8))
    || toDash(String((list[0] && list[0].baseDate) || '').replace(/\D/g, '').slice(0, 8));

  let passed = 0;
  let scored = 0;
  let sumScore = 0;
  const out = list.map((p) => {
    if (!prevDate) return p;
    const key = `${p.code}|${prevDate}`;
    let f = cache.get(key);
    if (f === undefined) {
      f = computeOne(p.code, prevDate);
      cache.set(key, f);
      if (cache.size > 4000) cache.clear();   // 清单一般百来只，兜底防极端情况堆内存
    }
    if (!f || f.error) return Object.assign({}, p, { factors: null });
    scored++;
    sumScore += f.score;
    if (f.pass) passed++;
    return Object.assign({}, p, { factors: f, score: f.score, pass: f.pass });
  });

  return {
    picks: out,
    summary: {
      baseDate: prevDate,
      total: list.length,
      scored,
      passed,
      avgScore: scored ? Math.round((sumScore / scored) * 100) / 100 : null,
      rules: FACTOR_RULES,
    },
  };
}

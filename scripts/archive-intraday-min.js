#!/usr/bin/env node
// 收盘后把「当天买票清单里的票」的 1 分钟分时存档到 data/intraday-min/YYYY-MM-DD/。
//
// 为什么只存清单里的票、不存全市场：
//   ① 全市场 5500 多只逐只拉，上游会限流，一次要跑半小时以上；
//   ② 全市场每天 1 分钟数据上千兆，磁盘只剩几个 G，撑不了几天；
//   ③ 真正要看分时的是「当时被选中的票」，别的票没有买点，存了也没人看。
// 以后要复盘某只没被选中的票，腾讯 day/query 能回溯最近 5 个交易日，够用。
//
// 用法：
//   node scripts/archive-intraday-min.js            # 归档今天
//   node scripts/archive-intraday-min.js 2026-11-19 # 归档指定日期（补档）
//   node scripts/archive-intraday-min.js --force    # 已存在的文件也覆盖重拉
//
// 存盘格式（单只一个文件，字段刻意精简，控制体积）：
//   { code, name, date, prevClose, points:[[hhmm, price, vol], ...] }
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPicks, listPickDates } from '../src/intraday-picks.js';
import { fetchTimeline } from '../src/quotes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_ROOT = path.join(__dirname, '..', 'data', 'intraday-min');
const CONCURRENCY = 4;

function argDate() {
  const a = process.argv.slice(2).find((s) => /^\d{4}-\d{2}-\d{2}$/.test(s));
  return a || '';
}

function todayCst() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return fmt.format(new Date());
}

function toYmd(dash) {
  return String(dash || '').replace(/\D/g, '').slice(0, 8);
}

async function main() {
  const force = process.argv.includes('--force');
  const date = argDate() || todayCst();
  const ymd = toYmd(date);
  if (!ymd) { console.error('日期不合法'); process.exit(1); }

  const doc = readPicks(date);
  const picks = doc.picks || [];
  if (!picks.length) {
    console.log(`[archive-min] ${date} 没有买票清单，跳过`);
    return;
  }

  const dir = path.join(OUT_ROOT, date);
  fs.mkdirSync(dir, { recursive: true });

  let ok = 0, reused = 0, fail = 0;
  const failures = [];
  const queue = picks.slice();
  const t0 = Date.now();

  async function worker() {
    while (queue.length) {
      const p = queue.shift();
      const code = p.code;
      const file = path.join(dir, `${code}.json`);
      if (!force && fs.existsSync(file)) { reused++; continue; }
      try {
        const tl = await fetchTimeline(code, { date: ymd });
        if (!tl || !tl.points || !tl.points.length) throw new Error('分时为空');
        // 只留 [时间, 价格, 该分钟量]，日后再算均价可以用价格+量近似，
        // 精确均价另有 amount 可回溯（历史 5 日内）。
        const points = tl.points.map((pt) => [pt.t, pt.price, pt.vol == null ? 0 : pt.vol]);
        const out = {
          code,
          name: p.name || '',
          date: tl.date || ymd,
          prevClose: tl.prevClose == null ? (p.prevClose == null ? null : p.prevClose) : tl.prevClose,
          triggerTime: p.triggerTime || null,
          triggerPrice: p.triggerPrice == null ? null : p.triggerPrice,
          points,
        };
        fs.writeFileSync(file, JSON.stringify(out));
        ok++;
      } catch (e) {
        fail++;
        failures.push(`${code} ${e.message || e}`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[archive-min] ${date} 清单 ${picks.length} 只：新存 ${ok}，已存在 ${reused}，失败 ${fail}，用时 ${secs}s`);
  if (failures.length) console.log('  失败：' + failures.slice(0, 20).join(' / '));

  // 顺带把「有清单但没存档」的近几日补齐（腾讯只回溯 5 个交易日，更早的拉不到）
  const missing = listPickDates(6).filter((d) => d !== date && d >= '2026-11-01'
    && !fs.existsSync(path.join(OUT_ROOT, d)));
  if (missing.length && !argDate()) {
    console.log(`[archive-min] 另有 ${missing.length} 个清单日期没有存档：${missing.join(', ')}（如需补档手动指定日期）`);
  }
}

main().catch((e) => { console.error('[archive-min] 异常', e); process.exit(1); });

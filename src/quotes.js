// 实时行情代理：直连腾讯 qt.gtimg.cn（与 kline 项目同源数据）。
// kline 项目里那段 qt.gtimg.cn 只用来批量取股票名字，并未对外暴露行情接口，
// 所以这里补一个轻量代理：GBK 解码 → 字段解析 → 短缓存，避免多个前端轮询打爆上游。
import https from 'node:https';

const QUOTE_HOST = 'qt.gtimg.cn';
const CACHE_TTL_MS = 2000;   // 2 秒内复用，挡住同一页面内的并发轮询；需小于前端 3 秒节奏才能每次都拿到新价
const MAX_BATCH = 60;        // 单次上游请求代码数上限
const TIMEOUT_MS = 4000;

const _cache = new Map();    // key: batchKey -> { at, data }
const _pending = new Map();  // key: batchKey -> Promise，合并同一批并发请求

// 只接受带市场前缀的代码（库里 code 本身即 sz000807 / sh600000 / bj920003 形式）
function normalizeCode(raw) {
  const s = String(raw || '').trim().toLowerCase();
  return /^[a-z]{2}\d{6}$/.test(s) ? s : null;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// 腾讯时间字段形如 20261014161500 → 2026-10-14
function toDate(ts) {
  const s = String(ts || '');
  if (s.length < 8) return '';
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

function parseQuotes(text) {
  const out = [];
  const re = /v_([a-z]{2}\d{6})="([^"]*)"/g;
  let m;
  while ((m = re.exec(text))) {
    const code = m[1];
    const f = m[2].split('~');
    if (f.length < 40) continue;
    const price = num(f[3]);
    const prevClose = num(f[4]);
    const open = num(f[5]);
    const high = num(f[33]);
    const low = num(f[34]);
    const volRaw = num(f[36]);       // 手；但科创板上游给的是「股」，下面按成交额反推折算
    const amountWan = num(f[37]);    // 万元
    const turnover = num(f[38]);     // 换手率 %
    const suspended = !(price != null && price > 0);
    const effective = suspended ? prevClose : price;
    // 成交量单位归一到「手」：与分时接口一样，用「成交额 ÷ 成交量」反推，
    // 哪个除数更贴近现价就按哪个折算。若不折算，科创板均价会变成价格的百分之一。
    let volDiv = 1;
    if (volRaw > 0 && amountWan > 0) {
      const pxRef = effective > 0 ? effective : prevClose;
      if (pxRef > 0) {
        const amt = amountWan * 10000;
        const asHand = Math.abs(amt / (volRaw * 100) / pxRef - 1);
        const asShare = Math.abs(amt / volRaw / pxRef - 1);
        volDiv = asHand <= asShare ? 1 : 100;
      }
    }
    const vol = volRaw != null ? volRaw / volDiv : null;
    let change = num(f[31]);
    let pct = num(f[32]);
    if (change == null && prevClose != null && effective != null) change = effective - prevClose;
    if (pct == null && prevClose) pct = (effective - prevClose) / prevClose * 100;
    out.push({
      code,
      name: f[1] || '',
      price: effective,
      prevClose,
      open, high, low,
      change, pct,
      vol,                                     // 手，与库内 vol 同口径
      amount: amountWan != null ? amountWan * 10000 : null,  // 元，与库内 amount 同口径
      turnover,
      suspended,
      time: f[30] || '',
      date: toDate(f[30]),
    });
  }
  return out;
}

function requestBatch(codes) {
  return new Promise((resolve, reject) => {
    const req = https.get({
      host: QUOTE_HOST,
      path: `/q=${codes.join(',')}`,
      timeout: TIMEOUT_MS,
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://gu.qq.com/' },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          const text = new TextDecoder('gbk').decode(Buffer.concat(chunks));
          resolve(parseQuotes(text));
        } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('quote timeout')));
    req.on('error', reject);
  });
}

async function fetchChunk(codes) {
  const key = codes.join(',');
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;
  const inflight = _pending.get(key);
  if (inflight) return inflight;
  const task = requestBatch(codes).then((data) => {
    _cache.set(key, { at: Date.now(), data });
    if (_cache.size > 200) {
      const cutoff = Date.now() - CACHE_TTL_MS * 4;
      for (const [k, v] of _cache) if (v.at < cutoff) _cache.delete(k);
    }
    return data;
  }).finally(() => _pending.delete(key));
  _pending.set(key, task);
  return task;
}

// ---------- 当日分时（时间-价格曲线）----------
// 注意：分时走的是腾讯另一套域名，和行情接口（qt.gtimg.cn）不是同一个网关。
// web.ifzq.gtimg.cn 有 WAF，实测连发 100 次 100 次被 501 拦；
// proxy.finance.qq.com/ifzqgtimg 是腾讯 App 自用的网关，同样连发 100 次全部通过。
// 所以这里固定用 proxy 域名，不要改回 web.ifzq。
const TIMELINE_HOST = 'proxy.finance.qq.com';
const TIMELINE_PREFIX = '/ifzqgtimg/appstock/app/minute/query';
// 历史分时：同一网关的日列表接口，一次返回最近 5 个交易日的完整分钟串。
// 用它而不是给 minute/query 加日期参数——后者实测忽略日期、永远只给最新交易日。
const TIMELINE_DAY_PREFIX = '/ifzqgtimg/appstock/app/day/query';
const TIMELINE_TTL_MS = 2000;   // 盘中同一只 2s 内复用，挡住多端并发
const TIMELINE_HIST_TTL_MS = 60000; // 历史某日不会再变，缓存可以放长
const TIMELINE_ERR_TTL_MS = 8000; // 失败结果 8s 内不重试：上游故障时别让 3s 轮询把它打死

const _tlCache = new Map();     // code -> { at, data }
const _tlPending = new Map();   // code -> Promise

// 解析分时点："0930 25.39 1586 4026854.00" → { t:'0930', price, vol, amount }
// vol 是当日累计成交量（手），amount 是当日累计成交额（元）。
// 腾讯给的序列含 15:00 之后的盘后固定价格交易（约 25 个点），
// 那部分不属于正常交易时段，画在分时图上会拖出一条平线，这里直接截掉。
// wantDate（8 位数字）只在取历史某日时传，当天实时不传。
// minute/query 返回 node.data = { date, data:[...] }，只给最新交易日；
// day/query 返回 node.data = [{ date, prec, data:[...] }, ...]，一次给最近 5 个交易日。
// 两套接口的分钟串格式完全一致，所以解析只有这一份。
function parseTimeline(text, code, wantDate) {
  let json;
  try { json = JSON.parse(text); } catch { return null; }
  const node = json && json.data && json.data[code];
  if (!node || !node.data) return null;
  let date, raw, precHint = null;
  if (Array.isArray(node.data)) {
    const want = wantDate ? String(wantDate).replace(/\D/g, '').slice(0, 8) : '';
    const hit = want ? node.data.find((d) => String((d && d.date) || '') === want) : node.data[0];
    if (!hit || !Array.isArray(hit.data)) return null;
    date = String(hit.date || '');
    raw = hit.data;
    precHint = hit.prec != null ? num(hit.prec) : null;
  } else {
    if (!Array.isArray(node.data.data)) return null;
    date = String(node.data.date || '');
    raw = node.data.data;
  }

  // 成交量单位探测：上游对科创板（sh688/sh689）返回的累计量是「股」，
  // 其余板块（含北交所 bj）是「手」，两者差 100 倍。若不分板块统一，均价会被算成
  // 价格的三十分之一，分时图纵轴被迫按均价缩放，整条曲线被压成一条平线。
  // 优先用「成交额 ÷ 累计量」反推哪个除数更接近现价，自动判定；
  // 北交所分时不给成交额（每行只有 3 个字段），探测循环跳过，此时按板块兜底：
  //   科创板 → 股（除数 100），北交所/其余 → 手（除数 1，已实测 bj920006 返回值=手）。
  const isStar = code.startsWith('sh688') || code.startsWith('sh689');
  const isBj = code.startsWith('bj');
  let volDivisor = (isStar && !isBj) ? 100 : 1;   // 探测不到成交额时的板块兜底
  for (let i = raw.length - 1; i >= 0; i--) {
    const f = String(raw[i]).trim().split(/\s+/);
    if (f.length < 4) continue;
    const px = num(f[1]);
    const v = num(f[2]);
    const a = num(f[3]);
    if (!(px > 0) || !(v > 0) || !(a > 0)) continue;
    const asHand = Math.abs(a / (v * 100) / px - 1);   // 视 v 为「手」
    const asShare = Math.abs(a / v / px - 1);          // 视 v 为「股」
    volDivisor = asHand <= asShare ? 1 : 100;
    break;
  }

  const pts = [];
  let prevVol = 0;
  let prevAmount = 0;
  for (const line of raw) {
    const f = String(line).trim().split(/\s+/);
    if (f.length < 3) continue;
    const t = f[0];
    if (!/^\d{4}$/.test(t)) continue;
    const minute = Number(t.slice(0, 2)) * 60 + Number(t.slice(2));
    // 09:30-11:30 / 13:00-15:00 之外（含盘后固定价交易）一律丢弃
    const inSession = (minute >= 570 && minute <= 690) || (minute >= 780 && minute <= 900);
    if (!inSession) continue;
    const price = num(f[1]);
    const rawCumVol = num(f[2]);
    const cumAmount = num(f[3]);
    if (price == null || rawCumVol == null) continue;
    // 统一折算成「手」，与库内 vol 口径一致
    const cumVol = rawCumVol / volDivisor;
    // 累计量在 11:30→13:00 之间不增长，午休后可能会出现负增量，钳到 0
    const vol = Math.max(0, cumVol - prevVol);
    const amount = cumAmount != null ? Math.max(0, cumAmount - prevAmount) : null;
    prevVol = cumVol;
    prevAmount = cumAmount || 0;
    pts.push({
      t,                                     // 'HHMM'，前端按固定槽位摆放
      price,
      // 均价 = 累计成交额 ÷ 累计成交股数；北交所分时不给成交额，退化为现价
      avg: cumAmount != null && cumVol > 0 ? cumAmount / (cumVol * 100) : price,
      vol,                                   // 本分钟量（手）
      cumVol,
    });
  }
  if (!pts.length) return null;
  // 前收价从 qt 快照里取（字段 4），供分时图基准线与涨跌幅使用。
  // 历史分时走 day/query，qt 是空的，退用该日节点自带的 prec。
  let prevClose = precHint;
  if (prevClose == null) {
    try {
      const q = node.qt && node.qt[code];
      if (Array.isArray(q) && q.length > 4) prevClose = num(q[4]);
    } catch { /* 忽略 */ }
  }
  return { code, date, prevClose, points: pts };
}

function requestTimeline(code, wantDate) {
  const useDay = !!wantDate;
  return new Promise((resolve, reject) => {
    const req = https.get({
      host: TIMELINE_HOST,
      path: useDay
        ? `${TIMELINE_DAY_PREFIX}?code=${encodeURIComponent(code)}`
        : `${TIMELINE_PREFIX}?code=${encodeURIComponent(code)}`,
      timeout: TIMEOUT_MS,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) { reject(new Error(`timeline http ${res.statusCode}`)); return; }
        const data = parseTimeline(text, code, useDay ? wantDate : '');
        if (!data) { reject(new Error('timeline parse failed')); return; }
        resolve(data);
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeline timeout')));
    req.on('error', reject);
  });
}

// 取单只分时。不传 date 就是当日实时（2s 缓存 + in-flight 去重 + 失败短负缓存）；
// 传 date（8 位数字）就取历史某日（day/query，一次给最近 5 个交易日，缓存久一些）。
export async function fetchTimeline(rawCode, opts) {
  const code = normalizeCode(rawCode);
  if (!code) throw new Error('invalid code');
  const wantDate = String((opts && opts.date) || '').replace(/\D/g, '').slice(0, 8);
  const key = wantDate ? `${code}@${wantDate}` : code;
  const okTtl = wantDate ? TIMELINE_HIST_TTL_MS : TIMELINE_TTL_MS;
  const hit = _tlCache.get(key);
  if (hit) {
    // 负缓存：失败结果只保留几秒。上游挂掉/WAF 抽风时，
    // 前端 3 秒节奏会一秒不差地重试穿透，必须挡住，但不能挡太久（恢复后要能自愈）。
    const ttl = hit.err ? TIMELINE_ERR_TTL_MS : okTtl;
    if (Date.now() - hit.at < ttl) {
      if (hit.err) throw hit.err;
      return hit.data;
    }
  }
  const inflight = _tlPending.get(key);
  if (inflight) return inflight;
  const task = requestTimeline(code, wantDate).then((data) => {
    _tlCache.set(key, { at: Date.now(), data });
    if (_tlCache.size > 120) {
      const cutoff = Date.now() - TIMELINE_HIST_TTL_MS * 2;
      for (const [k, v] of _tlCache) if (v.at < cutoff) _tlCache.delete(k);
    }
    return data;
  }, (err) => {
    _tlCache.set(key, { at: Date.now(), err });
    throw err;
  }).finally(() => _tlPending.delete(key));
  _tlPending.set(key, task);
  return task;
}

// 批量取行情：自动去重、限长、分批并发；单批失败不影响其余批次。
export async function fetchQuotes(rawCodes) {
  const codes = [...new Set((rawCodes || []).map(normalizeCode).filter(Boolean))];
  if (!codes.length) return [];
  const batches = [];
  for (let i = 0; i < codes.length; i += MAX_BATCH) batches.push(codes.slice(i, i + MAX_BATCH));
  const settled = await Promise.allSettled(batches.map(fetchChunk));
  const out = [];
  for (const s of settled) if (s.status === 'fulfilled') out.push(...s.value);
  if (!out.length && settled.every((s) => s.status === 'rejected')) {
    throw settled[0].reason || new Error('quote failed');
  }
  return out;
}

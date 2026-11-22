/* 复盘数据页签：按股票代码加载本地证据，做逐笔统计与明细（挂在看盘抽屉的「数据」页签里）。
 *
 * 口径与 ev301557.js 完全一致：
 *  - 数据源按代码取：301557→ev301557-data.json、603186→ev603186-data.json（只读，前端只做「读字段 + 求和」）。
 *  - 统计函数与 6 卡 4 表直接复刻 ev301557.js 45-65 / 235-301，两票共用同一套。
 *  - 净收益 = net（已扣双边费用），前端不再扣。
 *  - 只有证据清单（EVIDENCE_CODES）里的股票有证据；其余显示「暂无数据」，不套用。
 *
 * window.RVData 对外暴露的少量接口：
 *  - show({ code, name })：进入数据页签时渲染（code 可带前缀，内部取纯 6 位判断）。
 *  - hideSubmin() / showSubmin({ code, label, rect })：日K点日期弹出的分时浮层。
 *  - close()：数据页签离开时清理（隐藏浮层、隐藏数据容器由 app.js 管）。
 */
(function () {
  'use strict';

  const EVIDENCE_CODES = ['301557', '603186']; // 有本地逐笔/分钟证据的股票代码（复用同一套渲染，仅取数文件不同）
  const EVIDENCE_FILE = { '301557': './ev301557-data.json', '603186': './ev603186-data.json' };

  const C_BUY = '#3fd68b';
  const C_SELL = '#ff5a76';
  const C_HIT = '#e8a33d';
  const C_SKIP = '#8f9a95';
  const C_LINE = '#d8e0dd';
  const C_HI = 'rgba(120,170,255,.55)';
  const C_LO = 'rgba(120,170,255,.32)';
  const C_PREV = '#4a5b56';

  const KIND_TXT = {
    TARGET: '触及即卖',
    OPEN_GAP: '开盘跳空卖',
    NOHIT_CLOSE: '未触及·收盘卖',
  };
  const GATE_TXT = { HPR_LT1: '高昨比<1%', BELOW_MA: '跌破MA5与MA20' };

  // 重算引擎的出场方式中文标签（按触发顺序排列）
  const RKIND_TXT = { TP: '止盈', SL: '止损', NONE: '未触发·收盘卖' };
  const RKIND_ORDER = [RKIND_TXT.TP, RKIND_TXT.SL, RKIND_TXT.NONE];

  const el = (id) => document.getElementById(id);
  const plainCode = (c) => String(c || '').replace(/^[a-z]{2}/i, '');

  let D = null;            // 当前股票的证据数据（按 code 从 EVIDENCE_FILE 取）
  let D_code = '';         // D 属于哪只票（纯 6 位代码），避免多票缓存时误用
  const evidenceCache = {}; // { '301557': {...}, '603186': {...} } 按代码缓存证据
  let curCode = '';        // 当前展示的纯 6 位代码
  let subminChart = null;  // 分时浮层 ECharts 实例
  let subminOpen = false;
  let subminCrossOn = true;   // 浮层十字线（含横线）显示开关，点击浮层切换
  // 分时浮层：当前展示的日期下标与「有分时数据的日期列表」（重算后可翻看任意一天）。
  let subminDateIdx = -1;
  let subminDates = [];
  let subminCode = '';     // 当前浮层对应的纯 6 位代码
  // 最近一次重算结果（含每笔的出场明细），供列表/数据页签/分时标注复用。
  let lastRecompute = null;
  // 重算结果缓存：{ '301557': {...}, '603186': {...} }，按代码存，方案汇总/列表按代码取各自的重算值。
  const rcCache = {};
  // 重算参数：默认复现原口径（止盈 1%，不设止损）。
  let rcParams = { tpPct: 1, slMode: 'none', slPct: -2 };

  /* ---------- 小工具（复刻 ev301557.js 45-65） ---------- */
  const fmt = (x, d) => (x == null || !isFinite(x)) ? '—' : (x >= 0 ? '+' : '') + x.toFixed(d == null ? 2 : d) + '%';
  const cls = (x) => x > 0 ? 'pos' : (x < 0 ? 'neg' : '');
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const med = (a) => {
    const b = [...a].sort((x, y) => x - y), m = b.length >> 1;
    return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2;
  };
  const cum = (a) => a.reduce((x, y) => x * (1 + y / 100), 1) * 100 - 100;

  function stats(list) {
    if (!list.length) return null;
    const v = list.map((t) => t.net);
    return {
      n: v.length, mean: mean(v), med: med(v),
      win: 100 * v.filter((x) => x > 0).length / v.length,
      cum: cum(v),
    };
  }

  const isBought = (t) => !t.gates || !t.gates.length;
  const gateLabel = (t) => (t.gates || []).map((g) => GATE_TXT[g] || g).join(' + ');
  // 是否买入：重算记录带 boolean bought，静态记录按 gates 判断。
  const recIsBought = (t) => (typeof t.bought === 'boolean') ? t.bought : isBought(t);

  /* ---------- 参数可调回测引擎（前端重算，只对有分钟证据的票有效） ----------
   *
   * 数据限制（必须明示，不要藏）：
   *  - 分钟序列只有收盘价（days），highs/lows/opens 都是 days 的副本，不是真分钟高低开。
   *    所以止盈/止损都按「该分钟收盘价」判定，无法判断分钟内瞬时高低点，精度受限。
   *  - 同一分钟既触止盈又触止损时无法分辨先后，沿用「止盈优先」（原口径就是止盈优先）。
   *  - 本引擎只对证据清单（EVIDENCE_CODES）里、有分钟证据的票有效，其他票无分钟数据。
   *
   * 参数：
   *  - tpPct：止盈百分比（%），默认 1（复现原口径）。
   *  - slMode：'none' 不设止损（默认，复现原口径）；
   *            'minute' 固定百分比止损（按 T1 分钟收盘价 ≤ 触发价即止损卖出）；
   *            'close' 收盘价止损卖出（不用分钟线判止损，只在 T1 收盘用日线收盘判断：
   *                    若 T1 收盘跌幅 ≤ stopPct 则按 T1 收盘卖（止损），否则未触发按收盘卖。
   *                    止盈始终优先：若盘中止盈先触发则按止盈卖，不看收盘止损）。
   *  - slPct：止损百分比（%），如 -2、-3。
   */
  function recomputeEngine(params) {
    if (!D) throw new Error('证据数据尚未加载');
    const tpPct = Number(params && params.tpPct);
    const slMode = (params && params.slMode) || 'none';
    const slPct = Number(params && params.slPct);
    const useTp = isFinite(tpPct);
    const tpP = useTp ? tpPct : 1;
    const useMinuteSl = slMode === 'minute' && isFinite(slPct);
    const useCloseSl = slMode === 'close' && isFinite(slPct);
    const slP = slPct;

    const out = [];
    for (let k = 0; k < D.all.length; k++) {
      const t = D.all[k];
      const rec = {
        n: t.n, T: t.T, T1: t.T1, buy: t.buy,
        hpr: t.hpr, hprAvg100: t.hprAvg100, hprGt1Pct100: t.hprGt1Pct100,
        gates: t.gates || [], p0: t.p0,
        // 原静态字段（可能被覆盖）
        kind: t.kind, et: t.et, thr: t.thr, hit_t: t.hit_t, hit_p: t.hit_p,
        gross: t.gross, net: t.net,
      };
      const bought = isBought(t);
      rec.bought = bought;
      if (!bought) {
        // 被过滤的笔：不买入、不计收益，但保留对照走势（按原静态 net 展示对照）。
        out.push(rec);
        continue;
      }

      const buy = t.buy;
      const tpThr = useTp ? +(buy * (1 + tpP / 100)) : null;
      const slThr = useMinuteSl ? +(buy * (1 + slP / 100)) : null;
      const day = D.days[t.T1] || [];
      const last = day.length - 1;

      let sellPrice = null;   // 成交价
      let sellMin = null;     // 触发分钟下标
      let et = null;          // 触发分钟标签
      let kind = 'NONE';      // 'TP' | 'SL' | 'NONE'
      let hitIdx = null;      // 触发时刻下标（止盈/止损/收盘）
      let hitPrice = null;    // 触发时刻价格
      let thrUsed = null;     // 实际使用的触发价（止盈或止损，用于画触发线）

      if (day.length) {
        // 止盈优先：逐分钟扫描（09:31→15:00），止盈一旦触发就按止盈卖（不设未来函数）。
        for (let i = 0; i < day.length; i++) {
          const c = day[i];
          if (c == null) continue;
          if (useTp && c >= tpThr) {
            sellPrice = c; sellMin = i; et = D.slots[i];
            kind = 'TP'; hitIdx = i; hitPrice = c; thrUsed = tpThr;
            break;
          }
        }
        // 止盈没触发（或未启用止盈）→ 再看盘中止损：
        // 固定百分比止损按分钟收盘价 ≤ 触发价触发（谁先触发用谁，止盈已优先）。
        if (sellPrice == null && useMinuteSl) {
          for (let i = 0; i < day.length; i++) {
            const c = day[i];
            if (c == null) continue;
            if (c <= slThr) {
              sellPrice = c; sellMin = i; et = D.slots[i];
              kind = 'SL'; hitIdx = i; hitPrice = c; thrUsed = slThr;
              break;
            }
          }
        }
        // 收盘价止损卖出：不用分钟线判止损，只在收盘看日线收盘。
        // 仅当止盈没触发时生效（止盈优先）：T1 收盘跌幅 ≤ stopPct → 按 T1 收盘卖（止损）。
        if (sellPrice == null && useCloseSl) {
          const closeP = day[last];
          if (closeP != null && closeP <= buy * (1 + slP / 100)) {
            sellPrice = closeP; sellMin = last; et = D.slots[last];
            kind = 'SL'; hitIdx = last; hitPrice = closeP;
            thrUsed = buy * (1 + slP / 100);
          }
        }
      }

      // 全天没触发止盈/止损 → T1 收盘卖（15:00 分钟收盘，未触发）。
      if (sellPrice == null && day.length) {
        const closeP = day[last];
        if (closeP != null) {
          sellPrice = closeP; sellMin = last; et = D.slots[last];
          kind = 'NONE'; hitIdx = last; hitPrice = closeP;
          thrUsed = useTp ? tpThr : (useMinuteSl ? slThr : null);
        }
      }

      if (sellPrice == null) {
        // 防御：无分钟数据时回退原静态卖出（一般不会走到）
        sellPrice = t.sell; et = t.et; kind = t.kind === 'NOHIT_CLOSE' ? 'NONE' : (t.kind === 'OPEN_GAP' ? 'TP' : 'TP');
        hitIdx = D.slots.indexOf(et); hitPrice = sellPrice;
        thrUsed = useTp ? tpThr : (useMinuteSl ? slThr : null);
      }

      const gross = (sellPrice / buy - 1) * 100;
      const net = gross - D.fee;

      rec.kind = kind;
      rec.et = et;
      rec.sell = sellPrice;
      rec.hit_t = et;
      rec.hit_p = hitPrice;
      rec.sellMin = sellMin;
      rec.hitIdx = hitIdx;
      rec.thr = thrUsed;
      rec.gross = gross;
      rec.net = net;
      out.push(rec);
    }

    // 汇总：只对实际买入的笔（bought）统计
    const boughtRecs = out.filter((r) => r.bought);
    const nets = boughtRecs.map((r) => r.net);
    const wins = nets.filter((x) => x > 0);
    const losses = nets.filter((x) => x < 0);
    const stat = stats(boughtRecs);
    const p = nets.length ? wins.length / nets.length : 0;
    const avgWin = wins.length ? mean(wins) : 0;
    const avgLoss = losses.length ? mean(losses) : 0;
    const b = avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : 0;
    const f = (b > 0 && nets.length) ? (p * b - (1 - p)) / b : null;

    return {
      params: { tpPct: tpP, slMode, slPct: slP },
      fee: D.fee,
      n: stat ? stat.n : 0,
      win: stat ? stat.win : null,
      mean: stat ? stat.mean : null,
      med: stat ? stat.med : null,
      cum: stat ? stat.cum : null,
      avgWin: wins.length ? avgWin : 0,
      avgLoss: losses.length ? avgLoss : 0,
      b,
      kelly: f,
      trades: out,                       // 全部 100 笔（含被过滤，供明细/分时标注）
      bought: boughtRecs,                // 实际买入的笔
    };
  }

  // 对外：按当前参数重算，返回 Promise<结果>（含 trades/bought）。调用方负责刷新界面。
  // 若证据还没加载会先加载，保证点「运算」时无需先打开数据页签。
  function recompute(params) {
    const p = params || {};
    rcParams = {
      tpPct: isFinite(Number(p.tpPct)) ? Number(p.tpPct) : 1,
      slMode: (p.slMode === 'minute' || p.slMode === 'close') ? p.slMode : 'none',
      slPct: isFinite(Number(p.slPct)) ? Number(p.slPct) : -2,
    };
    // 计算一只票并把结果存入 rcCache，同时刷新数据页签/分时浮层。
    const runOne = (code) => {
      // 关键：recomputeEngine 读全局 D，必须先把全局数据指回这一只的证据，
      // 否则两只票会共用最后加载的那只（D 停在末尾），把结果算到别人头上。
      if (D_code !== code && evidenceCache[code]) {
        D = evidenceCache[code];
        D_code = code;
      }
      const r = recomputeEngine(rcParams);
      r.code = code;                       // 归属股票：rv.js 按此匹配到对应行
      rcCache[code] = r;                   // 按代码缓存，方案汇总/列表各自取
      // 数据页签正显示这只票则刷新统计卡与明细表。
      if (plainCode(curCode) === code && D) {
        const box = el('chart-data');
        if (box) render(box, curCode);
      }
      // 分时浮层正开着这只票则重画当前日（买卖点随止损变化）。
      if (subminOpen && subminCode === code && subminDates.length) {
        renderSubminDate(subminDates[subminDateIdx] || subminDates[0], null);
      }
      return r;
    };
    // 对全部证据票逐只重算：一次点重算就把 301557 与 603186 都算完，
    // 方案级汇总才能把两只的重算值一起加权合并。
    const all = () => Promise.all(EVIDENCE_CODES.map((c) =>
      (D && D_code === c) ? Promise.resolve() : loadEvidence(c)
    )).then(() => {
      const rs = EVIDENCE_CODES.map(runOne);
      lastRecompute = (plainCode(curCode) && rcCache[plainCode(curCode)]) || rs[rs.length - 1];
      // 关键：runOne 逐票把全局 D 指向各票，跑完停在最后一只；这里必须把全局数据
      // 指回「当前正在展示」的票，否则之后读全局 D 的路径（明细行点击、分时浮层箭头）
      // 会拿到别的票的数据，造成串票。
      const cur = plainCode(subminCode) || plainCode(curCode) || '';
      if (cur && evidenceCache[cur]) { D = evidenceCache[cur]; D_code = cur; }
      return lastRecompute;
    });
    return all();
  }

  /* ---------- 加载证据 ---------- */
  // 按 code 加载对应证据文件；已缓存直接返回。返回 Promise<证据对象>。
  function loadEvidence(code) {
    const c = plainCode(code);
    const file = EVIDENCE_FILE[c];
    if (!file) return Promise.reject(new Error('无本地证据: ' + c));
    if (evidenceCache[c]) { D = evidenceCache[c]; D_code = c; return Promise.resolve(D); }
    return fetch(file, { cache: 'no-store' })
      .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then((d) => { evidenceCache[c] = d; D = d; D_code = c; return d; });
  }

  /* ---------- 6 卡 4 表（复刻 ev301557.js 235-301） ---------- */
  // rc：重算结果（含 trades/bought），为 null 时用静态证据 D.all。
  function renderStats(box, rc) {
    const list = rc ? rc.trades : D.all;
    const bought = list.filter(recIsBought);
    const skipped = list.filter((t) => !recIsBought(t));
    const all = stats(bought);
    const fee = rc ? rc.fee : D.fee;

    const card = (k, v, c) => `<div class="cd-card"><div class="k">${k}</div><div class="v ${c || ''}">${v}</div></div>`;
    // 只把 6 张统计卡写进自己的格子；不能覆盖整个 box，
    // 否则会把 show() 建好的四表/明细容器一并清掉，后面按 id 就找不到了。
    const statsBox = el('rvd-stats');
    if (statsBox) statsBox.innerHTML =
      card('实际买入', all.n + ' 笔') +
      card('平均每笔净收益', fmt(all.mean), cls(all.mean)) +
      card('中位每笔净收益', fmt(all.med), cls(all.med)) +
      card('胜率', all.win.toFixed(1) + '%') +
      card('累计净收益', fmt(all.cum), cls(all.cum)) +
      card('双边成本', fee + '%');

    const row = (nm, s) => s
      ? `<tr><td>${nm}</td><td>${s.n}</td><td class="${cls(s.mean)}">${fmt(s.mean)}</td>` +
        `<td class="${cls(s.med)}">${fmt(s.med)}</td><td>${s.win.toFixed(1)}%</td>` +
        `<td class="${cls(s.cum)}">${fmt(s.cum)}</td></tr>`
      : '';

    // ① 口径对照：不过滤 / 过滤后 / 被过滤
    const g1 = el('rvd-groups');
    if (g1) g1.innerHTML =
      '<div class="cd-tblwrap"><table><thead><tr><th>口径</th><th>笔数</th><th>均值</th><th>中位</th><th>胜率</th><th>累计</th></tr></thead><tbody>' +
      row('原规则（不过滤，100 笔全做）', stats(list)) +
      row('加两条过滤后实际买入', all) +
      row('被过滤掉（只作对照，不买）', stats(skipped)) +
      '</tbody></table></div>';

    // ② 出场方式：静态用原 3 类；重算用止盈/止损/未触发 3 类。
    const g2 = el('rvd-kinds');
    if (g2) {
      let kindsHtml;
      if (rc) {
        kindsHtml =
          row(`止盈（该分钟收盘 ≥ 触发价）`, stats(bought.filter((t) => t.kind === 'TP'))) +
          row(`止损（按分钟收盘触发）`, stats(bought.filter((t) => t.kind === 'SL'))) +
          row(`未触发 → 15:00 收盘卖`, stats(bought.filter((t) => t.kind === 'NONE')));
      } else {
        kindsHtml =
          row('触及 +1% 就该分钟触发价成交', stats(bought.filter((t) => t.kind === 'TARGET'))) +
          row('开盘跳空 ≥ 触发价，按开盘价成交', stats(bought.filter((t) => t.kind === 'OPEN_GAP'))) +
          row('全天未触及 → 15:00 收盘卖', stats(bought.filter((t) => t.kind === 'NOHIT_CLOSE')));
      }
      g2.innerHTML =
        '<div class="cd-tblwrap"><table><thead><tr><th>出场方式</th><th>笔数</th><th>均值</th><th>中位</th><th>胜率</th><th>累计</th></tr></thead><tbody>' +
        kindsHtml +
        '</tbody></table></div>';
    }

    // ③ 被过滤的构成
    const byGate = (fn) => stats(skipped.filter(fn));
    const g3 = el('rvd-gates');
    if (g3) g3.innerHTML =
      '<div class="cd-tblwrap"><table><thead><tr><th>不买入原因</th><th>笔数</th><th>均值</th><th>中位</th><th>胜率</th><th>累计</th></tr></thead><tbody>' +
      row('仅 高昨比 < 1%', byGate((t) => t.gates.length === 1 && t.gates[0] === 'HPR_LT1')) +
      row('仅 收盘同时跌破 MA5/MA20', byGate((t) => t.gates.length === 1 && t.gates[0] === 'BELOW_MA')) +
      row('两条同时成立', byGate((t) => t.gates.length > 1)) +
      '</tbody></table></div>';

    // ④ 高昨比分档（全部 100 笔，看这条门槛的分布）
    const bk = [[-99, 1], [1, 2], [2, 3], [3, 4], [4, 6], [6, 999]];
    let h = '<div class="cd-tblwrap"><table><thead><tr><th>买入日高昨比</th><th>笔数</th><th>均值</th><th>中位</th><th>胜率</th><th>累计</th></tr></thead><tbody>';
    for (const [lo, hiV] of bk) {
      const g = list.filter((t) => t.hpr != null && t.hpr >= lo && t.hpr < hiV);
      const nm = lo < 0 ? '低于 1%（不买）' : (hiV > 900 ? '≥ 6%' : `≥ ${lo}% ~ ${hiV}%`);
      h += row(nm, stats(g));
    }
    h += '</tbody></table></div>';
    const g4 = el('rvd-buckets');
    if (g4) g4.innerHTML = h;

    // 明细表：净收益列放第一，横向滚动。点一行切回日线。
    const g5 = el('rvd-rows');
    if (g5) g5.innerHTML = list.map((t, i) => {
      const isB = recIsBought(t);
      const st = isB
        ? `<span class="ok">买入</span>`
        : `<span class="no">不买·${gateLabel(t)}</span>`;
      // 出场列：静态用原 kind 文案；重算用止盈/止损/未触发文案。
      const kindTxt = rc
        ? (RKIND_TXT[t.kind] || t.kind)
        : (KIND_TXT[t.kind] || t.kind);
      return `<tr data-i="${i}" class="${isB ? '' : 'skip'}">` +
        `<td class="${cls(t.net)}">${fmt(t.net)}</td>` +
        `<td>${t.n}</td><td>${t.T}</td><td>${t.T1}</td>` +
        `<td>${t.buy.toFixed(2)}</td><td>${(t.sell == null ? '—' : t.sell.toFixed(2))}</td>` +
        `<td>${kindTxt}</td>` +
        `<td>${t.hpr == null ? '—' : t.hpr.toFixed(2) + '%'}</td>` +
        `<td class="st">${st}</td></tr>`;
    }).join('');
  }

  /* ---------- 渲染数据页签 ---------- */
  function render(box, code) {
    const pc = plainCode(code);
    if (!box) return;
    if (!EVIDENCE_CODES.includes(pc)) {
      box.innerHTML = '<div class="cd-empty">暂无数据<br><span>仅常友科技(301557)、华正新材(603186)有逐笔复盘证据，其余股票不套用。</span></div>';
      return;
    }
    loadEvidence(pc).then(() => {
      // 加载期间可能又切了股票，按当前展示的代码判断
      if (plainCode(curCode) !== pc) return;
      const sub = el('rvd-sub');
      const rc = rcForCur();
      if (sub) {
        const nb = rc ? rc.n : D.all.filter(isBought).length;
        const p = rc ? rc.params : null;
        let paramTxt;
        if (!p) {
          paramTxt = ' · 静态口径（+1% 止盈，无止损）';
        } else {
          paramTxt = ` · 重算参数：止盈 +${p.tpPct}%`;
          if (p.slMode === 'minute') paramTxt += ` · 止损 ${p.slPct}%（按分钟收盘判定）`;
          else if (p.slMode === 'close') paramTxt += ` · 收盘止损 ${p.slPct}%（按 T1 收盘判定）`;
        }
        sub.textContent = `一分钟口径 · 候选 ${D.all.length} 笔 → 实际买入 ${nb} 笔 · 双边成本 ${D.fee}%（净收益已扣费用）${paramTxt}`;
      }
      // 页脚：静态 vs 重算口径说明
      const foot = el('rvd-foot');
      if (foot) {
        foot.textContent = rc
          ? `按当前参数重算：止盈 +${rc.params.tpPct}%` +
            (rc.params.slMode === 'minute' ? `、固定止损 ${rc.params.slPct}%（按分钟收盘判定）` :
              (rc.params.slMode === 'close' ? `、收盘止损 ${rc.params.slPct}%（按 T1 收盘判定）` : '')) +
            `；分钟数据仅收盘价，止损按分钟收盘触发，同分钟止盈止损冲突时止盈优先；净收益已扣 ${D.fee}% 双边费用。`
          : '所有数字直接取自同一份证据数据，只做求和；净收益已扣 0.083% 双边费用。';
      }
      renderStats(box, rc);
    }).catch((e) => {
      box.innerHTML = '<div class="cd-empty">数据加载失败：' + (e && e.message ? e.message : e) + '</div>';
    });
  }

  /* ---------- 分时浮层 ---------- */
  const slotIdx = (t) => {
    const s = String(t || '').replace(/\D/g, '');
    if (s.length < 4) return null;
    const key = s.slice(0, 2) + ':' + s.slice(2, 4);
    const i = D ? D.slots.indexOf(key) : -1;
    return i < 0 ? null : i;
  };

  function dayOf(dt) {
    return { close: D.days[dt] || [], high: D.highs[dt] || [], low: D.lows[dt] || [] };
  }

  // 智能标签位置：靠近顶部用 bottom，靠底用 top，靠右边缘用 left，其余按时刻在左/下。
  // m.y 相对 yMin/yMax 判断，i 是分钟下标（0=09:31，239=15:00）。
  function smartPos(i, y, yMin, yMax) {
    const h = yMax - yMin;
    const ratio = h > 0 ? (y - yMin) / h : 0.5;
    if (ratio > 0.82) return 'bottom';   // 顶部区域 → 放下方
    if (ratio < 0.18) return 'top';      // 底部区域 → 放上方
    if (i >= 208) return 'left';         // 靠右边缘 → 放左侧，避免出界
    if (i <= 45) return 'right';         // 靠左边缘 → 放右侧
    return 'bottom';
  }

  // thr 传单个数值或数组 [{ y, color, label }]；prevClose 画昨收虚线。
  function dayOption(d, prevClose, marks, thr) {
    const cats = D.slots;
    const hasBand = d.high.some((v, i) => v !== d.close[i]);

    let lo = Infinity, hi = -Infinity;
    for (const p of d.close) if (p != null) { if (p < lo) lo = p; if (p > hi) hi = p; }
    if (hasBand) {
      for (const p of d.high) if (p != null && p > hi) hi = p;
      for (const p of d.low) if (p != null && p < lo) lo = p;
    }
    const base = prevClose != null ? prevClose : ((lo + hi) / 2);
    const dy = Math.max(Math.abs(hi - base), Math.abs(base - lo), base * 0.005);
    const yMin = +(base - dy).toFixed(2), yMax = +(base + dy).toFixed(2);
    const interval = +(((yMax - yMin) / 4).toFixed(4));

    const series = [];
    if (hasBand) {
      series.push({ name: 'HIGH', type: 'line', data: d.high, symbol: 'none', z: 2,
        lineStyle: { width: 1, color: C_HI, opacity: 0.9 }, silent: true });
      series.push({ name: 'LOW', type: 'line', data: d.low, symbol: 'none', z: 2,
        lineStyle: { width: 1, color: C_LO, opacity: 0.9 }, silent: true });
    }
    const thrLines = Array.isArray(thr) ? thr : (thr != null ? [{ y: thr, color: '#6a5a2a' }] : []);
    series.push({
      name: 'CLOSE', type: 'line', data: d.close,
      symbol: 'none', smooth: false, connectNulls: false, z: 3,
      lineStyle: { width: 1.2, color: C_LINE },
      markLine: {
        silent: true, symbol: 'none', animation: false,
        label: { show: false },
        data: [
          ...(prevClose != null ? [{ yAxis: prevClose, lineStyle: { color: C_PREV, type: 'dashed', width: 1 } }] : []),
          ...thrLines.map((t2) => ({ yAxis: t2.y, lineStyle: { color: t2.color || '#6a5a2a', type: 'dotted', width: 1 } })),
        ],
      },
    });

    // 最高/最低点标注（相对昨收涨幅），画在右侧。
    const hlMarks = [];
    let hiIdx = -1, hiV = -Infinity, loIdx = -1, loV = Infinity;
    for (let i = 0; i < d.close.length; i++) {
      const p = d.close[i];
      if (p == null) continue;
      if (p > hiV) { hiV = p; hiIdx = i; }
      if (p < loV) { loV = p; loIdx = i; }
    }
    const pcv = prevClose;
    if (hiIdx >= 0) {
      const chg = pcv != null ? (hiV / pcv - 1) * 100 : null;
      hlMarks.push({ kind: 'hi', i: hiIdx, y: hiV,
        label: `高 ${hiV.toFixed(2)}${chg != null ? ` ${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%` : ''}` });
    }
    if (loIdx >= 0 && loIdx !== hiIdx) {
      const chg = pcv != null ? (loV / pcv - 1) * 100 : null;
      hlMarks.push({ kind: 'lo', i: loIdx, y: loV,
        label: `低 ${loV.toFixed(2)}${chg != null ? ` ${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%` : ''}` });
    }

    for (const m of [...hlMarks, ...marks]) {
      const color = m.kind === 'hi' ? '#78aaff'
        : m.kind === 'lo' ? '#c9d3cf'
        : m.kind === 'buy' ? C_BUY
        : (m.kind === 'sell' ? C_SELL : (m.kind === 'skip' ? C_SKIP : C_HIT));
      const pos = m.pos || smartPos(m.i, m.y, yMin, yMax);
      series.push({
        name: m.kind, type: 'line', data: [], symbol: 'none', silent: true, z: 20,
        markPoint: {
          silent: true, animation: false,
          symbol: m.kind === 'skip' ? 'rect' : (m.kind === 'hi' ? 'pin' : (m.kind === 'lo' ? 'pin' : 'circle')),
          symbolSize: m.kind === 'hi' || m.kind === 'lo' ? 4 : (m.kind === 'hit' ? 6 : 8),
          itemStyle: {
            color: m.kind === 'skip' ? 'transparent' : color,
            borderColor: m.kind === 'skip' ? C_SKIP : '#0d0f0e',
            borderWidth: m.kind === 'skip' ? 1.2 : 1.5,
            borderType: m.kind === 'skip' ? 'dashed' : 'solid',
          },
          label: {
            show: true, distance: m.kind === 'hit' ? 8 : 10, fontSize: 9, color,
            position: pos,
            formatter: m.label,
            lineHeight: 11,
            align: pos === 'right' ? 'left' : (pos === 'left' ? 'right' : 'center'),
            textBorderColor: 'rgba(6,8,7,0.92)', textBorderWidth: 3,
          },
          data: [{ coord: [m.i, m.y] }],
        },
      });
    }

    return {
      animation: false,
      // 贴边：左右几乎不留边距，价格/涨幅刻度画进图层内（带衬底防遮挡）。
      grid: { left: 8, right: 8, top: 26, bottom: 22 },
      tooltip: {
        show: true, trigger: 'axis',
        axisPointer: {
          type: 'cross',
          lineStyle: { color: '#8a948f', width: 1 },   // 竖线（贴 x 轴）
          crossStyle: { color: '#8a948f', width: 1 },   // 横线
          label: { show: true, color: '#d7dedb', backgroundColor: 'rgba(10,12,11,0.9)', fontSize: 9 },
        },
        backgroundColor: 'rgba(10,12,11,0.94)', borderColor: '#2a302d',
        textStyle: { color: '#e6ebe9', fontSize: 10 },
        formatter: (p) => {
          const it = Array.isArray(p) ? p[0] : p;
          const v = it && it.data;
          if (v == null) return '';
          const pcv = prevClose;
          const chg = pcv != null ? ((v / pcv - 1) * 100) : null;
          return `${it.axisValue}　${v.toFixed(2)}${chg != null ? `　${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%` : ''}`;
        },
      },
      xAxis: {
        type: 'category', data: cats, boundaryGap: false,
        axisPointer: { show: true, label: { show: true, color: '#d7dedb', backgroundColor: 'rgba(10,12,11,0.9)', fontSize: 9 } },
        axisLine: { lineStyle: { color: '#242a28' } },
        axisTick: { show: false },
        axisLabel: {
          color: '#6f7b77', fontSize: 9,
          interval: (i) => i === 0 || i === 59 || i === 119 || i === 179 || i === 239,
          formatter: (v) => v,
        },
        splitLine: { show: false },
      },
      yAxis: [
        // 价格主图 y 轴（左：价格；右：相对昨收涨幅），刻度画进图层内。
        // 十字线（axisPointer）横线两端动态标签：左端=价格（左轴），右端=相对昨收涨幅（右轴），
        // 与左右两轴的固定刻度保持一致口径。主轴不单独弹标签，避免与左侧刻度轴重叠。
        {
          type: 'value', min: yMin, max: yMax, interval,
          axisLine: { show: false }, axisTick: { show: false },
          axisLabel: { show: false },
          axisPointer: { show: true, label: { show: false } },
          splitLine: { lineStyle: { color: 'rgba(255,255,255,.05)' } },
        },
        {
          type: 'value', min: yMin, max: yMax, interval, position: 'left',
          axisLine: { show: false }, axisTick: { show: false }, splitLine: { show: false },
          axisPointer: {
            show: true, label: {
              show: true, color: '#d7dedb', backgroundColor: 'rgba(10,12,11,0.9)',
              fontSize: 9, formatter: (p) => (p && p.value != null ? Number(p.value).toFixed(2) : ''),
            },
          },
          axisLabel: {
            show: true, color: '#6f7b77', fontSize: 9, align: 'left', margin: 6,
            formatter: (v) => v.toFixed(2),
          },
        },
        {
          type: 'value', min: yMin, max: yMax, interval, position: 'right',
          axisLine: { show: false }, axisTick: { show: false }, splitLine: { show: false },
          axisPointer: {
            show: true, label: {
              show: true, color: '#d7dedb', backgroundColor: 'rgba(10,12,11,0.9)',
              fontSize: 9, formatter: (p) => {
                if (!p || p.value == null || prevClose == null) return '';
                const c = (p.value / prevClose - 1) * 100;
                return `${c >= 0 ? '+' : ''}${c.toFixed(2)}%`;
              },
            },
          },
          axisLabel: {
            show: true, color: '#6f7b77', fontSize: 9, align: 'right', margin: 6,
            formatter: (v) => { const c = prevClose != null ? ((v / prevClose - 1) * 100) : null;
              return c == null ? '' : `${c >= 0 ? '+' : ''}${c.toFixed(2)}%`; },
          },
        },
      ],
      series,
    };
  }

  // 取「当前展示股票」的重算结果：按代码从 rcCache 取，避免把上一只票的结果套到这只上。
  // subminCode：看盘浮层正在展示的股票；curCode：数据页签打开的股票。
  // 浮层可能没经过数据页签直接打开，此时 curCode 为空，只能认 subminCode。
  function rcForCur() {
    const c = plainCode(subminCode) || plainCode(curCode) || D_code;
    return (c && rcCache[c]) || null;
  }
  function tradeList() {
    const rc = rcForCur();
    return (rc && rc.trades) ? rc.trades : D.all;
  }

  // 浮层：买点画在 T 日 15:00，卖点画在 T1 日 et 时刻（未触发时 et 已是 15:00）。
  // 被过滤的笔（gates 非空）按规则不买：买入日画灰色虚线「对照」标注，卖出日只对照走势。
  // 分时浮层：一天里「所有」相关买卖记录都各自标点。
  // 同一日期可能是某笔的买入日（T）、又同时是前一笔的卖出日（T1）：
  // 卖出标红点（在卖出时刻）、买入标绿点（15:00 收盘），分开标记、分开备注，互不混写。
  // 被过滤笔买入画灰色虚线「本应买但不买」对照标注；被过滤笔卖出只画对照（无红点）。
  function drawSubminDay(trades, dstr) {
    const box = el('rvd-submin-canvas');
    const head = el('rvd-submin-title');
    if (!box || !trades.length) return;
    const rc = rcForCur();
    const marks = [];
    let dayKey = dstr, prevClose = null, thr = null;

    for (const { kind, t } of trades) {
      const bought = recIsBought(t);
      if (kind === 'buy') {
        // 买入日：绿点在 15:00 收盘买入那根，备注只写买入信息（不掺卖出内容）。
        // 买入日不画卖出阈值线（跨日价格错位会误导），故用买入日自身 prevClose。
        dayKey = t.T;
        prevClose = D.pc[t.T];
        thr = null;
        if (bought) {
          marks.push({ i: D.slots.length - 1, y: t.buy, kind: 'buy', pos: 'bottom',
            label: `15:00 买 ${t.buy.toFixed(2)}` });
        } else {
          marks.push({ i: D.slots.length - 1, y: t.buy, kind: 'skip', pos: 'bottom',
            label: `15:00 本应买 ${t.buy.toFixed(2)}（被过滤）` });
        }
      } else {
        // 卖出日：红点在卖出时刻，备注写卖出信息（时刻/价格/盈亏）。
        dayKey = t.T1;
        prevClose = t.p0;
        if (bought) {
          const si = slotIdx(t.et);
          if (si != null) {
            const kindTxt = rc ? (RKIND_TXT[t.kind] || t.kind) : null;
            const label = rc
              ? `${t.et} ${kindTxt || '卖'} ${t.sell.toFixed(2)}（${fmt(t.net)}）`
              : `${t.et} 卖 ${t.sell.toFixed(2)}（${fmt(t.net)}）`;
            marks.push({ i: si, y: t.sell, kind: 'sell', label });
            if (t.thr != null) thr = t.thr;
          }
        }
      }
    }

    const hasSell = trades.some(({ kind, t }) => kind === 'sell' && recIsBought(t));
    const anyBought = trades.some(({ t }) => recIsBought(t));
    let headTxt = `${dstr} · ${subminCode || ''}`;
    if (thr != null) headTxt += ` · 触发价 ${thr.toFixed(2)}`;
    else if (!anyBought) headTxt += ' · 被过滤（对照）';
    else if (!hasSell) headTxt += ' · 15:00 收盘买入';
    if (head) head.textContent = headTxt;

    if (!subminChart) {
      subminChart = echarts.init(box);
      subminCrossOn = true;
      // 点击浮层：切换十字线（含横线）显示/隐藏。
      box.onclick = (e) => {
        if (!subminChart) return;
        subminCrossOn = !subminCrossOn;
        subminChart.dispatchAction({ type: 'showTip' }); // no-op 保持 tooltip
        syncSubminCross();
      };
    }
    subminChart.setOption(dayOption(dayOf(dayKey), prevClose, marks, thr), true);
    syncSubminCross();
    // 切日期时同步日 K 的十字线到同一天（主图上看得见所指位置）。
    try {
      const tk = window.TdxChart;
      if (tk && typeof tk.showCrossAtDate === 'function') tk.showCrossAtDate(dayKey);
    } catch (_) { /* 主图不在日 K 周期或未就绪时忽略 */ }
  }

  // 按开关显隐浮层十字线：横线（y 轴 axisPointer）+ 竖线（x 轴 axisPointer）一起，
  // 自定义的价格/涨幅刻度（左 y 轴、右 y 轴）保持显示不受影响。
  function syncSubminCross() {
    if (!subminChart) return;
    subminChart.setOption({ tooltip: { show: subminCrossOn } });
    // 三条 y 轴（隐式主轴 + 左侧价格刻度 + 右侧涨幅刻度）的横线一起受开关控制，
    // 否则点隐藏时主轴横线消失、左右两轴横线仍在，看起来「横线不受控制」。
    subminChart.setOption({ yAxis: [
      { axisPointer: { show: subminCrossOn } },
      { axisPointer: { show: subminCrossOn } },
      { axisPointer: { show: subminCrossOn } },
    ] });
    subminChart.setOption({ xAxis: [{ axisPointer: { show: subminCrossOn } }] });
    if (!subminCrossOn) subminChart.dispatchAction({ type: 'hideTip' });
  }

  // 点某天 → 找那天是买入日还是卖出日（同一日期可能既是某笔的 T 又是另一笔的 T1，逐笔展示）。
  function tradesFor(date) {
    const out = [];
    const list = tradeList();
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      if (t.T === date) out.push({ t, i, kind: 'buy' });
      if (t.T1 === date) out.push({ t, i, kind: 'sell' });
    }
    return out;
  }

  // 无证据时请求 /api/timeline。只读字段，不编造/插值。
  async function fetchRemoteTimeline(code, date) {
    const apiBase = location.pathname.indexOf('/stock-picker') === 0 ? '/stock-picker' : '';
    const res = await fetch(`${apiBase}/api/timeline?code=${encodeURIComponent(code)}&date=${encodeURIComponent(date)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
    return data;
  }

  // 渲染某一天的浮层（分时 + 对应买卖标注）。dstr 必须是 days 里有的键。
  function renderSubminDate(dstr, rect) {
    const layer = el('chart-submin');
    const canvas = el('rvd-submin-canvas');
    const title = el('rvd-submin-title');
    const prev = el('rvd-submin-prev');
    const next = el('rvd-submin-next');
    if (!layer || !canvas) return;
    const hasDay = !!(D && D.days && D.days[dstr]);
    layer.hidden = false;
    positionLayer(layer, rect);
    if (!hasDay) {
      if (title) title.textContent = `${dstr} · 暂无分钟数据`;
      if (canvas) canvas.innerHTML = '<div class="cs-empty">该日无分钟证据，无法画分时。</div>';
      updateNavBtns(prev, next);
      return;
    }
    const trades = tradesFor(dstr);
    // 有证据：画分时。同一日期既可能是某笔的买入日（T）、又可能是前一笔的卖出日（T1），
    // tradesFor 会返回 [sell, buy] 等多条。这里把「当天所有」买卖记录一起标上：
    // 卖出标红点（卖出时刻）、买入标绿点（15:00 收盘），各自独立备注、互不掺和。
    // 没有对应买卖笔则只画当日走势（无标注）。
    disposeSubmin();
    canvas.innerHTML = '';
    drawSubminDay(trades, dstr);
    subminOpen = true;
    updateNavBtns(prev, next);
    resizeSubmin();
  }

  // 左右箭头按钮状态：到头禁用，可循环。
  function updateNavBtns(prev, next) {
    if (prev) {
      prev.disabled = !(subminDates.length > 1) || subminDateIdx <= 0;
      prev.classList.toggle('disabled', prev.disabled);
    }
    if (next) {
      next.disabled = !(subminDates.length > 1) || subminDateIdx >= subminDates.length - 1;
      next.classList.toggle('disabled', next.disabled);
    }
  }

  // 在「有分时数据的日期列表」里前后切换（排序过的 days 键）。
  function navSubmin(dir) {
    if (!subminDates.length) return;
    let i = subminDateIdx + dir;
    if (i < 0) i = subminDates.length - 1;        // 循环到末尾
    if (i >= subminDates.length) i = 0;           // 循环到开头
    subminDateIdx = i;
    renderSubminDate(subminDates[i], null);
  }

  async function showSubmin({ code, label, rect }) {
    const layer = el('chart-submin');
    const canvas = el('rvd-submin-canvas');
    const title = el('rvd-submin-title');
    if (!layer || !canvas) return;
    const pc = plainCode(code);
    // 有本地证据的股票（301557、603186 等）：统一走证据文件路径，复用同一套渲染/联动/买卖点。
    if (EVIDENCE_CODES.includes(pc)) {
      await loadEvidence(pc).catch(() => {});
      if (plainCode(code) !== pc) return;  // 又换股了
      const dstr = label ? String(label).slice(0, 10) : '';
      subminCode = pc;
      // 有分时数据的日期列表：days 的所有键，按日期排序。
      subminDates = D && D.days ? Object.keys(D.days).slice().sort() : [];
      subminDateIdx = subminDates.indexOf(dstr);
      if (subminDateIdx < 0) subminDateIdx = 0;
      renderSubminDate(subminDates[subminDateIdx] || dstr, rect);
      return;
    }
    // 其他股票：请求真实分时（/api/timeline 带前缀 code）。缺数据明示，不插值。
    // 无静态分时日期列表，禁用左右箭头。
    subminDates = [];
    subminDateIdx = -1;
    await showRemoteSubmin(code, label, rect);
  }

  // 日K 主图（价格那块）在屏幕坐标里的下沿：浮层贴到这条线以下，
  // 正好盖住副图（量能/振幅），不压住主图的价格走势，也不挤压日K 空间。
  function mainGridBottomOnScreen() {
    const canvasEl = el('chart-canvas');
    if (!canvasEl) return null;
    const tk = window.TdxChart;
    // 主图把各网格的像素区域记在内部，取最上面那块（价格主图）的 bottom。
    const rects = tk && tk.gridRects ? tk.gridRects() : null;
    if (rects && rects.length && rects[0]) {
      const top = canvasEl.getBoundingClientRect().top;
      return top + rects[0].bottom;
    }
    return null;
  }

  function positionLayer(layer, rect) {
    // 浮层为 fixed 定位：贴屏幕底边、撑满屏幕左右边缘，
    // 上沿卡在日K 主图下沿——只遮副图，不压主图、不挤压日K 空间。
    const pad = 4;
    const w = Math.max(220, window.innerWidth - pad * 2);
    const h = Math.max(150, Math.round(window.innerHeight * 0.34));
    // 默认放在屏幕下半部；能拿到主图下沿时，就从主图下沿往下摆。
    let top = Math.round(window.innerHeight - h - pad);
    const mb = mainGridBottomOnScreen();
    if (mb != null && mb + 8 < window.innerHeight - pad) top = Math.round(mb + 8);
    top = Math.min(top, window.innerHeight - h - pad);
    top = Math.max(pad, top);
    layer.style.left = pad + 'px';
    layer.style.width = w + 'px';
    layer.style.top = top + 'px';
    layer.style.height = h + 'px';
  }

  // 浮层显示后重算 ECharts 尺寸（隐藏→显示时画布大小从 0 恢复）。
  function resizeSubmin() {
    if (subminChart) { try { subminChart.resize(); } catch (e) { /* 忽略 */ } }
  }

  // 换一张图前先释放旧实例：清 innerHTML 会摧毁 echarts 内部 DOM，
  // 不 dispose 就复用会导致 setOption 画到已脱离文档的节点上。
  function disposeSubmin() {
    if (subminChart) {
      try { subminChart.dispose(); } catch (e) { /* 忽略 */ }
      subminChart = null;
    }
  }

  async function showRemoteSubmin(code, label, rect) {
    const layer = el('chart-submin');
    const canvas = el('rvd-submin-canvas');
    const title = el('rvd-submin-title');
    if (!layer || !canvas) return;
    layer.hidden = false;
    positionLayer(layer, rect);
    updateNavBtns(el('rvd-submin-prev'), el('rvd-submin-next'));
    const dstr = label ? String(label).slice(0, 10) : '';
    if (title) title.textContent = `${dstr} · ${plainCode(code)}`;
    canvas.innerHTML = '<div class="cs-empty">加载当日分时…</div>';
    const date = dstr.replace(/\D/g, '');
    try {
      const data = await fetchRemoteTimeline(code, date);
      const pts = (data && data.points) || [];
      if (!pts.length) throw new Error('该日无分时数据');
      drawSubminLine(canvas, pts);
      resizeSubmin();
    } catch (e) {
      canvas.innerHTML = '<div class="cs-empty">' + ((e && e.message) || '分时获取失败') + '</div>';
    }
  }

  // 用 echarts 画一条分时价格线（pts: [{price}]）
  function drawSubminLine(canvas, pts) {
    disposeSubmin();
    canvas.innerHTML = '';
    subminChart = echarts.init(canvas);
    const cats = [];
    for (let i = 0; i < 242; i++) cats.push(i);
    subminChart.setOption({
      animation: false,
      grid: { left: 46, right: 54, top: 14, bottom: 22 },
      xAxis: { type: 'category', data: cats.map(() => ''), boundaryGap: false,
        axisLine: { lineStyle: { color: '#242a28' } }, axisTick: { show: false },
        axisLabel: { show: false }, splitLine: { show: false } },
      yAxis: { type: 'value', scale: true, axisLine: { show: false }, axisTick: { show: false },
        axisLabel: { color: '#6f7b77', fontSize: 9, formatter: (v) => v.toFixed(2) },
        splitLine: { lineStyle: { color: 'rgba(255,255,255,.05)' } } },
      tooltip: { show: false },
      series: [{ name: 'PRICE', type: 'line', data: pts.map((p) => p.price), symbol: 'none',
        smooth: false, connectNulls: false, lineStyle: { width: 1.2, color: C_LINE } }],
    }, true);
  }

  function hideSubmin() {
    const layer = el('chart-submin');
    if (layer) layer.hidden = true;
    subminOpen = false;
    subminDateIdx = -1;
    subminDates = [];
    subminCode = '';
  }

  /* ---------- 对外接口 ---------- */
  window.RVData = {
    show(code) {
      const box = el('chart-data');
      if (!box) return;
      curCode = plainCode(code);
      box.innerHTML =
        '<div class="cd-sub" id="rvd-sub"></div>' +
        '<div class="cd-stats" id="rvd-stats"></div>' +
        '<div class="cd-sec">口径对照</div><div id="rvd-groups"></div>' +
        '<div class="cd-sec">出场方式</div><div id="rvd-kinds"></div>' +
        '<div class="cd-sec">被过滤掉的笔（不买入）</div><div id="rvd-gates"></div>' +
        '<div class="cd-sec">高昨比分档（全部候选）</div><div id="rvd-buckets"></div>' +
        '<div class="cd-sec">明细（点一行切回日线该日）</div>' +
        '<div class="cd-tblwrap cd-scroll"><table><thead><tr><th>净收益</th><th>#</th><th>买入日</th><th>卖出日</th><th>买入</th><th>卖出</th><th>出场</th><th>高昨比</th><th>是否买入</th></tr></thead>' +
        '<tbody id="rvd-rows"></tbody></table></div>' +
        '<div class="cd-foot" id="rvd-foot"></div>';
      render(box, curCode);
    },
    hideSubmin,
    showSubmin,
    // 日K十字线移动时反向联动：浮层开着且日期变了就切到那一天。
    // 不改缩放、只切日期；日期不在本地证据里则忽略。
    syncToDate(dateStr) {
      if (!subminOpen || !subminDates.length) return;
      const d = String(dateStr || '').slice(0, 10);
      if (!d) return;
      const i = subminDates.indexOf(d);
      if (i < 0 || i === subminDateIdx) return;
      subminDateIdx = i;
      renderSubminDate(subminDates[i], null);
    },
    // 前端重算引擎：返回 Promise<重算结果>，并让数据页签/分时浮层用新结果刷新。
    // 只对证据清单（EVIDENCE_CODES）里、有分钟证据的票有效，其他票无分钟数据。
    recompute,
    // 供 rv.js 取最近一次重算结果（null 表示未重算）。
    getLastRecompute: () => lastRecompute,
    // 按 6 位代码取该票的重算结果（无则 undefined），供列表按行归属匹配。
    getRc: (code) => rcCache[plainCode(code)],
    getParams: () => rcParams,
    // 供 rv.js 判断「当前股票」证据是否已加载（决定是否显示重算面板/是否可重算）。
    // D_code 与 curCode 一致才算数，避免还留着上一只票的数据时误判。
    hasEvidence: () => !!D && D_code === curCode && EVIDENCE_CODES.includes(curCode),
    close() {
      hideSubmin();
      curCode = '';
    },
  };

  // 明细点行：切回日线并定位到该笔的卖出日（T1）。
  document.addEventListener('click', (e) => {
    const tr = e.target.closest('#rvd-rows tr');
    if (!tr) return;
    const i = Number(tr.dataset.i);
    if (!D || !D.all[i]) return;
    const t = D.all[i];
    // 高亮该行
    document.querySelectorAll('#rvd-rows tr').forEach((r) => r.classList.toggle('on', r === tr));
    // 切回日线 gotoDate(T)（该笔买入日），经 RVHooks 接口。
    if (window.RVHooks && typeof window.RVHooks.gotoDate === 'function') {
      window.RVHooks.gotoDate(t.T);
    }
  });

  // 浮层关闭按钮
  document.addEventListener('click', (e) => {
    if (e.target.closest('.cs-close')) hideSubmin();
  });

  // 浮层左右箭头：在「有分时数据的日期列表」里前后切换。
  document.addEventListener('click', (e) => {
    if (e.target.closest('#rvd-submin-prev')) navSubmin(-1);
    else if (e.target.closest('#rvd-submin-next')) navSubmin(1);
  });

  // 浮层在 #chart-canvas 内部：拦截 pointer 事件，避免点浮层内的内容
  // 触发看盘图表的手势/十字线逻辑。
  document.addEventListener('pointerdown', (e) => {
    if (e.target.closest && e.target.closest('#chart-submin')) e.stopPropagation();
  }, true);
  document.addEventListener('touchstart', (e) => {
    if (e.target.closest && e.target.closest('#chart-submin')) e.stopPropagation();
  }, true);
})();

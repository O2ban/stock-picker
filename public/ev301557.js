/* ===================== 301557 常友科技 · 一分钟分时复盘 =====================
   数据来源：public/ev301557-data.json（由 notes/evidence/v2 的同一份
   100 笔明细 + 101 天一分钟 OHLC 拼成），前端只做「读字段 + 求和」，
   不做任何近似或二次计算。

   本版口径（2026-11-21 定稿）：
   · 买点 = T 日 15:00 收盘价（buy）
   · 卖出日：某一分钟的 high ≥ 触发价（= T 日收盘 × 1.01）即「即刻卖出」
     - 09:31 开盘价已 ≥ 触发价 → 按开盘价成交（OPEN_GAP）
     - 否则按触发价成交（TARGET）
     - 全天 high 都没到 → 15:00 收盘价卖（NOHIT_CLOSE，仅作对照）
   · 买入日过滤（任一成立则不买入）：
     - 高昨比 = (T 日最高 / T-1 日收盘 - 1) < 1%  → HPR_LT1
     - T 日收盘同时跌破 MA5 与 MA20 → BELOW_MA
   · 净收益 = net（已扣双边 0.26%），前端不再扣费
   统计口径与证据页完全一致：均值/中位按 net，累计为复利连乘。
   ==================================================================== */
(function () {
  'use strict';

  const C_BUY = '#3fd68b';
  const C_SELL = '#ff5a76';
  const C_HIT = '#e8a33d';
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

  const el = (id) => document.getElementById(id);

  let D = null;
  let idx = 0;
  let chartT = null, chartT1 = null;
  let loading = null;
  let userNav = false;

  /* ---------- 小工具 ---------- */
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

  /* ---------- 单日分时图 ---------- */
  // d: {close:[], high:[], low:[]}；prevClose; marks:[{i,y,kind,label,pos}]; thr
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

    // 最高价 / 最低价：细线，用来一眼看出「最高价顶到了触发价、收盘价没有」
    if (hasBand) {
      series.push({
        name: 'HIGH', type: 'line', data: d.high, symbol: 'none', z: 2,
        lineStyle: { width: 1, color: C_HI, opacity: 0.9 },
        silent: true,
      });
      series.push({
        name: 'LOW', type: 'line', data: d.low, symbol: 'none', z: 2,
        lineStyle: { width: 1, color: C_LO, opacity: 0.9 },
        silent: true,
      });
    }

    series.push({
      name: 'CLOSE', type: 'line', data: d.close,
      symbol: 'none', smooth: false, connectNulls: false, z: 3,
      lineStyle: { width: 1.2, color: C_LINE },
      markLine: {
        silent: true, symbol: 'none', animation: false,
        label: { show: false },
        data: [
          ...(prevClose != null ? [{ yAxis: prevClose, lineStyle: { color: C_PREV, type: 'dashed', width: 1 } }] : []),
          ...(thr != null ? [{ yAxis: thr, lineStyle: { color: '#6a5a2a', type: 'dotted', width: 1 } }] : []),
        ],
      },
    });

    for (const m of marks) {
      const color = m.kind === 'buy' ? C_BUY : (m.kind === 'sell' ? C_SELL : C_HIT);
      const pos = m.pos || (m.i <= 45 ? 'right' : (m.i >= 190 ? 'top' : 'bottom'));
      series.push({
        name: m.kind, type: 'line', data: [], symbol: 'none', silent: true, z: 20,
        markPoint: {
          silent: true, animation: false,
          symbol: 'circle', symbolSize: m.kind === 'hit' ? 6 : 8,
          itemStyle: { color, borderColor: '#0d0f0e', borderWidth: 1.5 },
          label: {
            show: true, distance: m.kind === 'hit' ? 8 : 10, fontSize: 9, color,
            position: pos,
            formatter: m.label,
            lineHeight: 11,
            align: pos === 'right' ? 'left' : (pos === 'left' ? 'right' : 'center'),
            textBorderColor: 'rgba(6,8,7,0.92)', textBorderWidth: 2.5,
          },
          data: [{ coord: [m.i, m.y] }],
        },
      });
    }

    return {
      animation: false,
      grid: { left: 46, right: 54, top: 14, bottom: 22 },
      xAxis: {
        type: 'category', data: cats, boundaryGap: false,
        axisLine: { lineStyle: { color: '#242a28' } },
        axisTick: { show: false },
        axisLabel: {
          color: '#6f7b77', fontSize: 9,
          interval: (i) => i === 0 || i === 59 || i === 119 || i === 179 || i === 239,
          formatter: (v) => v,
        },
        splitLine: { show: false },
      },
      yAxis: {
        type: 'value', min: yMin, max: yMax, interval,
        axisLine: { show: false }, axisTick: { show: false },
        axisLabel: { color: '#6f7b77', fontSize: 9, formatter: (v) => v.toFixed(2) },
        splitLine: { lineStyle: { color: 'rgba(255,255,255,.05)' } },
      },
      tooltip: { show: false },
      series,
    };
  }

  const slotIdx = (t) => {
    const s = String(t || '').replace(/\D/g, '');
    if (s.length < 4) return null;
    const key = s.slice(0, 2) + ':' + s.slice(2, 4);
    const i = D.slots.indexOf(key);
    return i < 0 ? null : i;
  };

  function dayOf(dt) {
    return { close: D.days[dt] || [], high: D.highs[dt] || [], low: D.lows[dt] || [] };
  }

  /* ---------- 画当前这一笔 ---------- */
  function draw() {
    const t = D.all[idx];
    const bought = isBought(t);
    const t1 = bought
      ? `<span class="tag turn">${KIND_TXT[t.kind] || t.kind}</span>`
      : `<span class="tag skip">未买入 · ${gateLabel(t)}</span>`;

    el('ev-head').innerHTML =
      `<div class="r1">第 <b>${t.n}</b> / ${D.all.length} 笔${t1}</div>` +
      `${t.T} 收盘 <b>${t.buy.toFixed(2)}</b> 买入 → 次日昨收 <b>${t.p0.toFixed(2)}</b>，触发价 <b>${t.thr.toFixed(2)}</b>（+1%）<br>` +
      (t.hit_t
        ? `首次触及 <b>${t.hit_t}</b>（该分钟最高 <b>${t.hit_p.toFixed(2)}</b>）；`
        : `全天<b>未触及</b> +1%；`) +
      `最终 <b>${t.et}</b> 以 <b>${t.sell.toFixed(2)}</b> 卖出；` +
      `毛 ${fmt(t.gross)}，扣费后 <b class="${cls(t.net)}">${fmt(t.net)}</b><br>` +
      `买入日高昨比 <b>${t.hpr == null ? '—（首日无前一日）' : t.hpr.toFixed(2) + '%'}</b>` +
      `（< 1% 不买）　T 日收盘 ${t.close.toFixed(2)} vs MA5 ${t.ma5.toFixed(2)} / MA20 ${t.ma20.toFixed(2)}` +
      `（同时跌破不买：<b>${t.below_both ? '是' : '否'}</b>）` +
      (bought ? '' : `<br><span class="warn">这一笔按规则<b>不买入</b>，图表与收益仅作对照。</span>`);

    el('ev-pos').textContent = `${t.T} 买 → ${t.T1} 卖　${idx + 1}/${D.all.length}`;
    el('ev-prev').disabled = idx === 0;
    el('ev-next').disabled = idx === D.all.length - 1;

    // 买入日：买点固定在 15:00 那根
    el('ev-t-title').innerHTML =
      `买入日 ${t.T}<em>15:00 收盘买入 ${t.buy.toFixed(2)} · 当日最高 ${t.hi.toFixed(2)}（高昨比 ${t.hpr == null ? '—' : t.hpr.toFixed(2) + '%'}）</em>`;
    const buyMarks = [{ i: D.slots.length - 1, y: t.buy, kind: 'buy', label: `15:00 买 ${t.buy.toFixed(2)}` }];
    if (!chartT) chartT = echarts.init(el('ev-c-t'));
    chartT.setOption(dayOption(dayOf(t.T), D.pc[t.T], buyMarks, null), true);

    // 卖出日：触及点（该分钟最高价）+ 成交点
    el('ev-t1-title').innerHTML =
      `卖出日 ${t.T1}<em>昨收 ${t.p0.toFixed(2)} · 触发价 ${t.thr.toFixed(2)}</em>`;
    const sellMarks = [];
    const hiIdx = slotIdx(t.hit_t);
    if (hiIdx != null) {
      sellMarks.push({
        i: hiIdx, y: t.hit_p, kind: 'hit', pos: 'top',
        label: `${t.hit_t} 最高 ${t.hit_p.toFixed(2)} ≥ 触发价`,
      });
    }
    const si = slotIdx(t.et);
    if (si != null) {
      sellMarks.push({
        i: si, y: t.sell, kind: 'sell',
        pos: (si >= 190 ? 'top' : 'bottom'),
        label: `${t.et} 卖 ${t.sell.toFixed(2)}（${fmt(t.net)}）`,
      });
    }
    if (!chartT1) chartT1 = echarts.init(el('ev-c-t1'));
    chartT1.setOption(dayOption(dayOf(t.T1), t.p0, sellMarks, t.thr), true);

    document.querySelectorAll('#ev-rows tr').forEach((tr) => {
      tr.classList.toggle('on', Number(tr.dataset.i) === idx);
    });
    const cur = document.querySelector('#ev-rows tr.on');
    if (cur && userNav && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' });
  }

  /* ---------- 统计与明细 ---------- */
  function renderStats() {
    const bought = D.all.filter(isBought);
    const skipped = D.all.filter((t) => !isBought(t));
    const all = stats(bought);

    const card = (k, v, c) => `<div class="ev-card"><div class="k">${k}</div><div class="v ${c || ''}">${v}</div></div>`;
    el('ev-stats').innerHTML =
      card('实际买入', all.n + ' 笔') +
      card('平均每笔净收益', fmt(all.mean), cls(all.mean)) +
      card('中位每笔净收益', fmt(all.med), cls(all.med)) +
      card('胜率', all.win.toFixed(1) + '%') +
      card('累计净收益', fmt(all.cum), cls(all.cum)) +
      card('双边成本', D.fee + '%');

    const row = (nm, s) => s
      ? `<tr><td>${nm}</td><td>${s.n}</td><td class="${cls(s.mean)}">${fmt(s.mean)}</td>` +
        `<td class="${cls(s.med)}">${fmt(s.med)}</td><td>${s.win.toFixed(1)}%</td>` +
        `<td class="${cls(s.cum)}">${fmt(s.cum)}</td></tr>`
      : '';

    // ① 口径对照：不过滤 / 过滤后 / 被过滤
    el('ev-groups').innerHTML =
      '<table><thead><tr><th>口径</th><th>笔数</th><th>均值</th><th>中位</th><th>胜率</th><th>累计</th></tr></thead><tbody>' +
      row('原规则（不过滤，100 笔全做）', stats(D.all)) +
      row('加两条过滤后实际买入', all) +
      row('被过滤掉（只作对照，不买）', stats(skipped)) +
      '</tbody></table>';

    // ② 出场方式
    el('ev-kinds').innerHTML =
      '<table><thead><tr><th>出场方式</th><th>笔数</th><th>均值</th><th>中位</th><th>胜率</th><th>累计</th></tr></thead><tbody>' +
      row('触及 +1% 就该分钟触发价成交', stats(bought.filter((t) => t.kind === 'TARGET'))) +
      row('开盘跳空 ≥ 触发价，按开盘价成交', stats(bought.filter((t) => t.kind === 'OPEN_GAP'))) +
      row('全天未触及 → 15:00 收盘卖', stats(bought.filter((t) => t.kind === 'NOHIT_CLOSE'))) +
      '</tbody></table>';

    // ③ 被过滤的构成
    const byGate = (fn) => stats(skipped.filter(fn));
    el('ev-gates').innerHTML =
      '<table><thead><tr><th>不买入原因</th><th>笔数</th><th>均值</th><th>中位</th><th>胜率</th><th>累计</th></tr></thead><tbody>' +
      row('仅 高昨比 < 1%', byGate((t) => t.gates.length === 1 && t.gates[0] === 'HPR_LT1')) +
      row('仅 收盘同时跌破 MA5/MA20', byGate((t) => t.gates.length === 1 && t.gates[0] === 'BELOW_MA')) +
      row('两条同时成立', byGate((t) => t.gates.length > 1)) +
      '</tbody></table>';

    // ④ 高昨比分档（全部 100 笔，看这条门槛的分布）
    const bk = [[-99, 1], [1, 2], [2, 3], [3, 4], [4, 6], [6, 999]];
    let h = '<table><thead><tr><th>买入日高昨比</th><th>笔数</th><th>均值</th><th>中位</th><th>胜率</th><th>累计</th></tr></thead><tbody>';
    for (const [lo, hiV] of bk) {
      const g = D.all.filter((t) => t.hpr != null && t.hpr >= lo && t.hpr < hiV);
      const nm = lo < 0 ? '低于 1%（不买）' : (hiV > 900 ? '≥ 6%' : `≥ ${lo}% ~ ${hiV}%`);
      h += row(nm, stats(g));
    }
    h += '</tbody></table>';
    el('ev-buckets').innerHTML = h;

    el('ev-rows').innerHTML = D.all.map((t, i) => {
      const st = isBought(t)
        ? `<span class="ok">买入</span>`
        : `<span class="no">不买·${gateLabel(t)}</span>`;
      return `<tr data-i="${i}" class="${isBought(t) ? '' : 'skip'}"><td>${t.n}</td><td>${t.T}</td><td>${t.T1}</td>` +
        `<td>${t.buy.toFixed(2)}</td><td>${t.sell.toFixed(2)}</td><td>${KIND_TXT[t.kind] || t.kind}</td>` +
        `<td class="${cls(t.net)}">${fmt(t.net)}</td>` +
        `<td>${t.hpr == null ? '—' : t.hpr.toFixed(2) + '%'}</td>` +
        `<td class="st">${st}</td></tr>`;
    }).join('');
  }

  /* ---------- 交互 ---------- */
  function go(i) {
    idx = Math.max(0, Math.min(D.all.length - 1, i));
    draw();
  }
  function goBy(i) { userNav = true; go(i); }

  el('ev-prev').addEventListener('click', () => goBy(idx - 1));
  el('ev-next').addEventListener('click', () => goBy(idx + 1));
  el('ev-back').addEventListener('click', () => {
    if (el('ev-page')) {
      el('ev-page').classList.remove('open');
      el('ev-page').setAttribute('aria-hidden', 'true');
      return;
    }
    if (history.length > 1) history.back();
    else location.href = './index.html';
  });
  el('ev-rows').addEventListener('click', (e) => {
    const tr = e.target.closest('tr');
    if (tr) goBy(Number(tr.dataset.i));
  });
  // 主站旧入口已删除（#ev-open / ev-page 抽屉不再挂载），独立页 ev301557.html 保留。
  window.addEventListener('resize', () => {
    if (chartT) chartT.resize();
    if (chartT1) chartT1.resize();
  });

  /* ---------- 启动 ---------- */
  function load() {
    if (loading) return loading;
    loading = fetch('./ev301557-data.json')
      .then((r) => r.json())
      .then((d) => {
        D = d;
        const nb = d.all.filter(isBought).length;
        el('ev-sub').textContent =
          `一分钟口径 · 候选 ${d.all.length} 笔 → 实际买入 ${nb} 笔 · 双边成本 ${d.fee}%`;
        renderStats();
        go(0);
      })
      .catch((e) => {
        el('ev-head').textContent = '数据加载失败：' + e.message;
        console.error(e);
        loading = null;
      });
    return loading;
  }
  window.EVEnter = function () {
    load();
    const fix = () => {
      if (chartT) chartT.resize();
      if (chartT1) chartT1.resize();
    };
    requestAnimationFrame(fix);
    setTimeout(fix, 300);
  };

  if (!el('ev-page')) load();
})();

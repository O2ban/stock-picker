/* 复盘页：选回测方案 → 看该方案的股票列表 → 点行开看盘抽屉
 *
 * 与 app.js 的分工：
 *  - 本文件只管「复盘页这张列表」：加载 rv-plans.json、填充方案下拉、虚拟滚动渲染行、维护可见代码。
 *  - 行模板刻意复用 app.js 的 stock-row / sr-* 结构，这样 app.js 每 3 秒的行情填充和
 *    迷你 K 线绘制会自动认领这些行，不必在这里另写一套。
 *  - 点行的动作交给 app.js 的 openChart（通过 window.RVHooks 调用），保证与自选/选股页
 *    开的是同一个看盘抽屉、同一套横滑换股逻辑。
 */
(function () {
  'use strict';

  var API_BASE = location.pathname.indexOf('/stock-picker') === 0 ? '/stock-picker' : '';
  var V_LIST_MIN = 150;      // 少于这个数量就整段画完，不做占位那套

  var plans = [];
  var curPlan = null;
  var items = [];
  var start = -1, end = -1;
  var rowH = 56;
  var activeCode = null;
  var loading = null;

  function $(id) { return document.getElementById(id); }
  function plainCode(c) { return String(c || '').replace(/^[a-z]{2}/i, ''); }
  const EVIDENCE_CODES = ['301557', '603186']; // 有本地逐笔/分钟证据的股票（重算/参数面板仅对它们生效）
  function escapeAttr(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }
  function pctText(x) {
    if (x == null || !isFinite(x)) return '—';
    return (x >= 0 ? '+' : '') + Number(x).toFixed(2) + '%';
  }
  function pctText2(x) {
    if (x == null || !isFinite(x)) return '—';
    return Number(x).toFixed(2) + '%';
  }
  var feeVal = null;
  function feeText() {
    if (feeVal == null || !isFinite(feeVal)) return '';
    return (feeVal).toFixed(3) + '%';
  }

  /* ---------- 方案下拉 ---------- */
  function fillPlanSelect() {
    var sel = $('rv-plan');
    if (!sel) return;
    if (!plans.length) { sel.innerHTML = '<option value="">（无方案）</option>'; return; }
    sel.innerHTML = plans.map(function (p) {
      return '<option value="' + escapeAttr(p.id) + '">' + escapeAttr(p.name || p.id) + '</option>';
    }).join('');
    var want = curPlan && curPlan.id ? String(curPlan.id) : (plans[0] && plans[0].id);
    sel.value = want || '';
    applyPlan(sel.value);
  }

  function planById(id) {
    for (var i = 0; i < plans.length; i++) if (String(plans[i].id) === String(id)) return plans[i];
    return null;
  }

  /* ---------- 行 ---------- */
  // 重算结果（rv-data.js 的 window.RVData.recompute）。证据票各自有独立重算值，按代码取。
  function rcFor(code) {
    var rd = window.RVData;
    if (rd && typeof rd.getRc === 'function') return rd.getRc(code);
    return null;
  }
  function rowInner(it, i) {
    return '<span class="sr-rank">' + (i + 1) + '</span>' +
      '<div class="sr-id"><span class="sr-name" data-name>' + escapeAttr(it.name || '') + '</span>' +
      '<span class="sr-code"><span data-code>' + escapeAttr(plainCode(it.code)) + '</span></span></div>' +
      '<div class="sr-spark"><canvas data-spark></canvas></div>' +
      '<div class="sr-quote"><span class="sr-pct flat" data-pct>--</span><span class="sr-price" data-price>--</span></div>';
  }
  function rowLi(it, i) {
    return '<li class="stock-row' + (it.code === activeCode ? ' active' : '') + '"' +
      ' data-code="' + escapeAttr(it.code) + '" data-name="' + escapeAttr(it.name || '') + '">' +
      '<div class="sr-main">' + rowInner(it, i) + '</div>' + statBlock(it) + '</li>';
  }

  // 行下方指标：胜率 / 平均盈亏 / 预期每笔 / 实际累计 / 笔数 + 凯利仓位
  // 重算结果只对证据票生效：rcFor 已按代码取到对应行的重算值，覆盖 n/win/avgWin/avgLoss/mean/cum，保留 100 天高昨比两项。
  function statBlock(it) {
    var rc = rcFor(it.code);
    var src = it;
    if (rc && rc.bought) {
      src = {
        n: rc.n,
        win: rc.win,
        avgWin: rc.avgWin,
        avgLoss: rc.avgLoss,
        mean: rc.mean,
        cum: rc.cum,
        hprAvg100: it.hprAvg100,
        hprGt1Pct100: it.hprGt1Pct100,
      };
    }
    var k = kellyCalc(src);
    return '<div class="rv-stat">' +
      cell('胜率', pctPct(src.win)) +
      cell('平均盈利', pctText(src.avgWin)) +
      cell('平均亏损', pctText(src.avgLoss)) +
      cell('预期每笔', pctText(src.mean)) +
      cell('实际累计', pctText(src.cum)) +
      cell('笔数', String(src.n || 0)) +
      cell('盈亏比 b', k.bText) +
      cell('凯利 f', k.fText) +
      cell('100天平均高昨比', pctText2(src.hprAvg100)) +
      cell('100天高昨比>1%占比', pctPct(src.hprGt1Pct100)) +
      '</div>' + (k.suggest ? '<div class="rv-stat-note">仓位建议：' + k.suggest + '</div>' : '');
  }
  function cell(label, val) {
    return '<span class="rv-cell"><b>' + escapeAttr(val) + '</b><i>' + label + '</i></span>';
  }
  function pctPct(x) {
    if (x == null || !isFinite(x)) return '—';
    return Number(x).toFixed(1) + '%';
  }
  function kellyCalc(it) {
    var n = Number(it.n) || 0;
    var win = (it.win == null || !isFinite(Number(it.win))) ? null : Number(it.win);
    var avgWin = Number(it.avgWin);
    var avgLoss = Number(it.avgLoss);
    var p = (win != null && isFinite(win)) ? win / 100 : null;
    var q = (p != null) ? 1 - p : null;
    var b = (avgWin != null && avgLoss != null && avgLoss < 0) ? Math.abs(avgWin / avgLoss) : 0;
    var bText = b ? b.toFixed(2) : (avgLoss === 0 ? '—（无亏损样本）' : '—');
    var f = (b > 0 && p != null) ? (p * b - q) / b : null;
    var fText, suggest;
    if (f == null) {
      if (avgLoss === 0 && n > 0) { fText = '不适用'; suggest = '该子集无亏损样本（事后挑出的上限，非可执行规则），凯利公式不适用。'; }
      else { fText = '—'; suggest = '数据不足或无有效盈亏比，暂不给出仓位建议。'; }
    } else if (f <= 0) {
      fText = f.toFixed(1) + '%';
      suggest = '凯利为负，期望收益为负，建议不参与。';
    } else {
      fText = f.toFixed(1) + '%';
      suggest = '凯利 ' + f.toFixed(1) + '%，保守建议单票 ' + (f / 4).toFixed(1) + '%~' + (f / 2).toFixed(1) + '% 仓位。';
    }
    return { bText: bText, fText: fText, suggest: suggest };
  }

  function scroller() { return document.querySelector('#tab-review .scroll-area'); }

  function visibleRange() {
    var n = items.length;
    if (!n) return null;
    if (n < V_LIST_MIN) return { first: 0, last: n };
    var sc = scroller();
    var scTop = sc ? sc.scrollTop : 0;
    var viewH = sc ? (sc.clientHeight || 800) : 800;
    var first = Math.max(0, Math.floor(scTop / rowH) - 6);
    var last = Math.min(n, Math.ceil((scTop + viewH) / rowH) + 6);
    return { first: first, last: last };
  }

  // 只为看得见的行补行情与迷你 K 线
  function ensureVisibleData(first, last) {
    var hook = window.RVHooks || {};
    var codes = [];
    for (var i = Math.max(0, first); i < Math.min(items.length, last); i++) codes.push(items[i].code);
    if (!codes.length) return;
    if (typeof hook.loadKlines === 'function') { try { hook.loadKlines(codes); } catch (e) { /* ignore */ } }
    if (typeof hook.refreshQuotes === 'function') { try { hook.refreshQuotes(codes).catch(function () {}); } catch (e) { /* ignore */ } }
  }

  function afterRender() {
    var hook = window.RVHooks || {};
    if (typeof hook.paintQuotes === 'function') { try { hook.paintQuotes(); } catch (e) { /* ignore */ } }
    if (typeof hook.drawSparks === 'function') { try { hook.drawSparks(true); } catch (e) { /* ignore */ } }
    var r = visibleRange();
    if (r) ensureVisibleData(r.first, r.last);
  }

  function render(force) {
    var list = $('rv-list');
    if (!list) return;
    var n = items.length;
    if (!n) { list.innerHTML = ''; start = end = -1; return; }
    if (n < 100000) {
      start = 0; end = n;
      var small = '';
      for (var i = 0; i < n; i++) small += rowLi(items[i], i);
      list.innerHTML = small;
      afterRender();
      return;
    }
    var r = visibleRange();
    if (!r) return;
    if (!force && r.first === start && r.last === end) return;
    start = r.first; end = r.last;
    var pad = function (h) {
      return '<li class="v-pad" aria-hidden="true" style="height:' + Math.max(0, Math.round(h)) + 'px"></li>';
    };
    var html = pad(r.first * rowH);
    for (var k = r.first; k < r.last; k++) html += rowLi(items[k], k);
    html += pad((n - r.last) * rowH);
    list.innerHTML = html;
    // 行高以真实渲染出来的那一行为准，和样式对不上就地改正，避免滚动位置一直偏
    var firstRow = list.querySelector('.stock-row');
    if (firstRow) {
      var h = Math.round(firstRow.getBoundingClientRect().height);
      if (h > 20 && Math.abs(h - rowH) > 1) {
        rowH = h;
        var kids = list.children;
        if (kids.length) {
          kids[0].style.height = Math.round(r.first * rowH) + 'px';
          kids[kids.length - 1].style.height = Math.round((n - r.last) * rowH) + 'px';
        }
      }
    }
    afterRender();
  }

  /* ---------- 换方案 ---------- */
  function applyPlan(id) {
    var p = planById(id) || plans[0] || null;
    curPlan = p;
    var empty = $('rv-empty');
    var stamp = $('rv-stamp');
    function clearCond() {
      var condEl = $('rv-cond');
      if (condEl) condEl.innerHTML = '';
      var rangeEl0 = $('rv-range');
      if (rangeEl0) rangeEl0.textContent = '';
    }
    if (!p) {
      items = [];
      clearCond();
      if (empty) empty.hidden = false;
      if (stamp) stamp.textContent = '—';
      var recalcEl0 = $('rv-recalc');
      if (recalcEl0) recalcEl0.hidden = true;
      start = end = -1;
      render(true);
      return;
    }
    items = (p.stocks || []).map(function (s) {
      return { code: s.code, name: s.name || '', n: s.n, mean: s.mean, med: s.med, win: s.win, cum: s.cum, avgWin: s.avgWin, avgLoss: s.avgLoss, hprAvg100: s.hprAvg100, hprGt1Pct100: s.hprGt1Pct100 };
    });
    // 参数面板只在「含证据票（301557/603186）」时显示（重算仅对证据票有效）。
    var recalcEl = $('rv-recalc');
    if (recalcEl) recalcEl.hidden = !items.some(function (s) { return EVIDENCE_CODES.indexOf(plainCode(s.code)) >= 0; });
    var noteEl = $('rv-cond');
    if (noteEl) {
      noteEl.innerHTML = '';
      var addBlock = function (title, arr) {
        if (!arr || !arr.length) return;
        var head = document.createElement('div');
        head.className = 'rv-cond-h';
        head.textContent = title;
        noteEl.appendChild(head);
        var ul = document.createElement('ul');
        ul.className = 'rv-cond-list';
        arr.forEach(function (txt) {
          var li = document.createElement('li');
          li.textContent = txt;
          ul.appendChild(li);
        });
        noteEl.appendChild(ul);
      };
      addBlock('买入门槛', p.filters);
      addBlock('买卖规则', p.rules);
      var fee = feeText();
      if (fee) {
        var feeLine = document.createElement('div');
        feeLine.className = 'rv-cond-fee';
        feeLine.textContent = '交易成本：双边合计 ' + fee + '（已计入净收益）';
        noteEl.appendChild(feeLine);
      }
    }
    var rangeEl = $('rv-range');
    if (rangeEl) {
      rangeEl.textContent = p.range ? ('回测区间：' + p.range) : '';
    }
    if (empty) empty.hidden = items.length > 0;
    if (stamp) {
      if (items.length) {
        // 方案级汇总：只求和/展示证据里已有的只读字段，不做任何再计算。
        // 有重算结果时，对证据票用「重算值 + 其余票静态值」合并，否则全用方案里的静态字段。
        var n = 0, sum = 0, winSum = 0, cnt = 0, rcHit = 0;
        for (var i = 0; i < items.length; i++) {
          var it = items[i];
          var src = it;
          var rc = EVIDENCE_CODES.indexOf(plainCode(it.code)) >= 0 ? rcFor(it.code) : null;
          if (rc && rc.bought) {
            src = { n: rc.n, mean: rc.mean, win: rc.win };
            rcHit++;
          }
          n += Number(src.n) || 0;
          if (Number.isFinite(src.mean)) { sum += Number(src.mean) * (Number(src.n) || 0); }
          if (Number.isFinite(src.win)) { winSum += Number(src.win) * (Number(src.n) || 0); cnt += Number(src.n) || 0; }
        }
        var mean = n ? sum / n : null;
        var win = cnt ? winSum / cnt : null;
        // 「已重算」标注：仅当方案里所有证据票都出了重算值时才标，避免只重算一只票时误标整表。
        var evItems = items.filter(function (x) { return EVIDENCE_CODES.indexOf(plainCode(x.code)) >= 0; });
        var rcTxt = (evItems.length > 0 && rcHit === evItems.length) ? ' · 已重算' : '';
        stamp.textContent = items.length + ' 只 · 合计 ' + n + ' 笔 · 加权均值 ' + pctText(mean) + ' · 加权胜率 ' + (win == null ? '—' : win.toFixed(1) + '%') + rcTxt;
      } else {
        stamp.textContent = '该方案暂无股票';
      }
    }
    // 换方案后滚动位置回到顶部
    var sc = scroller();
    if (sc) sc.scrollTop = 0;
    start = end = -1;
    render(true);
  }

  /* ---------- 加载 ---------- */
  function load() {
    if (loading) return loading;
    loading = fetch(API_BASE + '/rv-plans.json', { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) {
        plans = Array.isArray(d && d.plans) ? d.plans : [];
        feeVal = (d && Number.isFinite(Number(d.fee))) ? Number(d.fee) * 1 : null;
        fillPlanSelect();
        return d;
      })
      .catch(function (e) {
        var empty = $('rv-empty');
        if (empty) { empty.hidden = false; empty.textContent = '方案加载失败：' + e.message; }
        loading = null;
        throw e;
      });
    return loading;
  }

  /* ---------- 事件 ---------- */
  var sel = $('rv-plan');
  if (sel) sel.addEventListener('change', function () { applyPlan(sel.value); });

  var listEl = $('rv-list');
  if (listEl) {
    listEl.addEventListener('click', function (e) {
      var row = e.target.closest('.stock-row');
      if (!row) return;
      activeCode = row.dataset.code;
      var all = document.querySelectorAll('.stock-row.active');
      for (var i = 0; i < all.length; i++) all[i].classList.remove('active');
      row.classList.add('active');
      var hook = window.RVHooks || {};
      if (typeof hook.openChart === 'function') {
        hook.openChart(row.dataset.code, row.dataset.name || '');
      }
    });
  }

  var sc = scroller();
  if (sc) sc.addEventListener('scroll', function () { if (items.length >= V_LIST_MIN) render(false); });
  window.addEventListener('resize', function () { if (items.length) render(false); });
  var rf = $('rv-refresh');
  if (rf) rf.addEventListener('click', function () { load().then(function () { render(true); }).catch(function () {}); });

  /* ---------- 参数可调回测：读取参数 → window.RVData.recompute → 刷新列表 ---------- */
  function readParams() {
    var tp = $('rv-tp');
    var mode = $('rv-sl-mode');
    var sl = $('rv-sl');
    var slMode = mode ? mode.value : 'none';
    return {
      tpPct: tp ? Number(tp.value) : 1,
      slMode: slMode,
      slPct: sl ? Number(sl.value) : -2,
    };
  }
  function runRecalc() {
    var rd = window.RVData;
    if (!rd || typeof rd.recompute !== 'function') return;
    var params = readParams();
    // 校验止盈/止损数值
    if (!isFinite(params.tpPct)) { alert('止盈必须是数字'); return; }
    if ((params.slMode === 'minute' || params.slMode === 'close') && !isFinite(params.slPct)) { alert('止损必须是数字'); return; }
    // 止损幅度一般应为负值；若填了正数，自动取负（止损线 = 买入价×(1+止损%)）。
    if ((params.slMode === 'minute' || params.slMode === 'close') && params.slPct > 0) {
      params.slPct = -params.slPct;
      var slEl = $('rv-sl');
      if (slEl) slEl.value = String(params.slPct);
    }
    var done = function () { render(true); };
    var rp = rd.recompute(params);
    if (rp && typeof rp.then === 'function') {
      rp.then(done).catch(function (e) {
        alert('重算失败：' + (e && e.message ? e.message : e));
      });
    } else {
      done();
    }
  }
  var rcRun = $('rv-recalc-run');
  if (rcRun) rcRun.addEventListener('click', runRecalc);
  // 止损模式切换：选「不设止损」时隐藏止损幅度输入。
  var slModeSel = $('rv-sl-mode');
  if (slModeSel) {
    var syncSl = function () {
      var slF = $('rv-recalc-sl');
      if (slF) slF.style.display = (slModeSel.value === 'none') ? 'none' : '';
    };
    slModeSel.addEventListener('change', syncSl);
    syncSl();
  }

  /* ---------- 暴露给 app.js 的钩子 ---------- */
  window.RVShow = function () {
    if (!plans.length) { load().catch(function () {}); }
    else {
      // 切回复盘页时滚动容器尺寸才定型，重画一次避免首屏只有几行
      requestAnimationFrame(function () { render(true); });
    }
  };
  window.RVVisibleCodes = function () {
    if (!items.length) return [];
    var r = visibleRange();
    if (!r) return [];
    var out = [];
    for (var i = r.first; i < r.last && i < items.length; i++) out.push(items[i].code);
    return out;
  };
  window.RVItems = function () { return items; };
  // 复盘页目前没有涨幅排序按钮，这两个钩子保持最小实现：
  // app.js 只在有排序态时才会调用，返回 false 表示「不需要重排」。
  window.RVSort = function () { };
  window.RVSyncSort = function () { return false; };
})();

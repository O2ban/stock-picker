/* 迷你 K 线预览（自选 / 选股列表用）。
 * 设计要点：
 *  - 纯 canvas 手绘，不挂 ECharts：一屏几十行，每行一个实例会拖垮滚动。
 *  - 只作查看用途，无交互、无点击效果（点击整行由外层处理，进入看盘）。
 *  - 最新收盘价画一条橙色虚线，和参考图一致。
 */
(function () {
  'use strict';
  const UP = '#e0184b', DOWN = '#00a848', LAST_LINE = '#f0a020';

  function render(canvas, klines, opts) {
    if (!canvas) return;
    const o = opts || {};
    const rows = (klines || []).slice(-(o.bars || 40));
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || o.width || 88;
    const cssH = canvas.clientHeight || o.height || 34;
    if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    if (rows.length < 2) return;

    let hi = -Infinity, lo = Infinity;
    for (const r of rows) { if (r.h > hi) hi = r.h; if (r.l < lo) lo = r.l; }
    const pad = 3;
    const innerH = Math.max(1, cssH - pad * 2);
    const step = cssW / rows.length;
    const bw = Math.max(1, Math.min(step * 0.66, 5));
    const span = (hi - lo) || 1;
    const y = (v) => pad + (hi - v) / span * innerH;

    ctx.lineWidth = 1;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const cx = step * (i + 0.5);
      const rising = r.c >= r.o;
      const color = rising ? UP : DOWN;
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      // 上下影线
      ctx.beginPath();
      ctx.moveTo(cx, y(r.h));
      ctx.lineTo(cx, y(r.l));
      ctx.stroke();
      // 实体
      const yo = y(r.o), yc = y(r.c);
      const top = Math.min(yo, yc);
      const bh = Math.max(1, Math.abs(yc - yo));
      ctx.fillRect(cx - bw / 2, top, bw, bh);
    }

    // 最新收盘价虚线
    const last = rows[rows.length - 1];
    ctx.strokeStyle = LAST_LINE;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(0, y(last.c));
    ctx.lineTo(cssW, y(last.c));
    ctx.stroke();
    ctx.setLineDash([]);
  }

  window.Spark = { render };
})();

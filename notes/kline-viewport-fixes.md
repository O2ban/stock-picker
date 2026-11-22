---
title: 看盘 K 线三项修复（切回偏移 / 涨停金边 / 纵轴让位图例）
category: 运行与发布
date: 2026-10-19
updated: 2026-10-19
status: active
tags: []
summary: 改动文件：public/chart.js（唯一改动文件，静态文件刷新即生效，无需重启） 根因（两条叠加）： - 双画布换股靠 paneWidth() 算出的像素值写死进 trans…
---

# 看盘 K 线三项修复（切回偏移 / 涨停金边 / 纵轴让位图例）

改动文件：`public/chart.js`（唯一改动文件，静态文件刷新即生效，无需重启）

## 1. 从其他应用切回后横向偏移

根因（两条叠加）：
- 双画布换股靠 `paneWidth()` 算出的**像素值**写死进 `translateX()`。切后台/系统手势/来电打断时画布停在半路，原 `pointercancel` 只清手势状态、**不归位**，导致主层右偏、右侧露出预览图（z-index 更高）、最右 K 线被切。
- iOS Safari 从 bfcache 恢复不触发 `visibilitychange`/`resize`，容器宽度变了但布局没重算。

修复：
- 新增 `snapPanesHome()`：瞬时把主层归零、预览层推到 `translateX(W)` 屏外，清 `switching/previewReady/previewDir`。
- 新增 `resyncViewport()`：清 gesture/pointerDownAt/activePointers → 有进行中的滑动则 `snapPanesHome()`，否则按**新宽度**重新把预览层推到屏外 → `onResize()` + `syncDzWindow()`。同时 bump `previewToken`，让在途 `fetchKlines` 失效（防过期邻票 paint 回来）。
- 注册 `visibilitychange`（visible 时）、`pageshow`（`event.persisted` 时）、`focus` 三个入口。
- `pointercancel` 中若 `gesture.mode === 'switch'` 则调 `snapPanesHome()`。

## 2. 涨幅 > 9.5% 金黄色外描边

- 常量：`SURGE_PCT = 9.5`、`SURGE_COLOR = '#FFC53D'`。
- 涨幅口径：`(当日 close - 前一根 close) / 前一根 close * 100`，首根不描边。
- 逐条写 `itemStyle: { borderColor: SURGE_COLOR }`，不影响 `color/color0/borderColor0` 的红涨绿跌。

## 3. 纵轴刻度被图例遮挡

- `buildGrids()` 由百分比改为**像素布局**：每个 panel 顶部预留 `LEGEND_ROW_H(14) + LEGEND_GAP(2)`，再按 `PANELS.weight`（6/2/2）分配高度，左右仍各 2%。
- 图例绝对定位到 `rect.y - LEGEND_ROW_H - LEGEND_GAP`，即落在图格上方，价格刻度（`axisLabel.inside`）在图格内侧 → 自然位于图例下方。
- 注意（评审 P1 已修）：像素布局后 `chart.resize()` 不会重建 option，高度变化会导致 grid 冻结。`onResize` 中比对 `state._layoutH`，变化时重画 `mainSlot` 并按 `state.dz.sv/ev` 还原可视窗口。

## 验证

- `node --check public/chart.js` 通过。
- verify14：切回主层 `none`、预览层屏外；图例 3 行 not 遮挡刻度。
- verify15：切回后宽度 390→360，主层归零、预览层 `translateX(360px)`。
- gold3：sz000807 涨幅 >9.5% 的 2 根（idx 149/186，最高 10.11%）与金黄色 borderColor 完全对应。
- verify16：高度 653→409 后 grid 重算（tops 16/239/332），transform 仍归零。
- verify17：副图区左右滑可正常切到 sz000936 并切回 sz000807。
- verify18：副图区滑动中被 `pointercancel` 打断 → 主层归位、预览层回到 390px 屏外、code 未变。
- 截图：`/tmp/uitest/shots/40-gold.png`、`41-switchback.png`、`42-resize.png`。

## 遗留

- 手势只测了合成 PointerEvent，真机 iOS/Android 的切后台恢复建议再点一遍确认。

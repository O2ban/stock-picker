---
title: 分时图整点竖线 + 10 点量比图例（2026-10-20）
category: 运行与发布
date: 2026-10-21
updated: 2026-10-21
status: active
tags: []
summary: 1. 分时 K 线图上按整点加浅色纵向网格线，含 10:00。 2. 量比图图例里显示 10:00 时刻的量比值：未到 10 点显示「-」，过 10 点后固定不变。 - 备份：/t…
---

# 分时图整点竖线 + 10 点量比图例（2026-10-20）

## 需求
1. 分时 K 线图上按整点加浅色纵向网格线，含 10:00。
2. 量比图图例里显示 10:00 时刻的量比值：未到 10 点显示「-」，过 10 点后固定不变。

## 实现（public/chart.js）
- 备份：`/tmp/chart.js.bak-hourlines`（123138 字节），改后 125214 字节。
- 新增 `HOUR_LINES`（buildTimelineOption 内，1044 行附近）：**以 09:30 开盘为锚点每小时一条**（通达信口径），
  即 10:30(槽60) / 11:30(槽120，午休分界) / 14:00(槽181)；10:00(槽30) 为额外单独加的那条。
  11:30 与 13:00(槽121) 相差 1 槽≈2px 视觉重合，只画 11:30。
  生成 markLine 数据项 `{xAxis: idx, lineStyle:{type:'solid', color: ...}}`。
  颜色：10:00 用 `rgba(255,255,255,.13)`（略亮），其余 `rgba(255,255,255,.07)`（极浅）。
  不用 xAxis.splitLine 的原因：category 轴会按每个类目画线，242 槽会变成满屏格纹。
- priceSeries 的 markLine 从「有昨收才建」改成「无条件建」，data 为昨收项 + HOUR_LINES（一个 series 只能有一个 markLine）。
- volSeries 新增 markLine（只放 HOUR_LINES），让竖线贯穿成交量副图。
- ratioSeries 的 markLine data 追加 HOUR_LINES，保留 y=1、y=3。
- 新增 `ratioAtTen(s)`（约 1200 行）：按 `TIMELINE_SLOT_IDX.get('1000')` 取槽位，读 `s.ratio[i]`；
  未生长到该槽时为 null → 返回 `'-'`；有值则 `toFixed(2)`。
- `renderTimelineLegend` 与 `renderTimelineLegendAt` 的行 2 追加 `legendItem('10点', '#8a7a44', ratioAtTen(s))`。

## 验证
- `node --check public/chart.js` → SYNTAX_OK；服务 3100 返回 200。
- `/tmp/verify_hour.mjs`：三条 series 的 markLine 均含 x=30/90/121/181，10:00 颜色 `rgba(255,255,255,.13)`，
  其余 `rgba(255,255,255,.07)`；RATIO 仍保留 y=1、y=3；图例含「10点 1.27」；页面无报错。
- 截图 `/tmp/hour2.png`（500×757，已复制到 notes/hour2.png）：
  图例 `["价格 7.79","均价 7.77","中 7.79","PP 7.79","HH 7.85","M20 7.78","VOL 8万","最高 7.85","最低 7.73","量比 0.58","10点 1.27"]`。
- 像素检测：主图竖线列 70/189/251/370 亮度分别 (44,46,45) / (30,31,31)×3，背景 (13,15,14) → 第一条（10:00）明显更亮，符合设计。
- 「未到 10 点显示 -」：`/tmp/verify_ratio10.mjs` 用 CDP Fetch 拦截把 `/api/timeline` 换成裁到 09:35 的真实数据
  （6 个点，last 0935），图例输出 `... "量比 1.87","10点 -"`，页面无报错 → 通过。

## 未做/注意
- 未提交代码；改动 7 处，按规则派 code-review 子代理检查后再定。
- 10:00 竖线在 09:30 前后无特殊处理，全天恒显（用户的诉求是固定参照）。

## 收口（VOL 图例口径 + 注释修正）
- `renderTimelineLegend` 的 VOL 改为取最新那一分钟的成交量柱值 `s.vols[k].value`（k = `s.live>=0 ? s.live : s.lastFilled`），不再显示全天累计量；格式化复用 `fmtVol`。
- `ratioAtTen` 上方注释修正：该位为 null 的真正原因是「10:00 那根的累计量还没从后端进来」，不是「槽位没长到 10:00」。
- 验证：`/tmp/verify_vol.mjs`（端口 9391）BEFORE/AFTER 图例完全一致（`RESTORE_MATCH true`），VOL 342 与最后一根柱值 342 相等，`ERRS none`。
- 回归：`node --check` SYNTAX_OK；`/tmp/verify_hour.mjs` 纵线 x=60/120/181/30、图例含「10点 1.27」，`PAGE ERRORS: none`。
- 文件现为 126576 字节。

## 追加：成交量图例去掉最高/最低
- `renderTimelineLegend`（约 1240）与 `renderTimelineLegendAt`（约 1814）的 legendRows[1] 只保留 `VOL`，删掉「最高」「最低」两格。
- 顶部行情条（renderTimelineQuote，约 1279-1280）里的最高/最低保留，不动。
- 回归：`node --check` SYNTAX_OK；`/tmp/verify_hour.mjs` items 为 价格/均价/中/PP/HH/M20/VOL/量比/10点，`PAGE ERRORS: none`；`/tmp/verify_vol.mjs` BEFORE==AFTER（`RESTORE_MATCH true`）、`VOL 342`、`ERRS none`。
- 文件现为 126290 字节。

## 追加：日/周线隐藏十字线后顶部行情条恢复最新
- 根因：`renderCrosshair`（K 线分支）末尾调 `renderQuote(index)`，把顶部行情条（价格/涨跌/最高/最低/开盘/量比/振幅/成交量/成交额）改成了所指那根的历史读数；`hideCrosshair()` → `restoreLegendLatest()` 之前只重画图例、没重画行情条。
- 修补：`restoreLegendLatest` 改为 K 线分支同时 `renderLegend(slot, last)` + `renderQuote(last)`；分时分支补 `renderTimelineQuote()`（分时行情条本身不随时间指针变，补一次保证一致）。
- 顺带把 `if (!slot || !slot.legendRows) return;` 拆开，避免 legendRows 缺失时连同行情条一起跳过。
- 验证 `/tmp/verify_quote_restore.mjs`（9392）：day/week 两周期 TAP#1 行情条变历史值 → TAP#2 恢复，`QUOTE_RESTORED true`、`LEGEND_RESTORED true`、`ERRS none`。
- 回归：`node --check` SYNTAX_OK；`/tmp/verify_kline_restore2.mjs` 四个 TAP 图例 MATCH_LATEST true/false 符合预期；`/tmp/verify_vol.mjs` RESTORE_MATCH true。
- 文件现为 126643 字节。

## 追加改动（10-20 23:40 之后）
1. **VOL 图例改瞬时口径**：原先是「实时总量优先、否则全天累计量」，与同一行价格/均价/量比的瞬时口径不一致，且十字线点中某分钟时显示的是那根柱子的量、取消后跳成累计量，前后不连贯。改为固定取当前槽位的成交量柱；全天累计量在上方行情条里已有。最高/最低两项从图例里移除（行情条上已有更醒目的展示）。
2. **restoreLegendLatest 补全**：十字线关闭 / 换股 / 切换周期时，除了图例行，还要重画顶部行情条（分时 renderTimelineQuote、日K renderQuote）。否则价格、涨跌、最高最低、成交额会停在十字线所指的那一天。
   同时把 legendRows 的空判断放宽为仅 slot 存在即可，避免行情条因为图例行尚未建好而漏刷新。

## 回归验证（10-21 06:40）
- node --check 通过；服务 3100 返回 200。
- verify_hour.mjs：VOL 与 RATIO 两段的 markLine 均含整点竖线（实测输出含 x=30/120/181，10:00 对应 x=30）；RATIO 轴保留 y=1 / y=3 参照线；图例含「10点 1.51」。PAGE ERRORS: none。
- verify_restore.mjs（分时）：BEFORE 价格7.79 / VOL 342 / 量比0.69 → LOCKED 价格7.78 / VOL 415 / 量比1.36 → AFTER 完全回到 BEFORE。行情条三次一致。
- verify_restore_k.mjs（日K）：BEFORE 行情条 2026-10-20 7.79 → LOCKED 2026-06-23 7.29 → AFTER 回到 2026-10-20 7.79；MA5 7.84/VOL 8万/DIF 0.040 同步回归。
- 当前 chart.js 126643 字节，快照 /tmp/chart.js.snap-now。

---
id: memory-593
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-10-23T20:23:26+08:00
updated: 2026-10-23T20:23:26+08:00
importance: medium
category: 知识
keywords: [停牌填充, fillSuspendedDays, daily_indicators, daily_kline, OHLC口径]
summary: daily_indicators 的 close 经 fillSuspendedDays 用前收填充，daily_kline 的 OHLC 停牌日为 null，当前两边 expr 取 OHLC 均得 null 故一致，但若未来填充 OHLC 会立刻不一致。
---
precompute.js 的 fillSuspendedDays 只填 close，不填 open/high/low；daily_kline 停牌日 open/high/low 为 null。完整扫描通过 loadRecentDaily 合并 OHLC 到 daily_indicators 行，拿到的也是 daily_kline 的 null，所以 expr 用 field 'open'/'high'/'low' 时两阶段当前一致。这是残留风险而非现状缺陷：一旦有人给 OHLC 也做填充，预筛与完整扫描会立刻分叉。改动填充逻辑时必须同步两阶段口径。

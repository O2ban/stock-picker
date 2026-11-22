---
id: memory-588
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-10-23T20:23:26+08:00
updated: 2026-10-23T20:23:26+08:00
importance: high
category: 错误教训
keywords: [预筛, prefilter, baseDate, 日期错位, 误杀, 回看历史, loadShortDaily, 宁大勿小]
summary: 选股预筛必须与完整扫描使用同一个基准日，否则回看历史日期时会拿今天的数据淘汰股票，造成系统性漏票。
---
stock-picker 预筛（短窗淘汰浅条件）最初 loadShortDaily 只取 daily_kline 最近 N 根，不带上界日期；而完整扫描用 baseDate=strategy.baseDate||dataLatest 作上界。回看历史日期时预筛拿今天的收盘价判 close_above_ma/volume_ratio，把本应通过的票误杀——实测同一策略回看 10 月 16 日，关预筛选出 18 只，开预筛只剩 2 只。根因是两阶段在『最后一根 bar 是哪天』这个前提上就不对齐，前面所有 lookback 精确性证明都不成立。修法：预筛调用侧显式传入与 buildLoader 相同的 scanBaseDate，并对 prefilterRealtime 要求 scanBaseDate===dataLatest。教训：任何『先粗筛再精算』的两阶段管道，两阶段的数据窗口/基准日必须严格一致，否则粗筛会静默丢结果，且界面还正常展示『预筛 5373→460』统计暗示已严格筛选。

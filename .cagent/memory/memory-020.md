---
id: memory-020
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-09-29T08:55:58+08:00
updated: 2026-09-29T08:55:58+08:00
importance: high
category: 其他
keywords: [stock-picker, precompute-schema, field-naming, ma5, week_start, qfq-only, column-mismatch]
summary: stock-picker 预计算表实际字段名细节：指标字段无下划线（ma5/vr5 而非 ma_5）、周线主键是 week_start 而非 date、daily_kline 无裸 OHLCV 只有 qfq/hfq/raw 三套复权字段，改造 db.js 时必须严格对齐，否则运行时直接抛 no such column。
---
在 stock-picker 落地预计算读取 API（db.js）时踩到的三处字段命名坑，全部是 SQL 运行时才炸出来的：

1. **daily_indicators / weekly_indicators 的指标列名无下划线**：实际是 `ma5 ma10 ma20 ma60` 和 `vr5 vr10 vr20 vr60`，不是 `ma_5`。precompute.js 里 INSERT 用的是无下划线版本，db.js 初版照抄了 memory-018 里的带下划线描述导致 SELECT 报 no such column。

2. **weekly_kline 的主键字段是 `week_start` 不是 `date`**：日线表用 `date`，周线表用 `week_start`（YYYY-WW 或 ISO 周起日），跨周期查询时必须显式指定。

3. **daily_kline 没有裸的 open/high/low/close/vol/amount**：实际列名是 `open_qfq/open_hfq/open_raw`（high/low/close/vol/amount 同理三套）。因为 kline.db 只存三种复权视角，SELECT 时必须显式选一套（默认 qfq）才能拿值。

这三点都是 SQL schema 层面的硬事实，precompute.js 已经写对，问题都在消费者侧（db.js / engine.js / server.js）初版实现照搬了设计文档的描述而非实际表结构。今后凡是加新表或新字段的 SQL 逻辑，第一步必须是 `.schema kline.db | grep 表名` 核对真实列名，不要从设计文档或记忆条目反推。

补充：本次全量 precompute 耗时 2 分 18 秒，5566 只股票产出 9,429,949 条日线指标 + 1,989,715 条周线指标 + 1,989,715 条周线 K 线，主库从 2047 MB 涨到约 2667 MB。

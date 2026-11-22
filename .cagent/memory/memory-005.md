---
id: memory-005
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-09-21T18:43:55+08:00
updated: 2026-09-21T18:43:55+08:00
importance: medium
keywords: [数据适配层, 演示数据, SQLite, kline.db, 零依赖启动]
summary: stock-picker 的数据适配层同时支持真实 kline.db 和内置演示数据，确保GitHub新用户无需准备行情库即可运行。
---
stock-picker 后端核心实现中保留清晰的'数据适配层'：真实库按旧项目字段（stocks + daily_kline，价格列 *_raw/qfq/hfq，成交量列 vol）读取；读不到数据库时返回小型演示数据。这样本地开发、GitHub Demo 和接入真实数据三种场景共用同一套选股引擎，无需预先准备完整行情库。

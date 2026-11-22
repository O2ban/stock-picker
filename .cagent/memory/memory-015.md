---
id: memory-015
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-09-21T22:35:04+08:00
updated: 2026-09-21T22:47:29+08:00
importance: medium
keywords: [stock-picker, performance, n+1-query, synchronous-blocking, kline-repeat-load, event-loop, browser-timeout]
summary: stock-picker 选股引擎慢的根因是同一只股票在条件判断/评分/结果生成阶段被重复加载 2-5 次全历史日线（N+1 模式），叠加 Node 同步串行执行阻塞事件循环，5574 只股票累计上万次查询会触发浏览器请求超时。
---
在 stock-picker 项目中验证过的事实：SQL 单条查询本身已走主键索引并不慢，索引优化收益有限；真正瓶颈是选股引擎的访问模式——同一只股票的日线数据在多个阶段被重复读取（条件间各查一次、评分再查、结果生成再查），全市场扫描累计上万次数据库查询，且 Node 侧是同步串行执行会阻塞事件循环，导致前端请求超时表现为 Failed to fetch。优化方向：1) 每只股票单次加载并复用（single-load / 按需要的数据窗口读取），把重复加载合并为一次；2) 缩小扫描入口的股票数量（见选股范围可配置功能）；3) 避免全市场逐只串行扫描。这条经验适用于任何基于 SQLite/本地库的股票筛选引擎，可作为通用诊断模式。

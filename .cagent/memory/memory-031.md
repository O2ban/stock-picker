---
id: memory-031
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-10-06T21:59:08+08:00
updated: 2026-10-23T20:03:45+08:00
importance: medium
category: 错误教训
keywords: [strategyId, starter兜底, 参数被忽略, 测试假象, prefilter统计为空, stock-picker]
summary: stock-picker 的 POST /api/screenings 曾完全忽略 body.strategyId 而无条件回退 starter，导致用 strategyId 做的所有对比测试实际都跑在默认策略上、预筛统计显示无浅条件。
---
排查预筛『no shallow conditions』时发现是接口层 bug 而非预筛逻辑问题：server.js 的 POST /api/screenings 只读 body.strategy，不查 body.strategyId，策略库按名调用一律被 strategies.get('starter') 兜底。后果是传入 low-suck-v2 的请求实际按 starter 执行，任何『换个策略名对比』的测试都无效。教训：做策略级对比实验前，先用返回体或调试日志确认服务端真的用上了指定的策略，而不是相信请求参数。修复为 body.strategy || strategies.get(body.strategyId) || strategies.get('starter')。

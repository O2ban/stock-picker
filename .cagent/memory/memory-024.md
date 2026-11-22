---
id: memory-024
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-10-01T19:02:35+08:00
updated: 2026-10-01T19:02:35+08:00
importance: medium
category: 其他
keywords: [stock-picker, weekly-half-week, tdx-vs-precompute, judge-conservative, incomplete-period, hidden-bias]
summary: stock-picker 预计算表周线最新一根日期落后日线数天，因为不完整周未入库；而通达信包含进行中的当前周数据——这会导致'周线站上均线'判断偏保守，可能漏选部分实际符合条件的票，是隐藏在指标口径下的选股偏差。
---
具体表现：日线最新日期是 9-18，周线最新日期是 9-14。周线以周一为 week_start 存储，9-14 那一周还在进行中（只到周三），若按'只有完整周才入库'的规则，最新一根完整周是 9-07 到 9-11 那一周。通达信的周线判断是包含当周未完成部分的（周线站上均线判断用的是含今天为止的当周数据），预计算库不包含，判断更严格。修复方案有两条：预计算时把进行中的当前周也入库并标记为'未完成'；或选股时优先取最新那周（含未完成）而非最新完整周。当前状态：尚未修，速度优化完成后再决定。

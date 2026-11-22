---
id: memory-027
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-10-06T17:33:04+08:00
updated: 2026-10-06T17:33:04+08:00
importance: medium
category: 其他
keywords: [calcNeedDays, scanWindowDays, strategy-param, data-fetch, decoupling, over-fetching, stock-picker]
summary: stock-picker取数天数应从策略最长参数自动推导(calcNeedDays)，与前端扫描窗口天数(scanWindowDays)解耦——之前取max导致取90天而非策略实际需要的25天。
---
原逻辑needDays=Math.max(scanWindowDays, calcNeedDays(strategy))，scanWindowDays默认90天(用户想看多少天结果)，calcNeedDays从策略参数推导(如MA20→20+5=25天)。取max后实际取90天，但选股逻辑只看最后一天的指标值。改为needDays=calcNeedDays(strategy)后取数从90天降到25天，减少72%数据量。scanWindowDays只影响结果展示哪些天，不影响取数行数。这是memory-291全局原则在项目中的具体落地。注意：预计算指标已存入每行，引擎不需额外预热期算MA，calcNeedDays只需覆盖策略最大length+5天缓冲。

---
id: memory-030
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-10-06T21:59:08+08:00
updated: 2026-10-06T21:59:08+08:00
importance: medium
category: 其他
keywords: [stock-picker, time-filter, partial-branch, silent-failure, adjust-mode, hfq-raw, filter-bypass, stock-picker, 假生效]
summary: stock-picker 时间筛选只在主分支生效，切到'后复权/未复权'时后端分支绕过了日期裁剪走全量取数再现场聚合，界面显示'三个月前'但结果是'截至最新'，是最危险的假生效形态。
---
排查发现：stock-picker 增加基准日筛选后，主分支（前复权/日线）能正确裁剪历史日期，但切换到'后复权/未复权'或走周线聚合的分叉路径时，代码走的是另一条 loadRows 分支，该分支没有做时间裁剪，直接把完整历史拉下来再现场计算，导致时间筛选在这些场景下完全失效。表现：前端显示'基准日=三个月前'，实际结果是'最新'，用户看不出区别，属于典型的 silent failure。修复原则：所有数据入口分支（含复权切换、周期切换、缓存命中/未命中）必须走同一个时间裁剪入口，不能只在主分支做。同类'多分支数据链路加新参数'时都应审计每个分支的生效性。

---
id: memory-591
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-10-23T20:23:26+08:00
updated: 2026-10-23T20:23:26+08:00
importance: medium
category: 方法经验
keywords: [prefilterStats, enabled语义, 字段语义, API契约, false与全放行]
summary: 统计字段初始化时 enabled=false 却已填 universe/survived 会让 API 消费方误读为『跑过预筛且全通过』，未启用时应只返回 enabled:false。
---
prefilterStats 初始化为 {enabled:false, bars:0, conditionCount:0, universe:stocks.length, survived:stocks.length}，前端因判了 run.prefilter.enabled 才展示所以无碍，但第三方消费/日志/测试会误以为跑过预筛。语义上『未启用』与『启用但全放行』应区分，未启用时只返回 enabled/bars/conditionCount 或加 skipped 布尔。

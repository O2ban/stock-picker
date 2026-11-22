---
id: memory-643
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-11-19T01:27:45+08:00
updated: 2026-11-19T01:27:45+08:00
importance: medium
category: 错误教训
keywords: [excludeLimitUp, 未来函数, 当日最后一根, 9.8魔数, 复盘历史日]
summary: 触发判定链全部只用决策时前缀量、无未来函数，但 excludeLimitUp 用当日最后一根K线的价格过滤，回放历史日时等于用全天收盘价决定是否入选，且9.8%阈值硬编码（默认关闭）。
---
M1：intraday.js 的 excludeLimitUp 用 s.price[s.price.length-1] 过滤，复盘历史日时等于拿全天结束价决定是否入选，9.8 是写死的魔数。当前 excludeLimitUp:false 默认关闭，只在打开开关后触发。注意 buildSeries→volBase→shapeOk→volumeShape→findTrigger 这条主判定链全部是前缀量（mid/volBase/volumeShape 都只用 ≤i 的数据），无未来函数。

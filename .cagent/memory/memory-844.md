---
id: memory-844
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-11-21T20:28:55+08:00
updated: 2026-11-21T23:25:36+08:00
importance: high
category: 方法经验
keywords: [本地分时数据, ev301557-data.json, 离线分时, 无网络依赖, stock-picker]
summary: stock-picker 的 301557 复盘数据文件 ev301557-data.json 自带100个交易日、每天240槽的完整分时序列，可本地直接画任意一天分时，无需请求只覆盖近5天的在线接口。
---
复盘视图的历史分时不应依赖在线分时接口（免费接口只留最近5个交易日，历史日期必然为空）。ev301557-data.json 里已包含100个交易日、每天240个槽位的完整分时序列（收盘/最高/最低），任意一天都能本地直接绘制，彻底摆脱网络依赖。后续做其他票的历史复盘时，应优先确认导出的静态数据文件是否已携带分钟级序列。

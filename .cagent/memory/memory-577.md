---
id: memory-577
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-10-21T21:22:11+08:00
updated: 2026-10-21T22:43:42+08:00
importance: high
category: 方法经验
keywords: [离线提示, 数据留存时刻, 时间戳透传, IndexedDB, stock-picker]
summary: 离线提示里的「留存时刻」在数据链路上被丢弃过——K线和分时都带出了本地留存的时刻但没被使用，导致只能显示数据本身的日期；需把留存时间戳一路带到展示层并格式化（YYYYMMDD 数字串）。
---
stock-picker 离线顶部提示要显示「这份数据是什么时候存下来的」而非「数据本身是哪一天的」。实现要点：IndexedDB 留存记录里要同时保存并透传写入时刻，K 线程与分时线程分别取本地的留存时间戳，格式化时注意日期是 YYYYMMDD 数字串。另外需处理数据库被旧标签页占用导致升级一直卡在等待、断网时读不到缓存的兜底逻辑。

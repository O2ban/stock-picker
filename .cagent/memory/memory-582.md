---
id: memory-582
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-10-23T14:00:31+08:00
updated: 2026-10-23T14:00:31+08:00
importance: medium
category: 方法经验
keywords: [冷启动, 热态, 随机IO, 页缓存, 性能归因, stock-picker]
summary: 同一查询首次十几秒、后续秒级时应归因为数据未进OS页缓存且内存装不下全量，而不是网络或代码慢；真正的敌人是随机跳页次数。
---
判断性能问题前先区分冷态与热态：冷启动耗时来自磁盘随机 IO（按 code 逐只跳页、页缓存缺失），热态快是因为数据留在内存。
因此：（1）任何性能测量都要标明冷/热；（2）优化方向应是减少随机访问次数（先粗筛缩小集合、按股票聚集存储、加 date 索引改范围查询），而不是单纯提升 CPU 或加缓存；（3）独立小库常驻内存能消除冷热落差。

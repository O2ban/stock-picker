---
id: memory-836
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-11-21T16:13:14+08:00
updated: 2026-11-21T16:13:14+08:00
importance: medium
category: 工具资源
keywords: [磁盘余量, 1分钟缓存, 批量回测, 边跑边清]
summary: 单日全市场 1 分钟缓存约 54MB（本次 8/6 留在本地备查），而磁盘只剩 5.5G——批量跑多日回测必须边跑边清缓存，否则很快写满。
---
8/6 全市场 1 分钟缓存约 54MB。当时机器磁盘剩余 5.5G，若要多日批量回测需边跑边清。这条与 memory-062（分钟数据入库量级）和 memory-815（分时归档只存被选中票）的存储约束一脉相承：全量分钟数据只做临时缓存，不长期保留。

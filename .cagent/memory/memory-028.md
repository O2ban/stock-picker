---
id: memory-028
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-10-06T17:33:04+08:00
updated: 2026-10-06T17:33:04+08:00
importance: medium
category: 其他
keywords: [weekly-splice, current-week, daily-to-weekly, realtime, stock-picker, precompute-gap, tdx-consistency]
summary: stock-picker当前周周线实时拼合方案：从日线数据提取本周交易日聚合收盘/成交量，从历史完整周线推导本周均线/量比，追加到weeklyMap末尾，消除通达信含当前周而预计算只存完整周的选股偏差。
---
预计算表只存完整周(上周五结束才入库)，当前进行中的周未存，导致'周线站上均线'判断偏保守漏选票。方案：取完日线后按ISO周分组识别当前周的所有日线行，本周收盘价取最新价、成交量累加，本周MA从历史完整周MA均值+本周收盘推导(MA_n = sum(前N-1周MA + 本周收盘)/N)，本周VR=本周累计量/前N周均量，拼合成完整周线追加到weeklyMap末尾。这样当前周周线值与通达信一致，解决memory-024记录的隐性选股偏差。

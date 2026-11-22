---
id: memory-056
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-10-19T13:42:15+08:00
updated: 2026-10-19T13:42:15+08:00
importance: medium
category: 其他
keywords: [stock-picker, applyQuote, 最后一根K线, period-guard, kline-3day-ttl, 价格与图形不一致, 实时价并图]
summary: stock-picker「价格是活的、图形是昨天的」不一致属刻意设计（applyQuote 只把实时价并进日线最后一根，K 线走 3 天 TTL 的 IndexedDB 缓存），用户认为该不一致影响看图、已要求修改。
---
stock-picker 中 applyQuote 只把实时价并入最后一根日 K，且只在日线视图生效（周线/月线是聚合柱，塞今日价会把指标算错），K 线数据本身走 3 天 TTL 的 IndexedDB 缓存不随报价刷新。原设计认为这是刻意取舍，但用户明确指出『列表价格和涨幅是活的、图形形状是昨天的』在盘中造成明显不一致、影响看图，判定不合理并要求一并改掉。因此后续碰到『某处刻意设计是否可保留』的判断，应以用户实际看图体验为准，不能以『非 bug』为由拒绝修改。

---
id: memory-592
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-10-23T20:23:26+08:00
updated: 2026-10-23T20:23:26+08:00
importance: low
category: 方法经验
keywords: [loadShortDaily, 全市场拉取, codes过滤, 内存峰值, 预筛范围]
summary: 预筛 loadShortDaily 不按 stocks 过滤会拉全市场短窗数据并在整个请求期间常驻内存，应传 codes 或按股票集合过滤。
---
预筛 loadShortDaily 的 SQL 无 code IN 限制，哪怕只筛主板也装下 5000+ 票的 10 根日线（约 5-10 万行/50-100MB），applyRealtimeToDaily 又遍历全市场补 K，而后续只用其中一小部分。这块 shortMap 在整个请求期间存活，是明确的内存峰值。修法：loadShortDaily 加 codes 参数复用 queryByCodes 分块机制，或至少在 server 层按 new Set(stocks.map(s=>s.code)) 过滤。当前判断为值得记录但暂不动（几十兆/一两百毫秒）。

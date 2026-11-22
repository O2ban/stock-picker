---
id: memory-045
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-10-15T23:29:57+08:00
updated: 2026-10-15T23:58:09+08:00
importance: high
category: 其他
keywords: [stock-picker, 最新日k, 缓存TTL, eltdx, stale-while-revalidate, 数据落库节奏, chart.js, 看盘]
summary: stock-picker 看盘『最新日K不及时』的根因已定位：前端K线缓存TTL(3天，内存+IndexedDB双层)与 eltdx 数据源收盘后(15:45)落库节奏错位，而非接口慢(/api/kline 实测约0.01s)，修复为看盘主图 load 改 stale-while-revalidate。
---
『最新日K不及时』的根因不是接口性能，而是前端缓存时长与数据落库节奏错位：chart.js 的K线缓存 TTL 为3天(内存 + IndexedDB 双层)，而数据源 eltdx_downloader.py 由 kline-daily.timer 每交易日 15:45 收盘后才把当日日K增量落库，盘中库内最后一根仍是上一交易日。eltdx 更新后前端缓存不失效，主图直接命中旧缓存，末根停在上一交易日。
修复(public/chart.js)：主图 load 改为 stale-while-revalidate —— 先画缓存秒开，再强制回源核对覆盖(loadToken 丢弃快速换股/切周期的过期结果)；迷你K线与副图邻票预取仍走缓存(只影响列表预览，不必每次回源)，符合最小改动。
盘中实时链路本身正确无需改：库内无当日K时，/api/quotes 每60s轮询 + 前端 applyQuote 把当日实时价合成进末根(仅日线)，只是被旧缓存掩盖。
影响面：仅4个 public 静态文件(app.js/index.html/chart.css/chart.js)，静态文件实时读盘无需重启。

---
id: memory-660
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-11-19T09:59:07+08:00
updated: 2026-11-19T09:59:07+08:00
importance: medium
category: 方法经验
keywords: [历史分时, 今日行情污染, 缓存分层, 回看历史]
summary: 回看历史日期的分时需做保护防止被今日实时行情覆盖，且旧日期缓存与今日缓存应分开存放。
---
stock-picker 新增「按日期取历史分时」时，要确认回看旧日期时曲线最后一根、总点数、买点位置不会被今日实时价格刷新污染。实现上旧日期缓存与今日缓存分开存储。注意：全新缓存环境下只验证了代码分开存，未在真实浏览器跑到「旧日期缓存冲掉今日缓存」的极端情况，不能宣称百分百验证。

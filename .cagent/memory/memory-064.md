---
id: memory-064
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-10-19T19:16:03+08:00
updated: 2026-10-19T19:16:03+08:00
importance: high
category: 其他
keywords: [loadMs, 统计口径, engineMs, elapsedMs-loadMs, 冷读盘, 页缓存, 性能归因, stock-picker]
summary: stock-picker 线上 25.7s 异常不是引擎慢，而是统计口径记错（elapsedMs - loadMs 才是 engine，实测仅 1.3~1.5s）+ 数据库冷读盘（清空 OS 页缓存后 loadMs 24.7s），冷读盘比任何 JS 层优化重要两个数量级。
---
排查 stock-picker 线上首跑 25.7s 异常时，发现两件事：
1. 统计口径记错：`elapsedMs - loadMs` 才是 engine 时间。engine 冷/热分别只有 1471ms 和 1339ms，差异在噪声范围内，尾部求值在线上是稳的。之前报的「首跑 engineMs 25732」是把耗时全算到 engine 上了。
2. 真正的异常是数据库冷读盘：清空操作系统页缓存后重放同一请求，loadMs 达 24736ms，总耗时 26295ms。而 SQL 层冷/热只差 1.8 倍。

另一个前置经验：确认 `loadMs` 统计范围有效——如果 loader 是惰性的、真正的 DB 读取发生在 screenChunk 回调里，那这个统计就是假的。本例中 loader 在构造时同步查完，所以「瓶颈在取数层」成立。

结论：性能异常归因前必须先用受控实验（清页缓存重放）区分「冷读盘」与「代码慢」，冷读盘的量级远超 JS 层优化空间，方向选错等于白干。另注意 `passed 0` 这类疑点常是读错字段（把 count/limit 当 passed），重放自证即可关闭。

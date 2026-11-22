---
id: memory-448
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-10-20T09:27:23+08:00
updated: 2026-10-20T09:27:23+08:00
importance: medium
category: 错误教训
keywords: [跨日, timeline, 每3秒请求, 限流, tlDatePair, 停牌]
summary: 跨日时若行情日期已翻新而后端 timeline 仍停在旧日（如停牌），updateTimelineTail 每个 tick 都会 api.load()，把 30 秒校准放大成每 3 秒一次打到上游，需用日期对去重限流。
---
分时图存在一类跨日放大缺陷：一旦行情日期翻到新的一天，而后端 timeline 还停在旧的一天（个股停牌时常见），updateTimelineTail 的每个 3 秒 tick 都会判定需要重新加载并调用 api.load()，把本该 30 秒一次的校准放大成 3 秒一次直击上游。修复方式是用 tlDatePair（行情日 + timeline 日）做限流判据，日期对未变化就不重复发起加载。同类『轮询内触发校准/重载』逻辑都应显式记录上一次实际加载的日期对或版本号，避免状态不前进时无限重发。

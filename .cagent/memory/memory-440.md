---
id: memory-440
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-10-20T00:10:07+08:00
updated: 2026-10-20T00:10:07+08:00
importance: medium
category: 代码逻辑
keywords: [腾讯行情, 并发承受力, qt.gtimg.cn, mkline, minute/query, 分时图vs分钟K线, 腾讯源]
summary: 腾讯行情源实测无并发限制（行情接口 30 并发×60 只、连续 200 轮 0 失败，分时接口 60 并发全成功），分时图与分钟K线是两种不同需求：当日分时图腾讯完全够用，历史分钟K线必须走 eltdx（历史深度差两个数量级）。
---
对 stock-picker 的腾讯源（qt.gtimg.cn）实测结论：行情接口 30 并发×60 只（1800只/轮）30/30 成功、平均 40ms；连续 200 轮×60 只共 12000 次查询全成功，P50 11ms、P95 13ms；分时接口 60 并发全成功、平均 60ms。「腾讯源扛不住并发」不成立，且现有代码有 5 秒缓存、in-flight 去重、60 只分批，单用户看盘触不到上游。需区分两种需求：当日分时图（minute/query 返回 267 点，字段为时间/价格/累计量/累计额，画均价线用累计量）腾讯是强项；历史分钟K线腾讯 mkline 只有几天历史，eltdx 实测 1min 全量 22080 根约 4 个月、5min 全量 23856 根约 2 年，单只 1min 320 根 11ms、批量 10 只 30ms，历史深度差两个数量级。所以是分层而非替换：实时价格+当日分时走腾讯，历史分钟K线走 eltdx 增量落库，日/周/月线维持 kline.db。注意 eltdx 批量快照只要混入一个无效代码（如 sz000003）就整批抛 ProtocolError，接入前必须先过滤代码。

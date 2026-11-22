---
id: memory-025
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-10-01T19:02:35+08:00
updated: 2026-10-19T19:16:03+08:00
importance: high
category: 其他
keywords: [两次查询合并, 停牌填充, daily_indicators, daily_kline, 两表等价, 随机IO减半, stock-picker, 纯expr策略]
summary: stock-picker 取数层发现同一窗口 437364 行被 daily_indicators 和 daily_kline 完整读了两遍，两表 close/vol 完全一致（停牌填充在入库阶段已写进 kline），纯 expr 策略可合并为单次查询，冷盘 21.3s→11.0s、热盘 1.78x。
---
stock-picker 取数层浪费点：`loadIndicators`(473ms) + `loadRecentDaily`(963ms) + 字符串键建表(371ms) + 行映射(171ms) ≈ 2.0s，两次查询返回的是同一批 437364 行，同一段窗口的数据被完整读了两遍。

合并前提已验证死：
- 近两年 266 万行全量比对，closeDiff 0、volDiff 0
- 全库 indicators 与 kline 行数都是 9513347，join 后一行不少，不存在「只有指标表才有的停牌填充行」
- kline.vol=0 而 indicator.vol>0 的行数：0
- 停牌填充是在入库阶段就写进 daily_kline 的

收益实测（冷/热交替各两轮）：两次查询冷盘 21.2/21.6s、热盘 968ms；单查 kline（含 close_qfq/vol/OHLC）冷盘 10.9/11.1s、热盘 544ms。原理是随机 I/O 次数减半，不是省那 0.8s JS 开销。

安全落地条件：仅在策略「需要 OHLC」且「不需要预计算 ma*/vr* 列」时（纯 expr 策略，如 low-suck-v2）走单次 loadRecentDaily 并顺手填 o/h/l；需要 ma*/vr* 的策略、adjust !== 'qfq' 全部保持原样。改动面只有 server.js 一个分支，db.js 和 engine 不动。

风险：该优化把「两表等价」固化成前提，将来若预计算脚本改停牌填充口径或复权基准，这个分支会静默产生偏差且不报错，对拍必须专门覆盖停牌股和除权股。

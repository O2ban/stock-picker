---
id: memory-066
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-10-19T19:45:19+08:00
updated: 2026-10-19T19:45:19+08:00
importance: high
category: 其他
keywords: [loadMs, 统计口径, 冷读盘, engineMs, elapsedMs-loadMs, 页缓存, 性能归因, stock-picker, 两查合一, daily_indicators, daily_kline]
summary: stock-picker「两查合一」改动已实施上线：同一窗口数据被 daily_indicators 和 daily_kline 各读一遍合并为单次查询，热缓存 loadMs 2.5s→1.3s、冷缓存 24.7s→14.3s，选股结果与改前完全一致（停牌/除权股逐行核对无差异）。
---
stock-picker 性能优化的最终成果与关键认知：

一、25 秒冷启动的真因不是引擎慢，而是统计口径记错 + 数据库冷读盘。elapsedMs - loadMs 才是引擎耗时（实测仅 1.3~1.5s），loadMs 是取数耗时。冷缓存时数据压在硬盘，首次需逐页翻出约 24.7s；操作系统页缓存命中后只需 2.5s。冷读盘的开销比任何 JS 层优化都重要两个数量级。

二、已实施的「两查合一」优化：同一扫描窗口的数据被 daily_indicators 和 daily_kline 完整读了两遍（两表 close/vol 完全一致，停牌填充在入库阶段已写进 kline），合并为单次查询。改动 3 处，全在 buildLoader 内，备份路径 /tmp/server.js.bak-onepass-1923。

三、实测收益：热缓存 loadMs 约 2.5s → 约 1.3s（省一半），冷缓存 24.7s → 14.3s，选股结果仍为 23 只且代码与改前完全一致。8 组对照明细全等，停牌股、除权股专项逐行核对一致。

四、风险点：合并查询建立在「两份数据永远一样」的假设上，若上游生成数据的程序改规则，两边会静默对不上且不报错，只会导致选股结果错但不报错。因此验证必须专门拿停牌股、除权股对照。

五、无害差异（已记录）：合并查询路径取出的行带真实成交额，原路径成交额恒为 0。选股表达式只读开高低收和成交量，成交额不参与任何判断，对结果无影响。

六、审查结论：可以放行，无 P0/P1。被标为 P2 的『量比回退分支把当天算进分母』是误报——当前代码早就是『不含当天』，是旧版本遗留判断。

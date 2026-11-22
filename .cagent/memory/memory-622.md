---
id: memory-622
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-11-16T23:31:17+08:00
updated: 2026-11-16T23:52:58+08:00
importance: medium
category: 方法经验
keywords: [stock-strategy, backtest, stop-loss, stop-profit, parameter-sensitivity, zero-sum]
summary: 在高频波动的股票池中，单纯调整止损/止盈幅度无法扭转负期望值，必须改变选股逻辑或引入新信息维度。
---
当策略的选股条件与止损/止盈设置存在内在矛盾（如选出高波动票却设小止损）时，扫描参数空间发现所有组合均为负收益。这是因为止损放宽减少了被扫单比例，但单次亏损金额增加，两者抵消且被手续费击穿。参数调优无法解决'无alpha'的问题，需从根本上改变选股逻辑（如从过去形态转向今日新信号）。

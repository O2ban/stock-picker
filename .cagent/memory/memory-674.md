---
id: memory-674
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-11-19T22:46:24+08:00
updated: 2026-11-19T22:46:24+08:00
importance: high
category: 错误教训
keywords: [look-ahead-bias, future-function, last-bar-of-day, excludeLimitUp, backtest, stock-picker]
summary: 选股/回测的条件若使用『当日最后一根K线』的价格（如用收盘价过滤涨停），回放历史日时等于提前看到全天结果，是最隐蔽的未来函数。
---
stock-picker 日内策略的触发链虽然全用决策时前缀量、本身无未来函数，但 excludeLimitUp 用当日最后一根K线的价格判断是否涨停并过滤，回放历史日时等于用全天收盘价决定当天是否入选，属于前视偏差。叠加 9.8% 硬编码阈值（默认关闭）。教训：任何『用当天全量数据算出的标量』做过滤条件，只要它在回测时点尚未产生，就是未来函数；回测前必须按此标准逐条检查每个条件的取值时点，而不是只看它是不是用前缀量计算。

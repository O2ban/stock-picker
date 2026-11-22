---
id: memory-021
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-09-29T08:55:58+08:00
updated: 2026-09-29T08:55:58+08:00
importance: high
category: 其他
keywords: [stock-picker, engine-architecture, loadRows-callback, precompute-integration, minimal-change, callback-injection]
summary: stock-picker 预计算接入引擎采用『换 loadRows 回调』而非改 engine 内部：engine.runScreen 通过 loadRows(code, adjust) 回调拿数据，只需在 server.js 传一个走预计算查表+今日补齐的新回调，engine.js 一行不改，改动面最小。
---
在 stock-picker 把预计算表接入现有选股引擎时，有两条路可选：

- **方案 A（换回调）**：engine.js 的 runScreen(strategy, stocks, loadRows, { adjust }) 签名完全不动，aggregatePeriod / sma / ma_cross_up 等内部函数照常工作。改造只在 server.js 里把 loadRows 换成『预计算查表 + 今日实时补齐 MA』的新实现。engine 拿到的仍是 [{d, c, h, l, v, a, ma5, ...}] 数组，只是数据来源从『daily_kline 现算指标』变成『daily_indicators 查表 + 补一行今日实时数据』。

- **方案 B（专用入口）**：给 engine.js 加 runScreenPrecomputed 专用入口，直接消费预计算表结构，改动深但语义更清晰。

最终选方案 A。理由：

1. 预计算查询本身就带 warmup 期完整 60+ 行数据，engine 拿到的数组结构和之前一样，位置引用（如 rows.at(-2) 判断 MA 交叉）语义不变。
2. 改动集中在 server.js 一处，engine.js / aggregatePeriod / indicatorResult 全部零改动，回归测试面最小。
3. 『今日实时补齐』天然属于数据源职责而非计算职责，放到 loadRows 回调里比塞进 engine 内部更符合单一职责。

这个模式可复用到任何『已有 callback 注入式引擎 + 新数据源』的重构场景：优先动注入点而非引擎本体，除非语义真的对不上。

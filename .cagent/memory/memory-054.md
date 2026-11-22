---
id: memory-054
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-10-19T13:05:44+08:00
updated: 2026-11-20T00:16:20+08:00
importance: medium
category: 方法经验
keywords: [intraday.js, 测试缺口, 回归断言, findTrigger, volumeShape, shapeOk, stock-picker]
summary: 日内分时引擎 intraday.js 目前没有任何自动化单元测试（test-engine.mjs 只覆盖日线 engine.js），这些口径只有人工回测记录，改条件时没有回归断言能发现老规则被顺手改坏。
---
stock-picker 的 test-engine.mjs 仅覆盖日线引擎（engine.js 的 aggregatePeriod/validateStrategy/runScreen/expr），对 src/intraday.js 完全没有断言：findTrigger、volumeShape、shapeOk、validateIntradayStrategy、breakHigh、deepDrop、fromLow 均无单元测试，验证只能靠 notes/intraday-strong-stock-validation.md 的人工回测记录。
这形成“改条件无保护网”的结构性风险。建议在策略定型后补最小断言集：①买点必须 ≥ 昨收且 ≥ 分时中线；②买点涨幅 > 2% 被剔除；③形态反转在锚点与买点两处各查一次；④成交量三段结构最少 5 根（缩量 ≥3、上拉 ≥2）；⑤deepDrop 用前缀最低、无未来函数。

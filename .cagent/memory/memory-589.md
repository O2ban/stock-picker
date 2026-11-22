---
id: memory-589
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-10-23T20:23:26+08:00
updated: 2026-10-23T20:23:26+08:00
importance: medium
category: 方法经验
keywords: [prefilter, 一致性验证, 不变量断言, 预筛结果集, 完整扫描]
summary: 预筛类优化的核心验收标准是同策略同 baseDate 下『预筛结果集 == 完整扫描结果集』，应作为不变量断言测试。
---
预筛/短路等性能优化改变的是执行路径而非语义，验收必须验证语义等价性：相同策略、相同 baseDate 下，开启预筛与关闭预筛的结果集和排名必须完全一致（实测 18 只 vs 18 只、100 只 vs 100 只）。仓库原本只有 test-engine.mjs，缺少 loadShortDaily 边界（空数据、toDate 早于最新日）、evaluateConditions unknown 分支、以及两阶段一致性的自动化测试，建议补『预筛结果集 == 完整扫描结果集』的不变量断言测试。这与引擎条件短路的对拍验证同一原则。

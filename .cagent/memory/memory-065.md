---
id: memory-065
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-10-19T19:16:03+08:00
updated: 2026-10-19T19:16:03+08:00
importance: medium
category: 其他
keywords: [周线优化, eager预取, 收益结构性低, slice-reduce, 分母固定开销, stock-picker, 投入产出]
summary: stock-picker 周线只提速 1.05x 属结构性收益低（周线表行数少、裁掉的 slice/reduce 在总成本占比极小，分母是取数固定开销），不值得为它加 eager 预取用复杂度换不可感知收益。
---
stock-picker 周线性能优化只做到 1.05x，判断为结构性收益低而非实现不到位：
- 周线预聚合表本身行数就少，能裁掉的 slice/reduce 在总成本里占比很小
- 分母是取数这种固定开销，无论怎么优化 JS 聚合都改不动

结论：为它加 eager 预取是用复杂度换不到用户能感知的收益，不再投入。这是「先算清收益上限再决定是否优化」的一个范例——低收益若来自结构性原因，追加工程投入没有意义。

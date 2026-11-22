---
id: memory-048
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-10-19T12:41:50+08:00
updated: 2026-10-19T12:41:50+08:00
importance: medium
category: 其他
keywords: [stock-picker, 子代理审查, 自动重排, 收尾遗漏, 渲染函数重绘, 审查价值]
summary: stock-picker 排序功能中两个隐患（迷你K线消失、邻票不同步）是子代理只读审查发现的，说明列表重建类改动应收敛到渲染函数而非散落在各触发路径。
---
在 stock-picker 排序功能中，自测通过后请子代理做只读审查，发现两个收尾遗漏：自动重排路径缺少迷你 K 线重绘、缺少邻票同步。

可复用的教训：凡是「列表会被多处重建」的界面，收尾动作（重绘、邻票同步、选中态恢复）必须收敛到渲染函数内部，挂在某一触发路径上必然漏路径。审查时专门追问「还有哪些入口会重建这个列表」比逐条读 diff 更有效。

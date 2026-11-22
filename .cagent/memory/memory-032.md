---
id: memory-032
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-10-14T23:42:35+08:00
updated: 2026-10-14T23:42:35+08:00
importance: medium
category: 其他
keywords: [stock-picker, score-fallback, 综合分恒为1, engine.js, 布尔条件评分, 排序无区分度]
summary: stock-picker「综合分恒为1」的根因是 engine.js 在策略无 score 数组时回退到用 all 布尔条件打分，布尔筛选每项得分恒为 0/1，权重归一化后恒等于 1，导致该分毫无区分度。
---
stock-picker 的评分逻辑：src/engine.js 里 `const scores = (strategy.score || strategy.all).map(...)`。当策略没有定义 score 数组时，回退到 all 条件数组；all 里都是布尔筛选，其 score 在 expr 分支恒为 0/1（engine.js:130）。所以每只通过筛选的股票综合分都是 (1×w1+1×w2)/(w1+w2)=1。默认策略和 low-suck-v2.json 都没有 score 数组，因此综合分全为 1。结论：该分在当前策略下没有区分度，展示它多余；且后端 sort.by:'score' 排序在分数全相等时退化为原顺序，等于排序无效。若要让排序有效，需给策略补有连续刻度的 score 数组（如 momentum、close/ma-1、volume_ratio-1）。

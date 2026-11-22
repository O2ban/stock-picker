---
id: memory-868
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-11-22T12:54:57+08:00
updated: 2026-11-22T12:54:57+08:00
importance: medium
category: 代码逻辑
keywords: [rv.js, applyPlan, items映射, avgWin, avgLoss, 凯利公式, 盈亏比, 显示为—, stock-picker]
summary: 复盘页盈亏比/凯利公式/仓位显示为—的根因是rv.js的applyPlan里items映射漏了avgWin和avgLoss两个字段，前端拿不到数据自然渲染为占位符。
---
stock-picker复盘页的方案指标行中，盈亏比b、凯利f、仓位建议三项全部显示为"—"的根因：rv.js的applyPlan函数在构建items对象时漏掉了avgWin（平均盈利）和avgLoss（平均亏损）两个字段的映射，导致凯利公式计算函数拿不到输入数据。修复方式是在items映射里补上这两个字段。这类"显示为—"的排查思路：先检查数据映射层是否完整传递了计算所需的全部字段，再怀疑计算逻辑本身。

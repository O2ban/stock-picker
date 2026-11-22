---
id: memory-645
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-11-19T01:27:45+08:00
updated: 2026-11-19T01:27:45+08:00
importance: medium
category: 错误教训
keywords: [买点标记, bpSameDay, 日期为空, chart.js, 隔夜不画]
summary: 买点标记的 bpSameDay 判定在 bp.date 为空时恒为 true，会把隔夜买点画到今天曲线上，与「隔夜不画」的意图相反。
---
M3：chart.js 的 bpSameDay = !bp || !bp.date || !tl.date || normDate(bp.date) === normDate(tl.date)，bp.date 为空时恒为 true。app.js 的兜底链 p.baseDate || pickSelDate || runBaseDate 一般不会为空，属边界隐患。修法应改为日期缺失时不画或按明确规则处理。

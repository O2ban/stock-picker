---
id: memory-648
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-11-19T01:27:45+08:00
updated: 2026-11-19T01:27:45+08:00
importance: medium
category: 错误教训
keywords: [prevDayPct, asOf=null, 快照失败, 涨跌幅算错]
summary: 快照失败时 cut='' 使 before=rows 取全部6行（含当日），prevDayPct 变成「昨天 vs 今天现价」，算错前一日涨跌幅。
---
M6：intraday.js 中快照失败时 asOf=null，cut='' 时 before = rows（取全部6行，含当日），prevDayPct 变成「昨天 vs 今天现价」。prevDay.enabled 默认 false，属潜伏项。

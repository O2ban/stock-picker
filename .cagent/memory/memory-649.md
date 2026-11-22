---
id: memory-649
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-11-19T01:27:45+08:00
updated: 2026-11-19T01:27:45+08:00
importance: low
category: 错误教训
keywords: [出手数, total vs added, 文案误导, 累计条数]
summary: 前端把 mergePicks 返回的累计总数 total 说成「出手 X 只」，实际本次出手数应为 data.added。
---
M7：app.js 的「出手 ${data.total} 只」中 total 是清单累计总数（mergePicks 返回值），不是本次出手数，data.added 才是。属于文案口径误导。

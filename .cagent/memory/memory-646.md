---
id: memory-646
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-11-19T01:27:45+08:00
updated: 2026-11-19T01:27:45+08:00
importance: medium
category: 错误教训
keywords: [auto.nextAt, 后端未返回, 前端字段, 下次HH:MM]
summary: 前端读取的 auto.nextAt 后端从未返回，导致「下次 HH:MM」永远不显示；autoWatchStatus() 只返回 enabled/running/from/to/everyMin/lastBucket/lastResult。
---
M4：app.js 读 auto.nextAt，而 intraday-picks.js 的 autoWatchStatus() 只返回 enabled/running/from/to/everyMin/lastBucket/lastResult，nextAt 恒为 undefined。属于前后端契约不一致。

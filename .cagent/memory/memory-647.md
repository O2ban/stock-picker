---
id: memory-647
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-11-19T01:27:45+08:00
updated: 2026-11-19T01:27:45+08:00
importance: medium
category: 方法经验
keywords: [接口返回结构, 契约不一致, intraday-picks/run, readPicks, dates]
summary: 同一接口成功/失败两种返回结构不一致（失败平铺、成功嵌在 doc.picks），且 readPicks 的 doc 不含 dates，前端靠 || pickDates 兜住，属易碎的契约。
---
M5：/api/intraday-picks/run 失败分支返回 {ok:false, reason, count, results}（平铺数组），成功分支返回 {ok, date, added, total, doc}（清单在 doc.picks）；且 readPicks() 的 doc 不含 dates。前端目前能容错，但结构不统一易碎，新调用方容易踩。

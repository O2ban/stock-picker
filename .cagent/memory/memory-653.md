---
id: memory-653
scope: project
workspace: /home/ubuntu/stock-picker
created: 2026-11-19T01:27:45+08:00
updated: 2026-11-19T01:27:45+08:00
importance: low
category: 错误教训
keywords: [校验缺口, 布尔类型, 字符串false, shape.enabled]
summary: 策略参数校验有缺口：shape.enabled=false 时不校验 look/maxFlips，excludeLimitUp/entry.requireRising 等布尔不做类型校验，传字符串 "false" 会被当真值。
---
L5：intraday.js 中 shape.enabled=false 时不校验 look/maxFlips；excludeLimitUp、entry.requireRising、mid.requireAboveMid 等布尔不做类型校验，传字符串 "false" 会被当真值。JSON 配置由人写时易踩。
